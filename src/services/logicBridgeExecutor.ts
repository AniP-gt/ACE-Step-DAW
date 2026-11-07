import { useProjectStore } from '../store/projectStore';
import { useGenerationStore } from '../store/generationStore';
import { useLogicBridgeStore } from '../store/logicBridgeStore';
import { useModelStore } from '../store/modelStore';
import { TRACK_NAMES } from '../constants/tracks';
import { generateFromExplicitContext } from './generationPipeline';
import { loadAudioBlobByKey } from './audioFileManager';
import { ExplicitContextError, requireLegoModel } from './explicitContextGeneration';
import { boundConnection } from './logicBridge';
import { reconcileBridgeJob } from './logicBridgeReconciliation';
import { readLogicSourceTiming } from './logicBridgeTiming';
import { bridgeJson, bridgeRequest, canonicalBlob, numberField, object, objects, stringField, type BridgeObject } from './logicBridgeClient';

export async function runBridgeJob(job: BridgeObject, disconnectSignal: AbortSignal): Promise<void> {
  const projectId = stringField(job, 'projectId');
  const { token } = boundConnection(stringField(job, 'sessionId'), projectId);
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
      const current = objects(response, 'jobs').find(item => item.jobId === jobId);
      if (current?.state === 'canceled') controller.abort();
    }).catch((error: unknown) => {
      controller.abort();
      useLogicBridgeStore.setState({ error: error instanceof Error ? error.message : 'Job status unavailable' });
    }).finally(() => { polling = false; });
  }, 750);
  const removeCanceledClip = () => {
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
    if (!binding || !useProjectStore.getState().getClipById(stringField(binding, 'clipId'))) throw new ExplicitContextError('STALE_BINDING');
    const capture = state.captures.find(item => item.captureId === job.captureId && item.canonicalSha256 === job.canonicalSha256);
    if (!capture) throw new ExplicitContextError('CAPTURE_NOT_READY');
    const blob = await canonicalBlob(token, capture);
    await bridgeJson(token, `${path}/transition`, { state: 'dispatched' });
    boundConnection(stringField(job, 'sessionId'), projectId);
    controller.signal.throwIfAborted();
    if (useGenerationStore.getState().isGenerating) throw new ExplicitContextError('PROJECT_BUSY');
    const store = useProjectStore.getState();
    const track = store.addTrack(instrument, 'stems');
    trackId = track.id;
    const startFrame = numberField(job, 'startFrame');
    const endFrame = numberField(job, 'endFrame');
    const clip = store.addClip(track.id, { startTime: startFrame / 48000, duration: (endFrame - startFrame) / 48000, prompt: stringField(job, 'prompt'), lyrics: '' });
    clipId = clip.id;
    submissionStarted = true;
    const result = await generateFromExplicitContext({
      bridgeJobId: jobId,
      sourceTiming: readLogicSourceTiming(capture),
      projectId, clipId, canonicalBlob: blob,
      frameCount: numberField(capture, 'canonicalFrameCount'), startFrame, endFrame, modelId,
      seed: numberField(job, 'seed'), signal: controller.signal,
      onSubmitted: async backendTaskId => {
        submittedTaskId = backendTaskId;
        const receipt = await bridgeJson(token, `${path}/submission`, { backendTaskId });
        submissionAcknowledged = true;
        if (receipt.state === 'canceled' || receipt.state === 'interrupted') controller.abort();
      },
    });
    controller.signal.throwIfAborted();
    boundConnection(stringField(job, 'sessionId'), projectId);
    if (!result.succeeded) throw new ExplicitContextError(result.errorMessage ?? 'GENERATION_FAILED');
    const readyClip = useProjectStore.getState().getClipById(clipId);
    if (!readyClip?.isolatedAudioKey || readyClip.generationStatus !== 'ready') throw new ExplicitContextError('STALE_BINDING');
    const output = await loadAudioBlobByKey(readyClip.isolatedAudioKey);
    if (!output) throw new ExplicitContextError('RESULT_MISSING');
    await bridgeJson(token, `${path}/transition`, { state: 'exporting' });
    controller.signal.throwIfAborted();
    const response = await bridgeRequest(token, `${path}/result`, output);
    const completed = object(await response.json());
    if (useGenerationStore.getState().backendOccupancyJobId === jobId) useGenerationStore.setState({ backendOccupancyJobId: null });
    useLogicBridgeStore.setState(state => ({ jobs: [...state.jobs.filter(item => item.jobId !== jobId), completed] }));
    if (useProjectStore.getState().project?.id === projectId && useProjectStore.getState().getClipById(clipId)) useProjectStore.getState().saveClipVersion(clipId);
  } catch (error) {
    removeCanceledClip();
    const message = error instanceof Error ? error.message : 'GENERATION_FAILED';
    useLogicBridgeStore.setState({ error: message });
    let current = await bridgeJson(token, path);
    if (submittedTaskId && !current.backendTaskId && current.backendOccupancy !== 'released') {
      current = await bridgeJson(token, `${path}/submission`, { backendTaskId: submittedTaskId });
      submissionAcknowledged = true;
    }
    if (current.state !== 'canceled' && current.state !== 'ready') {
      const uncertain = submissionStarted && !submissionAcknowledged;
      current = await bridgeJson(token, `${path}/transition`, { state: uncertain ? 'interrupted' : 'failed', error: uncertain ? `SUBMISSION_OUTCOME_UNKNOWN: ${message}` : message });
    }
    if (submissionStarted) await reconcileBridgeJob(current, token);
  } finally {
    clearInterval(cancellationTimer);
    disconnectSignal.removeEventListener('abort', disconnect);
    controller.signal.removeEventListener('abort', removeCanceledClip);
  }
}
