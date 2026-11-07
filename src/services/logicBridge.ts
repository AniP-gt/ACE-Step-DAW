import { useProjectStore } from '../store/projectStore';
import { useModelStore } from '../store/modelStore';
import { useLogicBridgeStore } from '../store/logicBridgeStore';
import { useGenerationStore } from '../store/generationStore';
import { importAudioFile } from './audioImport';
import { ExplicitContextError, requireLegoModel, validateContextRange } from './explicitContextGeneration';
import { bridgeJson, canonicalBlob, numberField, objects, stringField, type BridgeObject } from './logicBridgeClient';
import { runBridgeJob } from './logicBridgeExecutor';
import { TRACK_NAMES } from '../constants/tracks';
import { get, set } from 'idb-keyval';
import { reconcileBridgeJob } from './logicBridgeReconciliation';
import { applyLogicReferenceTiming } from './logicBridgeTiming';

let stopExecutor: (() => void) | undefined;
let attachingCapture = false;

export function boundConnection(sessionId: string, projectId: string) {
  const state = useLogicBridgeStore.getState();
  if (!state.token || !state.connected || state.sessionId !== sessionId || state.projectId !== projectId || useProjectStore.getState().project?.id !== projectId) {
    throw new ExplicitContextError('STALE_BINDING: Pair this tab with the intended project.');
  }
  return { token: state.token, sessionId, projectId };
}

export async function refreshBridge(): Promise<void> {
  const state = useLogicBridgeStore.getState();
  if (!state.sessionId || !state.projectId) return;
  const { token, sessionId } = boundConnection(state.sessionId, state.projectId);
  const [captures, bindings] = await Promise.all([
    bridgeJson(token, `/captures?sessionId=${encodeURIComponent(sessionId)}`),
    bridgeJson(token, `/bindings?sessionId=${encodeURIComponent(sessionId)}`),
  ]);
  useLogicBridgeStore.setState({ captures: objects(captures, 'captures'), bindings: objects(bindings, 'bindings') });
}

export function disconnectBridge(): void {
  stopExecutor?.();
  stopExecutor = undefined;
  useLogicBridgeStore.setState({ connected: false, token: null, verifiedModelId: null, executorId: null });
}

export async function connectBridge(code: string): Promise<void> {
  disconnectBridge();
  const project = useProjectStore.getState().project;
  if (!project) throw new ExplicitContextError('Open an empty bridge project first.');
  const credential = await bridgeJson('', '/pairings/claim', { code });
  if (credential.role !== 'executor' || credential.projectId !== project.id) throw new ExplicitContextError('Pairing code belongs to another role or project.');
  const token = stringField(credential, 'token');
  const sessionId = stringField(credential, 'sessionId');
  const model = useModelStore.getState().availableModels.find(item => item.is_loaded && item.supported_task_types?.includes('lego') && !/turbo/i.test(item.name));
  const modelId = model?.name ?? '';
  const verified = modelId.length > 0 && import.meta.env.VITE_LOGIC_BRIDGE_VERIFIED_MODEL === modelId;
  const executorId = crypto.randomUUID();
  await bridgeJson(token, '/executor/register', { sessionId, projectId: project.id, executorId, modelId, instruments: verified ? TRACK_NAMES : [], outputSemantics: verified ? 'isolated-layer' : 'unverified' });
  useLogicBridgeStore.setState({ token, sessionId, projectId: project.id, executorId, connected: true, error: null, verifiedModelId: verified ? modelId : null });
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  stopExecutor = () => { active = false; controller.abort(); clearTimeout(timer); };
  const poll = async () => {
    try {
      boundConnection(sessionId, project.id);
      const response = await bridgeJson(token, `/executor/jobs?sessionId=${encodeURIComponent(sessionId)}`);
      const jobs = objects(response, 'jobs');
      const heldJobId = useGenerationStore.getState().backendOccupancyJobId;
      if (heldJobId && !jobs.some(job => job.jobId === heldJobId)) {
        await reconcileBridgeJob(await bridgeJson(token, `/jobs/${encodeURIComponent(heldJobId)}`), token);
      }
      useLogicBridgeStore.setState(state => ({ jobs: [...state.jobs.filter(previous => !jobs.some(job => job.jobId === previous.jobId)), ...jobs] }));
      for (const job of jobs) {
        if (active && ['canceled', 'interrupted', 'failed'].includes(String(job.state))) await reconcileBridgeJob(job, token);
        if (active && job.state === 'queued') await runBridgeJob(job, controller.signal);
      }
      await refreshBridge();
    } catch (error) {
      useLogicBridgeStore.setState({ error: error instanceof Error ? error.message : 'Bridge connection failed' });
      if (useProjectStore.getState().project?.id !== project.id) disconnectBridge();
    } finally {
      if (active) timer = setTimeout(() => void poll(), 1500);
    }
  };
  void poll();
}

export async function attachLogicCapture(request: BridgeObject): Promise<BridgeObject> {
  if (attachingCapture) throw new ExplicitContextError('PROJECT_BUSY: A reference import is in progress.');
  attachingCapture = true;
  try { return await attachCapture(request); }
  finally { attachingCapture = false; }
}

async function attachCapture(request: BridgeObject): Promise<BridgeObject> {
  const { token, sessionId, projectId } = boundConnection(stringField(request, 'sessionId'), stringField(request, 'projectId'));
  const captureId = stringField(request, 'captureId');
  const clientRequestId = stringField(request, 'clientRequestId');
  await refreshBridge();
  const state = useLogicBridgeStore.getState();
  const previous = state.bindings.find(item => item.captureId === captureId && item.projectId === projectId);
  if (previous) {
    if (!useProjectStore.getState().getClipById(stringField(previous, 'clipId'))) throw new ExplicitContextError('STALE_BINDING: Reference clip was removed.');
    const source = state.captures.find(item => item.captureId === captureId);
    if (!source) throw new ExplicitContextError('CAPTURE_NOT_READY');
    applyLogicReferenceTiming(source, projectId);
    useLogicBridgeStore.setState({ selectedCaptureId: captureId });
    return previous;
  }
  const capture = state.captures.find(item => item.captureId === captureId && item.state === 'ready');
  if (!capture) throw new ExplicitContextError('CAPTURE_NOT_READY');
  const receiptKey = `logic-bridge:attach:${sessionId}:${projectId}:${captureId}`;
  const receipt = await get<unknown>(receiptKey);
  if (typeof receipt === 'string' && useProjectStore.getState().getClipById(receipt)) {
    applyLogicReferenceTiming(capture, projectId);
    const binding = await bridgeJson(token, '/bindings', { sessionId, projectId, captureId, clientRequestId, clipId: receipt });
    useLogicBridgeStore.setState({ selectedCaptureId: captureId });
    await refreshBridge();
    return binding;
  }
  const project = useProjectStore.getState().project;
  if (!project || (project.tracks.some(track => track.clips.length > 0) && !state.bindings.some(item => item.projectId === projectId))) throw new ExplicitContextError('Use an empty bridge project for the first reference.');
  const blob = await canonicalBlob(token, capture);
  boundConnection(sessionId, projectId);
  applyLogicReferenceTiming(capture, projectId);
  const duration = numberField(capture, 'canonicalFrameCount') / 48000;
  const timedProject = useProjectStore.getState().project;
  if (timedProject && timedProject.totalDuration < duration) {
    const secondsPerMeasure = 60 / timedProject.bpm * timedProject.timeSignature * 4 / (timedProject.timeSignatureDenominator ?? 4);
    useProjectStore.getState().updateProject({ measures: Math.ceil(duration / secondsPerMeasure) });
  }
  const imported = await importAudioFile(new File([blob], `${stringField(capture, 'label') || 'Logic reference'}.wav`, { type: 'audio/wav' }), 0, { preserveSource: true });
  await set(receiptKey, imported.clipId);
  boundConnection(sessionId, projectId);
  const binding = await bridgeJson(token, '/bindings', { sessionId, projectId, captureId, clientRequestId, clipId: imported.clipId });
  useLogicBridgeStore.setState({ selectedCaptureId: captureId });
  await refreshBridge();
  return binding;
}

export async function addLayerFromLogicContext(request: BridgeObject): Promise<BridgeObject> {
  const { token } = boundConnection(stringField(request, 'sessionId'), stringField(request, 'projectId'));
  if (useGenerationStore.getState().isGenerating || useGenerationStore.getState().backendOccupancyJobId) throw new ExplicitContextError('PROJECT_BUSY');
  requireLegoModel(useModelStore.getState().availableModels, stringField(request, 'modelId'));
  const state = useLogicBridgeStore.getState();
  if (state.verifiedModelId !== request.modelId) throw new ExplicitContextError('UNSUPPORTED_OUTPUT_SEMANTICS: Compatible layer model not verified.');
  const binding = state.bindings.find(item => item.bindingId === request.bindingId && item.captureId === request.captureId);
  if (!binding || !useProjectStore.getState().getClipById(stringField(binding, 'clipId'))) throw new ExplicitContextError('STALE_BINDING');
  const capture = state.captures.find(item => item.captureId === request.captureId);
  if (!capture) throw new ExplicitContextError('CAPTURE_NOT_READY');
  validateContextRange(numberField(capture, 'canonicalFrameCount'), numberField(request, 'startFrame'), numberField(request, 'endFrame'));
  return bridgeJson(token, '/jobs', request);
}
