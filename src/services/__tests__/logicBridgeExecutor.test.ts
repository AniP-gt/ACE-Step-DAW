import { Blob as NodeBlob } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '../../store/projectStore';
import { useGenerationStore } from '../../store/generationStore';
import { useModelStore } from '../../store/modelStore';
import { useLogicBridgeStore } from '../../store/logicBridgeStore';
import { generateFromExplicitContext } from '../generationPipeline';
import { runBridgeJob } from '../logicBridgeExecutor';
import { reconcileBridgeJob } from '../logicBridgeReconciliation';

vi.mock('../projectStorage', () => ({ saveProject: vi.fn() }));
vi.mock('../generationPipeline', () => ({ generateFromExplicitContext: vi.fn() }));
vi.mock('../audioImport', () => ({ importAudioFile: vi.fn() }));

describe('Logic executor cancellation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    useProjectStore.getState().createProject();
    useGenerationStore.setState({ isGenerating: false, backendOccupancyJobId: null });
    useModelStore.setState({ availableModels: [{ name: 'base', is_loaded: true, is_default: false, supported_task_types: ['lego'] }] });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('reports an unacknowledged submission as interrupted and holds backend occupancy', async () => {
    const project = useProjectStore.getState().project;
    if (!project) throw new Error('Missing project fixture');
    const reference = useProjectStore.getState().addTrack('keyboard', 'sample');
    const clip = useProjectStore.getState().addClip(reference.id, { startTime: 0, duration: 1, prompt: '', lyrics: '' });
    const bytes = new TextEncoder().encode('canonical-source');
    const digest = await webcrypto.subtle.digest('SHA-256', bytes);
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const job = { jobId: 'unknown-job', sessionId: 'session', projectId: project.id, captureId: 'capture', bindingId: 'binding', canonicalSha256: hash, modelId: 'base', instrument: 'bass', startFrame: 0, endFrame: 48000, seed: 0, prompt: 'Bass', state: 'queued' };
    useLogicBridgeStore.setState({ ...useLogicBridgeStore.getInitialState(), connected: true, token: 'fixture', sessionId: 'session', projectId: project.id, executorId: 'executor', captures: [{ captureId: 'capture', canonicalAssetId: 'asset', canonicalSha256: hash, canonicalFrameCount: 48000, tempo: 120, timeSignature: [4, 4] }], bindings: [{ bindingId: 'binding', captureId: 'capture', clipId: clip.id }] });
    const transitions: unknown[] = [];
    const uploads: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.includes('/assets/')) return new Response(bytes);
      if (url.endsWith('/result')) uploads.push(url);
      if (url.endsWith('/transition') && typeof init?.body === 'string') transitions.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ...job, state: 'dispatched', backendOccupancy: 'unknown' }));
    });
    vi.mocked(generateFromExplicitContext).mockResolvedValue({ succeeded: false, cumulativeBlob: null, errorMessage: 'Lost accepted submission response' });
    await runBridgeJob(job, new AbortController().signal);
    expect(transitions).toEqual([{ state: 'dispatched' }, { state: 'interrupted', error: 'SUBMISSION_OUTCOME_UNKNOWN: Lost accepted submission response' }]);
    expect(useGenerationStore.getState().backendOccupancyJobId).toBe('unknown-job');
    expect(useGenerationStore.getState().tryAcquireGenerationLock()).toBe(false);
    expect(useProjectStore.getState().project?.tracks.flatMap(track => track.clips).map(item => item.id)).toEqual([clip.id]);
    expect(uploads).toEqual([]);
  });

  it.each([false, true])('removes canceled job resources while preserving added user clips: %s', async (addUserClip) => {
    const project = useProjectStore.getState().project;
    if (!project) throw new Error('Missing project fixture');
    const reference = useProjectStore.getState().addTrack('keyboard', 'sample');
    const referenceClip = useProjectStore.getState().addClip(reference.id, { startTime: 0, duration: 1, prompt: '', lyrics: '' });
    const bytes = new TextEncoder().encode('canonical-source');
    const digest = await webcrypto.subtle.digest('SHA-256', bytes);
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const job = { jobId: 'job', sessionId: 'session', projectId: project.id, captureId: 'capture', bindingId: 'binding', canonicalSha256: hash, modelId: 'base', instrument: 'bass', startFrame: 0, endFrame: 48000, seed: 0, prompt: 'Bass', state: 'queued' };
    useLogicBridgeStore.setState({ ...useLogicBridgeStore.getInitialState(), connected: true, token: 'fixture', sessionId: 'session', projectId: project.id, executorId: 'executor', captures: [{ captureId: 'capture', canonicalAssetId: 'asset', canonicalSha256: hash, canonicalFrameCount: 48000, tempo: 120, timeSignature: [4, 4] }], bindings: [{ bindingId: 'binding', captureId: 'capture', clipId: referenceClip.id }] });
    const resultUploads: string[] = [];
    let backendComplete = false;
    const canceled = { ...job, state: 'canceled', backendTaskId: 'backend-task', backendOccupancy: 'unknown' };
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/query_result')) return new Response(JSON.stringify({ data: [{ task_id: 'backend-task', status: backendComplete ? 1 : 0 }] }));
      if (url.endsWith('/reconcile')) return new Response(JSON.stringify({ ...canceled, backendOccupancy: 'released' }));
      if (url.includes('/assets/')) return new Response(bytes, { status: 200 });
      if (url.endsWith('/result')) resultUploads.push(url);
      if (url.includes('/executor/jobs')) return new Response(JSON.stringify({ jobs: [canceled] }));
      return new Response(JSON.stringify({ ...canceled, state: url.endsWith('/submission') ? 'running' : 'canceled' }));
    });
    let notifyStarted = () => {};
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    let userClipId: string | undefined;
    let generatedTrackId: string | undefined;
    vi.mocked(generateFromExplicitContext).mockImplementation(async request => {
      await request.onSubmitted('backend-task');
      const target = useProjectStore.getState().getTrackForClip(request.clipId);
      if (addUserClip && target) {
        generatedTrackId = target.id;
        userClipId = useProjectStore.getState().addClip(target.id, { startTime: 1, duration: 1, prompt: 'User work', lyrics: '' }).id;
      }
      notifyStarted();
      await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { succeeded: false, cumulativeBlob: null, errorMessage: 'Cancelled' };
    });
    const execution = runBridgeJob(job, new AbortController().signal);
    await started;
    await vi.advanceTimersByTimeAsync(750);
    await execution;
    expect(useProjectStore.getState().project?.tracks.flatMap(track => track.clips).map(clip => clip.id)).toEqual(addUserClip ? [referenceClip.id, userClipId] : [referenceClip.id]);
    expect(useProjectStore.getState().project?.tracks.map(track => track.id)).toEqual(addUserClip ? [reference.id, generatedTrackId] : [reference.id]);
    expect(resultUploads).toEqual([]);
    expect(useGenerationStore.getState().tryAcquireGenerationLock()).toBe(false);
    backendComplete = true;
    await reconcileBridgeJob(canceled, 'fixture');
    expect(useGenerationStore.getState().tryAcquireGenerationLock()).toBe(true);
    expect(resultUploads).toEqual([]);
  });
});
