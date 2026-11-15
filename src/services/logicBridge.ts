import { flushProjectReferencePersistence, useProjectStore } from '../store/projectStore';
import { useModelStore } from '../store/modelStore';
import { useLogicBridgeStore } from '../store/logicBridgeStore';
import { useGenerationStore } from '../store/generationStore';
import { importAudioFile } from './audioImport';
import { ExplicitContextError, requireLegoModel, validateContextRange } from './explicitContextGeneration';
import { bridgeJson, canonicalBlob, numberField, objects, stringField, type BridgeObject } from './logicBridgeClient';
import { runBridgeJob } from './logicBridgeExecutor';
import { TRACK_NAMES } from '../constants/tracks';
import { del, get, set } from 'idb-keyval';
import { reconcileBridgeJob } from './logicBridgeReconciliation';
import { applyLogicReferenceTiming } from './logicBridgeTiming';
import { processNativeRequests } from './logicBridgeNativeRequests';

let connectionEpoch = 0;
let stopExecutor: (() => void) | undefined;
let attachingCapture = false;
const referenceImports = new Map<string, { track: NonNullable<ReturnType<typeof useProjectStore.getState>['project']>['tracks'][number]; completed: boolean }>();

function referenceTrackSnapshot(track: NonNullable<ReturnType<typeof useProjectStore.getState>['project']>['tracks'][number]): string {
  return JSON.stringify({ ...track, clips: track.clips.map(clip => ({ ...clip, waveformPeaks: null, versions: clip.versions?.map(version => ({ ...version, waveformPeaks: null })), takes: clip.takes?.map(take => ({ ...take, waveformPeaks: null })) })) });
}

function referenceInventory(project: NonNullable<ReturnType<typeof useProjectStore.getState>['project']>): string {
  return JSON.stringify(project.tracks.map(track => [track.id, ...track.clips.map(clip => clip.id).sort()]).sort((a, b) => a[0].localeCompare(b[0])));
}

export function boundConnection(sessionId: string, projectId: string) {
  const state = useLogicBridgeStore.getState();
  if (!state.token || !state.connected || state.sessionId !== sessionId || state.projectId !== projectId || useProjectStore.getState().project?.id !== projectId) {
    throw new ExplicitContextError('STALE_BINDING: Pair this tab with the intended project.');
  }
  return { token: state.token, sessionId, projectId };
}

export function connectionGuard(sessionId: string, projectId: string): () => void {
  const epoch = connectionEpoch;
  const initial = boundConnection(sessionId, projectId);
  const executorId = useLogicBridgeStore.getState().executorId;
  return () => {
    const current = boundConnection(sessionId, projectId);
    if (connectionEpoch !== epoch || current.token !== initial.token || useLogicBridgeStore.getState().executorId !== executorId) throw new ExplicitContextError('STALE_BINDING');
  };
}

export async function refreshBridge(): Promise<void> {
  const state = useLogicBridgeStore.getState();
  if (!state.sessionId || !state.projectId) return;
  const { token, sessionId } = boundConnection(state.sessionId, state.projectId);
  const guard = connectionGuard(state.sessionId, state.projectId);
  const [captures, bindings] = await Promise.all([
    bridgeJson(token, `/captures?sessionId=${encodeURIComponent(sessionId)}`),
    bridgeJson(token, `/bindings?sessionId=${encodeURIComponent(sessionId)}`),
  ]);
  guard();
  useLogicBridgeStore.setState({ captures: objects(captures, 'captures'), bindings: objects(bindings, 'bindings') });
}

export function disconnectBridge(): void {
  connectionEpoch++;
  stopExecutor?.();
  stopExecutor = undefined;
  useLogicBridgeStore.setState({ connected: false, token: null, verifiedModelId: null, executorId: null });
}

export async function connectBridge(code: string): Promise<void> {
  disconnectBridge();
  const project = useProjectStore.getState().project;
  if (!project) throw new ExplicitContextError('Open an empty bridge project first.');
  const epoch = connectionEpoch;
  const checkPending = () => { if (connectionEpoch !== epoch || useProjectStore.getState().project?.id !== project.id) throw new ExplicitContextError('STALE_BINDING'); };
  const credential = await bridgeJson('', '/pairings/claim', { code });
  checkPending();
  if (credential.role !== 'executor' || credential.projectId !== project.id) throw new ExplicitContextError('Pairing code belongs to another role or project.');
  const token = stringField(credential, 'token');
  const sessionId = stringField(credential, 'sessionId');
  const model = useModelStore.getState().availableModels.find(item => item.is_loaded && item.supported_task_types?.includes('lego') && !/turbo/i.test(item.name));
  const modelId = model?.name ?? '';
  const verified = modelId.length > 0 && import.meta.env.VITE_LOGIC_BRIDGE_VERIFIED_MODEL === modelId;
  const executorId = crypto.randomUUID();
  await bridgeJson(token, '/executor/register', { sessionId, projectId: project.id, executorId, modelId, instruments: verified ? TRACK_NAMES : [], outputSemantics: verified ? 'isolated-layer' : 'unverified' });
  checkPending();
  useLogicBridgeStore.setState({ token, sessionId, projectId: project.id, executorId, connected: true, error: null, verifiedModelId: verified ? modelId : null });
  const guard = connectionGuard(sessionId, project.id);
  let registered = JSON.stringify([modelId, verified]);
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  stopExecutor = () => { active = false; controller.abort(); clearTimeout(timer); };
  const poll = async () => {
    try {
      guard();
      const currentModel = useModelStore.getState().availableModels.find(item => item.is_loaded && item.supported_task_types?.includes('lego') && !/turbo/i.test(item.name));
      const nextModelId = currentModel?.name ?? '';
      const nextVerified = !!nextModelId && import.meta.env.VITE_LOGIC_BRIDGE_VERIFIED_MODEL === nextModelId;
      const nextRegistration = JSON.stringify([nextModelId, nextVerified]);
      if (nextRegistration !== registered) {
        await bridgeJson(token, '/executor/register', { sessionId, projectId: project.id, executorId, modelId: nextModelId, instruments: nextVerified ? TRACK_NAMES : [], outputSemantics: nextVerified ? 'isolated-layer' : 'unverified' });
        guard();
        registered = nextRegistration;
        useLogicBridgeStore.setState({ verifiedModelId: nextVerified ? nextModelId : null });
      }
      await refreshBridge();
      guard();
      let nativeFailure: { error: unknown } | undefined;
      try {
        await processNativeRequests({ token, sessionId, projectId: project.id, guard });
        guard();
      } catch (error) {
        guard();
        nativeFailure = { error };
      }
      guard();
      const response = await bridgeJson(token, `/executor/jobs?sessionId=${encodeURIComponent(sessionId)}`);
      guard();
      const jobs = objects(response, 'jobs');
      const heldJobId = useGenerationStore.getState().backendOccupancyJobId;
      if (heldJobId && !jobs.some(job => job.jobId === heldJobId)) {
        const held = await bridgeJson(token, `/jobs/${encodeURIComponent(heldJobId)}`);
        guard();
        await reconcileBridgeJob(held, token, guard);
        guard();
      }
      guard();
      useLogicBridgeStore.setState(state => ({ jobs: [...state.jobs.filter(previous => !jobs.some(job => job.jobId === previous.jobId)), ...jobs] }));
      for (const job of jobs) {
        if (active && ['canceled', 'interrupted', 'failed'].includes(String(job.state))) await reconcileBridgeJob(job, token, guard);
        guard();
        if (active && job.state === 'queued') await runBridgeJob(job, controller.signal);
      }
      guard();
      if (nativeFailure) throw nativeFailure.error;
      await refreshBridge();
      guard();
    } catch (error) {
      try { guard(); } catch { return; }
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
  const guard = connectionGuard(sessionId, projectId);
  const captureId = stringField(request, 'captureId');
  const clientRequestId = stringField(request, 'clientRequestId');
  await refreshBridge();
  guard();
  const state = useLogicBridgeStore.getState();
  const previous = state.bindings.find(item => item.captureId === captureId && item.projectId === projectId);
  if (previous) {
    if (!useProjectStore.getState().getClipById(stringField(previous, 'clipId'))) throw new ExplicitContextError('STALE_BINDING: Reference clip was removed.');
    const source = state.captures.find(item => item.captureId === captureId);
    if (!source) throw new ExplicitContextError('CAPTURE_NOT_READY');
    applyLogicReferenceTiming(source, projectId);
    await flushProjectReferencePersistence(projectId);
    guard();
    useLogicBridgeStore.setState({ selectedCaptureId: captureId });
    return previous;
  }
  const capture = state.captures.find(item => item.captureId === captureId && item.state === 'ready');
  if (!capture) throw new ExplicitContextError('CAPTURE_NOT_READY');
  const receiptKey = `logic-bridge:attach:${sessionId}:${projectId}:${captureId}`;
  const journalKey = `logic-bridge:attach-operation:${sessionId}:${projectId}:${captureId}`;
  const receipt = await get<unknown>(receiptKey);
  guard();
  const journal = typeof receipt === 'string' ? undefined : await get<{ started: true; inventory: string } | { track: NonNullable<ReturnType<typeof useProjectStore.getState>['project']>['tracks'][number]; completed: boolean }>(journalKey);
  guard();
  const inMemory = referenceImports.get(receiptKey);
  if (!inMemory && journal && 'started' in journal) {
    const current = useProjectStore.getState().project;
    if (!current || current.id !== projectId || referenceInventory(current) !== journal.inventory) throw new ExplicitContextError('Reference import was interrupted before ownership was recorded. Inspect the project and remove the incomplete reference and its empty track, or use a different project.');
    await del(journalKey);
    guard();
  }
  const owned = inMemory ?? (journal && 'track' in journal ? journal : undefined);
  guard();
  const currentTrack = owned && useProjectStore.getState().project?.tracks.find(track => track.id === owned.track.id);
  if (owned && !currentTrack && !owned.completed && !owned.track.clips.some(clip => useProjectStore.getState().getClipById(clip.id))) {
    referenceImports.delete(receiptKey);
    await del(journalKey);
    guard();
  } else if (owned && (!currentTrack || referenceTrackSnapshot(currentTrack) !== referenceTrackSnapshot(owned.track))) {
    throw new ExplicitContextError('Reference import was changed; resolve it before retrying.');
  }
  if (owned && !owned.completed) {
    if (currentTrack) useProjectStore.getState().removeTrack(owned.track.id);
    referenceImports.delete(receiptKey);
    await del(journalKey);
    guard();
  }
  const savedClipId = typeof receipt === 'string' ? receipt : owned?.completed ? owned.track.clips[0]?.id : undefined;
  if (savedClipId && useProjectStore.getState().getClipById(savedClipId)) {
    applyLogicReferenceTiming(capture, projectId);
    await flushProjectReferencePersistence(projectId);
    guard();
    await set(receiptKey, savedClipId);
    guard();
    referenceImports.delete(receiptKey);
    await del(journalKey);
    guard();
    const binding = await bridgeJson(token, '/bindings', { sessionId, projectId, captureId, clientRequestId, clipId: savedClipId });
    guard();
    useLogicBridgeStore.setState({ selectedCaptureId: captureId });
    await refreshBridge();
    guard();
    return binding;
  }
  const project = useProjectStore.getState().project;
  if (!project || (project.tracks.some(track => track.clips.length > 0) && !state.bindings.some(item => item.projectId === projectId))) throw new ExplicitContextError('Use an empty bridge project for the first reference.');
  const blob = await canonicalBlob(token, capture);
  guard();
  applyLogicReferenceTiming(capture, projectId);
  const duration = numberField(capture, 'canonicalFrameCount') / 48000;
  const timedProject = useProjectStore.getState().project;
  if (timedProject && timedProject.totalDuration < duration) {
    const secondsPerMeasure = 60 / timedProject.bpm * timedProject.timeSignature * 4 / (timedProject.timeSignatureDenominator ?? 4);
    useProjectStore.getState().updateProject({ measures: Math.ceil(duration / secondsPerMeasure) });
  }
  const beforeImport = useProjectStore.getState().project;
  if (!beforeImport || beforeImport.id !== projectId) throw new ExplicitContextError('STALE_BINDING');
  await set(journalKey, { started: true, inventory: referenceInventory(beforeImport) });
  guard();
  const imported = await importAudioFile(new File([blob], `${stringField(capture, 'label') || 'Logic reference'}.wav`, { type: 'audio/wav' }), 0, { preserveSource: true, guard, onCreated: async ({ trackId }) => {
    guard();
    const track = useProjectStore.getState().project?.tracks.find(item => item.id === trackId);
    if (!track) throw new ExplicitContextError('Reference track was removed.');
    const operation = { track, completed: false };
    referenceImports.set(receiptKey, operation);
    await set(journalKey, operation);
    guard();
  } });
  guard();
  const importedTrack = useProjectStore.getState().project?.tracks.find(track => track.id === imported.trackId);
  if (!importedTrack) throw new ExplicitContextError('Reference track was removed.');
  referenceImports.set(receiptKey, { track: importedTrack, completed: false });
  await set(journalKey, { track: importedTrack, completed: false });
  guard();
  await flushProjectReferencePersistence(projectId);
  guard();
  referenceImports.set(receiptKey, { track: importedTrack, completed: true });
  await set(journalKey, { track: importedTrack, completed: true });
  guard();
  await set(receiptKey, imported.clipId);
  guard();
  referenceImports.delete(receiptKey);
  await del(journalKey);
  guard();
  const binding = await bridgeJson(token, '/bindings', { sessionId, projectId, captureId, clientRequestId, clipId: imported.clipId });
  guard();
  useLogicBridgeStore.setState({ selectedCaptureId: captureId });
  await refreshBridge();
  guard();
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
