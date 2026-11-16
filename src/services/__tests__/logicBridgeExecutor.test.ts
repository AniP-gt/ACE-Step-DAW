import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createBridgeService } from "../../../server/logic-bridge/service";
import { BRIDGE_URL, object, stringField } from "../logicBridgeClient";
import { ExplicitContextError } from '../explicitContextGeneration';

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
import * as audioFiles from '../audioFileManager';

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
    vi.mocked(generateFromExplicitContext).mockImplementation(async request => {
      request.onSubmissionStarted?.();
      return { succeeded: false, cumulativeBlob: null, errorMessage: 'Lost accepted submission response' };
    });
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
      request.onSubmissionStarted?.();
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

it.each(['before-dispatch', 'after-dispatch', 'pipeline-preflight'] as const)('releases a job when another generation starts %s before submission over HTTP', async phase => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('Blob', NodeBlob);
  useProjectStore.getState().createProject();
  useGenerationStore.setState({ isGenerating: false, backendOccupancyJobId: null });
  useModelStore.setState({ availableModels: [{ name: 'base', is_loaded: true, is_default: false, supported_task_types: ['lego'] }] });
  const project = useProjectStore.getState().project;
  if (!project) throw new Error('Missing project');
  const track = useProjectStore.getState().addTrack('keyboard', 'sample');
  const clip = useProjectStore.getState().addClip(track.id, { startTime: 0, duration: 1, prompt: '', lyrics: '' });
  const root = await mkdtemp(join(tmpdir(), 'executor-presubmit-'));
  const service = await createBridgeService({ root, port: 0 });
  const transport = globalThis.fetch;
  const headers = { Authorization: `Bearer ${service.controlToken}`, 'X-Bridge-Protocol': '1', 'X-Executor-Id': 'executor', 'Content-Type': 'application/json' };
  const api = async (path: string, body?: Record<string, unknown>) => {
    const response = await transport(`${service.url}${path}`, { headers, method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body) } : {}) });
    expect(response.ok).toBe(true);
    return object(await response.json());
  };
  try {
    const session = await api('/sessions', { name: 'Presubmit recovery' });
    const sessionId = stringField(session, 'sessionId');
    const capture = await api('/captures', { sessionId, instanceId: 'native', sampleRate: 48000, channels: 1, expectedFrames: 48000, hostStartSample: 0, tempo: 120, timeSignature: [4, 4] });
    const pcm = Buffer.alloc(48000 * 4); pcm.writeFloatLE(0.5, 100);
    const sha256 = createHash('sha256').update(pcm).digest('hex');
    const uploaded = await transport(`${service.url}/captures/${capture.captureId}/chunks/0`, { method: 'PUT', headers: { ...headers, 'X-Start-Frame': '0', 'X-Chunk-SHA256': sha256 }, body: pcm });
    expect(uploaded.status).toBe(200);
    const ready = await api(`/captures/${capture.captureId}/finalize`, { sha256 });
    await api('/executor/register', { sessionId, projectId: project.id, executorId: 'executor', modelId: 'base', instruments: ['bass'], outputSemantics: 'isolated-layer' });
    const binding = await api('/bindings', { sessionId, projectId: project.id, captureId: capture.captureId, clipId: clip.id, clientRequestId: 'binding' });
    const parameters = { sessionId, projectId: project.id, captureId: capture.captureId, bindingId: binding.bindingId, clientRequestId: 'first', instrument: 'bass', startFrame: 0, endFrame: 48000, modelId: 'base' };
    const job = await api('/jobs', parameters);
    useLogicBridgeStore.setState({ ...useLogicBridgeStore.getInitialState(), connected: true, token: service.controlToken, sessionId, projectId: project.id, executorId: 'executor', captures: [ready], bindings: [binding] });
    if (phase === 'before-dispatch') useGenerationStore.setState({ isGenerating: true });
    if (phase === 'pipeline-preflight') vi.mocked(generateFromExplicitContext).mockRejectedValue(new ExplicitContextError('PROJECT_BUSY'));
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const response = await transport(input.replace(BRIDGE_URL, service.url), init);
      if (phase === 'after-dispatch' && input.endsWith('/transition') && init?.body === JSON.stringify({ state: 'dispatched' })) useGenerationStore.setState({ isGenerating: true });
      return response;
    });
    await runBridgeJob(job, new AbortController().signal);
    expect(await api(`/jobs/${job.jobId}`)).toMatchObject({ state: 'failed', backendOccupancy: 'released', error: 'PROJECT_BUSY' });
    useGenerationStore.setState({ isGenerating: false });
    expect((await api('/jobs', { ...parameters, clientRequestId: 'next' })).state).toBe('queued');
    expect(vi.mocked(generateFromExplicitContext)).toHaveBeenCalledTimes(phase === 'pipeline-preflight' ? 1 : 0);
  } finally {
    vi.unstubAllGlobals(); vi.clearAllMocks();
    await service.close(); await rm(root, { recursive: true, force: true });
  }
});


it.each(['download', 'dispatch'] as const)('blocks native inference when reference changes during %s', async phase => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('Blob', NodeBlob);
  useProjectStore.getState().createProject();
  useGenerationStore.setState({ isGenerating: false, backendOccupancyJobId: null });
  useModelStore.setState({ availableModels: [{ name: 'base', is_loaded: true, is_default: false, supported_task_types: ['lego'] }] });
  const project = useProjectStore.getState().project!;
  const track = useProjectStore.getState().addTrack('keyboard', 'sample');
  const clip = useProjectStore.getState().addClip(track.id, { startTime: 0, duration: 1, prompt: '', lyrics: '' });
  useProjectStore.getState().updateClipStatus(clip.id, 'ready', { isolatedAudioKey: 'reference', source: 'uploaded', audioDuration: 1, audioOffset: 0 });
  const bytes = new TextEncoder().encode('canonical-source');
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  vi.spyOn(audioFiles, 'loadAudioBlobByKey').mockResolvedValue(new NodeBlob([bytes]) as Blob);
  const job = { jobId: 'job', sessionId: 'session', projectId: project.id, captureId: 'capture', bindingId: 'binding', nativePreparedRequestId: 'prepare', canonicalSha256: hash, modelId: 'base', instrument: 'bass', startFrame: 0, endFrame: 48000, seed: 0, prompt: 'Bass', state: 'queued' };
  useLogicBridgeStore.setState({ ...useLogicBridgeStore.getInitialState(), connected: true, token: 'fixture', sessionId: 'session', projectId: project.id, executorId: 'executor', captures: [{ captureId: 'capture', state: 'ready', canonicalAssetId: 'asset', canonicalSha256: hash, canonicalFrameCount: 48000, tempo: 120, timeSignature: [4, 4] }], bindings: [{ bindingId: 'binding', projectId: project.id, captureId: 'capture', clipId: clip.id, canonicalSha256: hash }] });
  let jobState = 'queued'; let occupancy = 'reserved'; const actions: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('/assets/')) { if (phase === 'download') useProjectStore.getState().updateClip(clip.id, { duration: 0.5 }); return new Response(bytes); }
    if (url.endsWith('/invalidate')) { actions.push('invalidate'); return new Response(JSON.stringify({ state: 'failed' })); }
    if (url.endsWith('/transition')) {
      const data = JSON.parse(String(init?.body)); jobState = data.state; actions.push(data.state);
      occupancy = data.state === 'failed' && !actions.includes('dispatched') ? 'released' : 'occupied';
      if (data.state === 'dispatched' && phase === 'dispatch') useProjectStore.getState().updateClip(clip.id, { duration: 0.5 });
    } else if (url.endsWith('/reconcile')) { occupancy = 'released'; actions.push('reconcile'); }
    return new Response(JSON.stringify({ ...job, state: jobState, backendOccupancy: occupancy }));
  });
  try {
    await runBridgeJob(job, new AbortController().signal);
    expect(generateFromExplicitContext).not.toHaveBeenCalled();
    expect(actions).toContain('invalidate');
    expect(jobState).toBe('failed'); expect(occupancy).toBe('released');
    expect(useProjectStore.getState().project!.tracks.flatMap(item => item.clips).map(item => item.id)).toEqual([clip.id]);
  } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

it('invalidates a cropped native reference and releases its dispatched job over HTTP', async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('Blob', NodeBlob);
  useProjectStore.getState().createProject();
  useGenerationStore.setState({ isGenerating: false, backendOccupancyJobId: null });
  useModelStore.setState({ availableModels: [{ name: 'base', is_loaded: true, is_default: false, supported_task_types: ['lego'] }] });
  const project = useProjectStore.getState().project!;
  const track = useProjectStore.getState().addTrack('keyboard', 'sample');
  const clip = useProjectStore.getState().addClip(track.id, { startTime: 0, duration: 1, prompt: '', lyrics: '' });
  const root = await mkdtemp(join(tmpdir(), 'native-source-http-'));
  const service = await createBridgeService({ root, port: 0 });
  const transport = globalThis.fetch;
  const api = async (token: string, path: string, body?: Record<string, unknown>) => {
    const response = await transport(`${service.url}${path}`, { headers: { Authorization: `Bearer ${token}`, 'X-Executor-Id': 'executor', 'X-Bridge-Protocol': '1', 'Content-Type': 'application/json' }, method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body) } : {}) });
    expect(response.ok).toBe(true); return object(await response.json());
  };
  try {
    const session = await api(service.controlToken, '/sessions', { name: 'Native source guard' });
    const sessionId = stringField(session, 'sessionId');
    const pair = async (role: string) => { const item = await api(service.controlToken, '/pairings', { sessionId, role, projectId: project.id }); return stringField(await api('', '/pairings/claim', { code: item.code }), 'token'); };
    const native = await pair('native'); const executor = await pair('executor');
    const capture = await api(native, '/captures', { sessionId, instanceId: 'native', sampleRate: 48000, channels: 1, expectedFrames: 48000, hostStartSample: 0, tempo: 120, timeSignature: [4, 4] });
    const pcm = Buffer.alloc(48000 * 4); pcm.writeFloatLE(0.5, 100);
    const sha256 = createHash('sha256').update(pcm).digest('hex');
    expect((await transport(`${service.url}/captures/${capture.captureId}/chunks/0`, { method: 'PUT', headers: { Authorization: `Bearer ${native}`, 'X-Bridge-Protocol': '1', 'X-Start-Frame': '0', 'X-Chunk-SHA256': sha256 }, body: pcm })).status).toBe(200);
    const ready = await api(native, `/captures/${capture.captureId}/finalize`, { sha256 });
    const canonical = await transport(`${service.url}/assets/${ready.canonicalAssetId}`, { headers: { Authorization: `Bearer ${executor}`, 'X-Bridge-Protocol': '1' } });
    const bytes = await canonical.arrayBuffer();
    vi.spyOn(audioFiles, 'loadAudioBlobByKey').mockResolvedValue(new NodeBlob([bytes]) as Blob);
    useProjectStore.getState().updateClipStatus(clip.id, 'ready', { isolatedAudioKey: 'reference', source: 'uploaded', audioDuration: 1, audioOffset: 0 });
    await api(executor, '/executor/register', { sessionId, projectId: project.id, executorId: 'executor', modelId: 'base', instruments: ['bass'], outputSemantics: 'isolated-layer' });
    const prepare = await api(native, '/native-requests', { sessionId, kind: 'prepare', clientRequestId: 'prepare', captureId: capture.captureId });
    const binding = await api(executor, '/bindings', { sessionId, projectId: project.id, captureId: capture.captureId, clipId: clip.id, clientRequestId: 'binding' });
    await api(executor, `/native-requests/${prepare.requestId}/prepared`, { sessionId, bindingId: binding.bindingId });
    const intent = await api(native, '/native-requests', { sessionId, kind: 'generation', clientRequestId: 'intent', preparedRequestId: prepare.requestId, instrument: 'bass' });
    const submitted = await api(executor, `/native-requests/${intent.requestId}/submit`, { sessionId });
    const poll = await api(executor, `/executor/jobs?sessionId=${sessionId}`);
    if (!Array.isArray(poll.jobs)) throw new Error('Missing jobs');
    const job = object(poll.jobs[0]);
    useLogicBridgeStore.setState({ ...useLogicBridgeStore.getInitialState(), connected: true, token: executor, sessionId, projectId: project.id, executorId: 'executor', captures: [ready], bindings: [binding] });
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const response = await transport(input.replace(BRIDGE_URL, service.url), init);
      if (input.endsWith('/transition') && init?.body === JSON.stringify({ state: 'dispatched' })) useProjectStore.getState().updateClip(clip.id, { duration: 0.5 });
      return response;
    });
    await runBridgeJob(job, new AbortController().signal);
    expect(generateFromExplicitContext).not.toHaveBeenCalled();
    expect(await api(native, `/native-requests/${prepare.requestId}`)).toMatchObject({ state: 'failed', error: 'STALE_BINDING' });
    expect(await api(executor, `/jobs/${submitted.jobId}`)).toMatchObject({ state: 'failed', backendOccupancy: 'released', error: 'STALE_BINDING' });
    expect(useProjectStore.getState().project!.tracks.flatMap(item => item.clips).map(item => item.id)).toEqual([clip.id]);
  } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); await service.close(); await rm(root, { recursive: true, force: true }); }
});
