import { useProjectStore } from '../store/projectStore';
import { useGenerationStore } from '../store/generationStore';
import { useLogicBridgeStore } from '../store/logicBridgeStore';
import { useModelStore } from '../store/modelStore';
import { TRACK_NAMES } from '../constants/tracks';
import { generateFromExplicitContext } from './generationPipeline';
import { loadAudioBlobByKey } from './audioFileManager';
import { ExplicitContextError, requireLegoModel } from './explicitContextGeneration';
import { boundConnection, connectionGuard } from './logicBridge';
import { reconcileBridgeJob } from './logicBridgeReconciliation';
import { readLogicSourceTiming } from './logicBridgeTiming';
import { validReference } from './logicBridgeNativeRequests';
import { bridgeJson, bridgeRequest, canonicalBlob, numberField, object, objects, stringField, type BridgeObject } from './logicBridgeClient';

export async function runBridgeJob(job: BridgeObject, disconnectSignal: AbortSignal): Promise<void> {
  const projectId = stringField(job, 'projectId');
  const { token } = boundConnection(stringField(job, 'sessionId'), projectId);
  const guard = connectionGuard(stringField(job, 'sessionId'), projectId);
  const jobId = stringField(job, 'jobId');
  const path = `/jobs/${encodeURIComponent(jobId)}`;
  const controller = new AbortController();
  const disconnect = () => controller.abort();
  disconnectSignal.addEventListener('abort', disconnect, { once: true });
  let clipId: string | undefined;
  let trackId: string | undefined;
  let submissionAcknowledged = false;
  let submittedTaskId: string | undefined;
  let submissionStarted = false;
  let polling = false;
  const cancellationTimer = setInterval(() => {
    if (polling) return;
    polling = true;
    void bridgeJson(token, `/executor/jobs?sessionId=${encodeURIComponent(stringField(job, 'sessionId'))}`).then(response => {
      guard();
      const current = objects(response, 'jobs').find(item => item.jobId === jobId);
      if (current?.state === 'canceled') controller.abort();
    }).catch((error: unknown) => {
      controller.abort();
      if (disconnectSignal.aborted) return;
      try { guard(); } catch { return; }
      useLogicBridgeStore.setState({ error: error instanceof Error ? error.message : 'Job status unavailable' });
    }).finally(() => { polling = false; });
  }, 750);
  const removeCanceledClip = () => {
    try { guard(); } catch { return; }
    const store = useProjectStore.getState();
    if (store.project?.id !== projectId) return;
    if (clipId) store.removeClip(clipId);
    const track = useProjectStore.getState().project?.tracks.find(item => item.id === trackId);
    if (track && track.clips.length === 0) store.removeTrack(track.id);
  };
  controller.signal.addEventListener('abort', removeCanceledClip, { once: true });
  try {
    if (disconnectSignal.aborted) controller.abort();
    controller.signal.throwIfAborted();
    if (useGenerationStore.getState().isGenerating) throw new ExplicitContextError('PROJECT_BUSY');
    const modelId = requireLegoModel(useModelStore.getState().availableModels, stringField(job, 'modelId'));
    const instrument = TRACK_NAMES.find(name => name === job.instrument);
    if (!instrument) throw new ExplicitContextError('UNSUPPORTED_INSTRUMENT');
    const state = useLogicBridgeStore.getState();
    const binding = state.bindings.find(item => item.bindingId === job.bindingId && item.captureId === job.captureId);
    const capture = state.captures.find(item => item.captureId === job.captureId && item.canonicalSha256 === job.canonicalSha256);
    const validateNativeSource = async () => {
      if (typeof job.nativePreparedRequestId !== 'string') return;
      const frameCount = capture?.canonicalFrameCount;
      const valid = typeof frameCount === 'number' && job.startFrame === 0 && job.endFrame === frameCount && capture?.canonicalSha256 === job.canonicalSha256 && await validReference(job, guard);
      guard();
      if (!valid) {
        await bridgeJson(token, `/native-requests/${encodeURIComponent(job.nativePreparedRequestId)}/invalidate`, { sessionId: stringField(job, 'sessionId'), error: 'STALE_BINDING' });
        guard();
        throw new ExplicitContextError('STALE_BINDING');
      }
    };
    if (typeof job.nativePreparedRequestId === 'string' && (!binding || !capture)) await validateNativeSource();
    if (!binding || !useProjectStore.getState().getClipById(stringField(binding, 'clipId'))) {
      if (typeof job.nativePreparedRequestId === 'string') await validateNativeSource();
      throw new ExplicitContextError('STALE_BINDING');
    }
    if (!capture) throw new ExplicitContextError('CAPTURE_NOT_READY');
    const blob = await canonicalBlob(token, capture);
    guard();
    await validateNativeSource();
    guard();
    await bridgeJson(token, `${path}/transition`, { state: 'dispatched' });
    guard();
    boundConnection(stringField(job, 'sessionId'), projectId);
    controller.signal.throwIfAborted();
    if (useGenerationStore.getState().isGenerating) throw new ExplicitContextError('PROJECT_BUSY');
    await validateNativeSource();
    guard();
    controller.signal.throwIfAborted();
    requireLegoModel(useModelStore.getState().availableModels, modelId);
    const store = useProjectStore.getState();
    const track = store.addTrack(instrument, 'stems');
    trackId = track.id;
    const startFrame = numberField(job, 'startFrame');
    const endFrame = numberField(job, 'endFrame');
    const clip = store.addClip(track.id, { startTime: startFrame / 48000, duration: (endFrame - startFrame) / 48000, prompt: stringField(job, 'prompt'), lyrics: '' });
    clipId = clip.id;
    const result = await generateFromExplicitContext({
      onSubmissionStarted: () => { submissionStarted = true; },
      bridgeJobId: jobId,
      sourceTiming: readLogicSourceTiming(capture),
      projectId, clipId, canonicalBlob: blob,
      frameCount: numberField(capture, 'canonicalFrameCount'), startFrame, endFrame, modelId,
      seed: numberField(job, 'seed'), signal: controller.signal,
      onSubmitted: async backendTaskId => {
        submittedTaskId = backendTaskId;
        guard();
        const receipt = await bridgeJson(token, `${path}/submission`, { backendTaskId });
        guard();
        submissionAcknowledged = true;
        if (receipt.state === 'canceled' || receipt.state === 'interrupted') controller.abort();
      },
    });
    controller.signal.throwIfAborted();
    guard();
    boundConnection(stringField(job, 'sessionId'), projectId);
    if (!result.succeeded) throw new ExplicitContextError(result.errorMessage ?? 'GENERATION_FAILED');
    const readyClip = useProjectStore.getState().getClipById(clipId);
    if (!readyClip?.isolatedAudioKey || readyClip.generationStatus !== 'ready') throw new ExplicitContextError('STALE_BINDING');
    const output = await loadAudioBlobByKey(readyClip.isolatedAudioKey);
    guard();
    if (!output) throw new ExplicitContextError('RESULT_MISSING');
    await bridgeJson(token, `${path}/transition`, { state: 'exporting' });
    guard();
    controller.signal.throwIfAborted();
    const response = await bridgeRequest(token, `${path}/result`, output);
    guard();
    const completed = object(await response.json());
    guard();
    if (useGenerationStore.getState().backendOccupancyJobId === jobId) useGenerationStore.setState({ backendOccupancyJobId: null });
    useLogicBridgeStore.setState(state => ({ jobs: [...state.jobs.filter(item => item.jobId !== jobId), completed] }));
    if (useProjectStore.getState().project?.id === projectId && useProjectStore.getState().getClipById(clipId)) useProjectStore.getState().saveClipVersion(clipId);
  } catch (error) {
    try { guard(); } catch { return; }
    removeCanceledClip();
    const message = error instanceof Error ? error.message : 'GENERATION_FAILED';
    useLogicBridgeStore.setState({ error: message });
    let current = await bridgeJson(token, path);
    guard();
    if (submittedTaskId && !current.backendTaskId && current.backendOccupancy !== 'released') {
      current = await bridgeJson(token, `${path}/submission`, { backendTaskId: submittedTaskId });
      guard();
      submissionAcknowledged = true;
    }
    if (current.state !== 'canceled' && current.state !== 'ready') {
      const uncertain = submissionStarted && !submissionAcknowledged;
      current = await bridgeJson(token, `${path}/transition`, { state: uncertain ? 'interrupted' : 'failed', error: uncertain ? `SUBMISSION_OUTCOME_UNKNOWN: ${message}` : message });
    }
    guard();
    if (!submissionStarted && !submittedTaskId && current.backendOccupancy !== 'released') {
      current = await bridgeJson(token, `${path}/reconcile`, { submissionNotStarted: true });
    }
    guard();
    await reconcileBridgeJob(current, token, guard);
  } finally {
    clearInterval(cancellationTimer);
    disconnectSignal.removeEventListener('abort', disconnect);
    controller.signal.removeEventListener('abort', removeCanceledClip);
  }
}
