import 'fake-indexeddb/auto';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { createHash, webcrypto } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, rm, access, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { set } from 'idb-keyval';
import { createBridgeService } from '../../../server/logic-bridge/service';
import { BRIDGE_URL, object, stringField } from '../logicBridgeClient';
import { processNativeRequests } from '../logicBridgeNativeRequests';
import { useProjectStore } from '../../store/projectStore';
import { useLogicBridgeStore } from '../../store/logicBridgeStore';
import { useModelStore } from '../../store/modelStore';
import { useGenerationStore } from '../../store/generationStore';

const samples = new Float32Array(48000);
const buffer = { numberOfChannels: 1, length: 48000, sampleRate: 48000, duration: 1, getChannelData: () => samples } as AudioBuffer;
vi.mock('../../hooks/useAudioEngine', () => ({ getAudioEngine: () => ({ ctx: { decodeAudioData: async () => buffer, createBuffer: () => buffer } }) }));
vi.mock('../../utils/waveformPeaks', async original => ({ ...await original<typeof import('../../utils/waveformPeaks')>(), computeWaveformWithMipmap: async () => [] }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture() {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('File', NodeFile);
  useProjectStore.getState().createProject({ bpm: 120 });
  useGenerationStore.setState({ isGenerating: false, backendOccupancyJobId: null });
  useModelStore.setState({ availableModels: [{ name: 'base', is_loaded: true, is_default: false, supported_task_types: ['lego'] }] });
  const project = useProjectStore.getState().project!;
  const root = await mkdtemp(join(tmpdir(), 'native-poll-http-'));
  const reserve = createServer(); await new Promise<void>((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
  const address = reserve.address(); if (!address || typeof address === 'string') throw new Error('No port'); const port = address.port;
  const log = process.env.BRIDGE_TEST_RESOURCE_LOG;
  if (log) await appendFile(log, JSON.stringify({ phase: 'registered', root, port }) + '\n');
  await new Promise<void>((resolve, reject) => reserve.close(error => error ? reject(error) : resolve()));
  const service = await createBridgeService({ root, port });
  const transport = globalThis.fetch;
  const api = async (token: string, path: string, body?: Record<string, unknown>) => {
    const response = await transport(`${service.url}${path}`, { headers: { Authorization: `Bearer ${token}`, 'X-Executor-Id': 'executor', 'X-Bridge-Protocol': '1', 'Content-Type': 'application/json' }, method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`); return object(await response.json());
  };
  const sessionId = stringField(await api(service.controlToken, '/sessions', { name: 'Poll fixture' }), 'sessionId');
  const pair = async (role: string) => { const code = await api(service.controlToken, '/pairings', { sessionId, role, projectId: project.id }); return stringField(await api('', '/pairings/claim', { code: code.code }), 'token'); };
  const native = await pair('native'); const executor = await pair('executor');
  const capture = async (instanceId: string) => {
    const c = await api(native, '/captures', { sessionId, instanceId, sampleRate: 48000, channels: 1, expectedFrames: 48000, hostStartSample: 0, tempo: 120, timeSignature: [4, 4] });
    const pcm = Buffer.alloc(48000 * 4); for (let i = 0; i < 48000; i++) pcm.writeFloatLE(i % 2 ? 0.25 : -0.25, i * 4);
    const sha256 = createHash('sha256').update(pcm).digest('hex');
    const uploaded = await transport(`${service.url}/captures/${c.captureId}/chunks/0`, { method: 'PUT', headers: { Authorization: `Bearer ${native}`, 'X-Bridge-Protocol': '1', 'X-Start-Frame': '0', 'X-Chunk-SHA256': sha256 }, body: pcm });
    expect(uploaded.status).toBe(200); return api(native, `/captures/${c.captureId}/finalize`, { sha256 });
  };
  const a = await capture('a'); const b = await capture('b');
  await api(executor, '/executor/register', { sessionId, projectId: project.id, executorId: 'executor', modelId: 'base', instruments: ['bass'], outputSemantics: 'isolated-layer' });
  const first = await api(native, '/native-requests', { sessionId, kind: 'prepare', captureId: a.captureId, clientRequestId: 'first' });
  const track = useProjectStore.getState().addTrack('keyboard', 'sample');
  const clip = useProjectStore.getState().addClip(track.id, { startTime: 0, duration: 1, prompt: '', lyrics: '' });
  const audioResponse = await transport(`${service.url}/assets/${a.canonicalAssetId}`, { headers: { Authorization: `Bearer ${executor}`, 'X-Bridge-Protocol': '1' } });
  expect(audioResponse.status).toBe(200); await set('first-audio', new NodeBlob([await audioResponse.arrayBuffer()]));
  useProjectStore.getState().updateClipStatus(clip.id, 'ready', { isolatedAudioKey: 'first-audio', source: 'uploaded', audioDuration: 1, audioOffset: 0 });
  const binding = await api(executor, '/bindings', { sessionId, projectId: project.id, captureId: a.captureId, clipId: clip.id, clientRequestId: 'binding' });
  await api(executor, `/native-requests/${first.requestId}/prepared`, { sessionId, bindingId: binding.bindingId });
  const intent = await api(native, '/native-requests', { sessionId, kind: 'generation', preparedRequestId: first.requestId, clientRequestId: 'intent', instrument: 'bass' });
  useLogicBridgeStore.setState({ ...useLogicBridgeStore.getInitialState(), token: executor, connected: true, sessionId, projectId: project.id, executorId: 'executor', verifiedModelId: 'base', captures: [a, b], bindings: [binding] });
  let failCalls = 0; let mode = '';
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = input.replace(BRIDGE_URL, service.url);
    if (url.endsWith(`/native-requests/${intent.requestId}/fail`)) {
      failCalls++;
      if (mode === 'closed') await api(native, `/native-requests/${intent.requestId}/cancel`, {});
      if (mode === 'fail-network') throw new TypeError('fail unavailable');
      if (mode === 'fail-forbidden') return new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Denied' } }), { status: 403 });
    }
    if (mode === 'outcome-unknown' && url.endsWith(`/native-requests/${intent.requestId}/submit`)) return new Response(JSON.stringify({ error: { code: 'BACKEND_OUTCOME_UNKNOWN', message: 'Unknown occupancy' } }), { status: 409 });
    const response = await transport(url, init);
    if (mode === 'lost' && url.endsWith(`/native-requests/${intent.requestId}/submit`)) throw new TypeError('response lost');
    if (mode === 'server-error' && url.endsWith(`/native-requests/${intent.requestId}/submit`)) return new Response(JSON.stringify({ error: { code: 'STALE_BINDING', message: 'Uncertain server failure' } }), { status: 503 });
    return response;
  });
  const close = async () => { vi.unstubAllGlobals(); await service.close(); const probe = createServer(); await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); }); await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve())); await rm(root, { recursive: true, force: true }); await expect(access(root)).rejects.toThrow(); if (log) await appendFile(log, JSON.stringify({ phase: 'clean', root, port }) + '\n'); };
  return { service, api, native, executor, sessionId, project, clip, b, intent, close, setMode: (value: string) => { mode = value; }, failCalls: () => failCalls };
}

it.each(['stale', 'closed'])('closes a superseded intent and processes the later preparation: %s', async mode => {
  const f = await fixture();
  try {
    const second = await f.api(f.native, '/native-requests', { sessionId: f.sessionId, kind: 'prepare', captureId: f.b.captureId, clientRequestId: 'second' });
    f.setMode(mode);
    await processNativeRequests({ token: f.executor, sessionId: f.sessionId, projectId: f.project.id, guard: () => {} });
    expect(await f.api(f.native, `/native-requests/${f.intent.requestId}`)).toMatchObject({ state: mode === 'closed' ? 'canceled' : 'failed', ...(mode === 'stale' ? { error: 'STALE_BINDING' } : {}) });
    expect(await f.api(f.native, `/native-requests/${second.requestId}`)).toMatchObject({ state: 'prepared' });
    expect((await f.api(f.executor, `/executor/jobs?sessionId=${f.sessionId}`)).jobs).toEqual([]);
    expect(useProjectStore.getState().getClipById(f.clip.id)).toBeDefined();
    expect(useProjectStore.getState().project!.tracks.flatMap(t => t.clips)).toHaveLength(2);
    await processNativeRequests({ token: f.executor, sessionId: f.sessionId, projectId: f.project.id, guard: () => {} });
    expect(f.failCalls()).toBe(1);
  } finally { await f.close(); }
});

it.each(['lost', 'server-error'])('does not fail or release an accepted submit after uncertain %s', async mode => {
  const f = await fixture();
  try {
    f.setMode(mode);
    await expect(processNativeRequests({ token: f.executor, sessionId: f.sessionId, projectId: f.project.id, guard: () => {} })).rejects.toThrow(mode === 'lost' ? 'response lost' : 'Uncertain server failure');
    expect(await f.api(f.native, `/native-requests/${f.intent.requestId}`)).toMatchObject({ state: 'submitted' });
    expect(f.failCalls()).toBe(0);
    const jobs = (await f.api(f.executor, `/executor/jobs?sessionId=${f.sessionId}`)).jobs;
    expect(jobs).toEqual([expect.objectContaining({ state: 'queued', backendOccupancy: 'reserved' })]);
    await processNativeRequests({ token: f.executor, sessionId: f.sessionId, projectId: f.project.id, guard: () => {} });
    expect((await f.api(f.executor, `/executor/jobs?sessionId=${f.sessionId}`)).jobs).toHaveLength(1);
    expect(f.failCalls()).toBe(0);
  } finally { await f.close(); }
});


it.each(['fail-network', 'fail-forbidden'])('propagates %s instead of claiming the old request closed', async mode => {
  const f = await fixture();
  try {
    const second = await f.api(f.native, '/native-requests', { sessionId: f.sessionId, kind: 'prepare', captureId: f.b.captureId, clientRequestId: 'second' });
    f.setMode(mode);
    await expect(processNativeRequests({ token: f.executor, sessionId: f.sessionId, projectId: f.project.id, guard: () => {} })).rejects.toThrow(mode === 'fail-network' ? 'fail unavailable' : 'Denied');
    expect(await f.api(f.native, `/native-requests/${f.intent.requestId}`)).toMatchObject({ state: 'pending' });
    expect(await f.api(f.native, `/native-requests/${second.requestId}`)).toMatchObject({ state: 'pending' });
    expect((await f.api(f.executor, `/executor/jobs?sessionId=${f.sessionId}`)).jobs).toEqual([]);
  } finally { await f.close(); }
});


it('does not fail a pending request on BACKEND_OUTCOME_UNKNOWN', async () => {
  const f = await fixture();
  try {
    f.setMode('outcome-unknown');
    await expect(processNativeRequests({ token: f.executor, sessionId: f.sessionId, projectId: f.project.id, guard: () => {} })).rejects.toThrow('Unknown occupancy');
    expect(await f.api(f.native, `/native-requests/${f.intent.requestId}`)).toMatchObject({ state: 'pending' });
    expect(f.failCalls()).toBe(0);
    expect((await f.api(f.executor, `/executor/jobs?sessionId=${f.sessionId}`)).jobs).toEqual([]);
  } finally { await f.close(); }
});
