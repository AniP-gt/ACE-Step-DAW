import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';
import { createHash, webcrypto } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, rm, access, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { set } from 'idb-keyval';
import { createBridgeService } from '../../../server/logic-bridge/service';
import { BRIDGE_URL, object, stringField } from '../logicBridgeClient';
import { connectBridge, disconnectBridge } from '../logicBridge';
import { useProjectStore } from '../../store/projectStore';
import { useLogicBridgeStore } from '../../store/logicBridgeStore';
import { useModelStore } from '../../store/modelStore';
import { useGenerationStore } from '../../store/generationStore';
import { generateFromExplicitContext } from '../generationPipeline';

vi.mock('../generationPipeline', () => ({ generateFromExplicitContext: vi.fn() }));
afterEach(() => { disconnectBridge(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

it.each(['busy', 'lost', 'server-error', 'fail-jobs-auth'])('runs the accepted job with native outcome %s', async mode => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('Blob', NodeBlob); vi.stubEnv('VITE_LOGIC_BRIDGE_VERIFIED_MODEL', 'base');
  useProjectStore.getState().createProject({ bpm: 120 });
  useGenerationStore.setState({ isGenerating: false, backendOccupancyJobId: null });
  useModelStore.setState({ availableModels: [{ name: 'base', is_loaded: true, is_default: false, supported_task_types: ['lego'] }] });
  const project = useProjectStore.getState().project!;
  const root = await mkdtemp(join(tmpdir(), 'native-scheduling-'));
  const reserve = createServer(); await new Promise<void>((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
  const address = reserve.address(); if (!address || typeof address === 'string') throw new Error('No port'); const port = address.port;
  const log = process.env.BRIDGE_TEST_RESOURCE_LOG; if (log) await appendFile(log, JSON.stringify({ phase: 'registered', root, port }) + '\n');
  await new Promise<void>((resolve, reject) => reserve.close(error => error ? reject(error) : resolve()));
  const service = await createBridgeService({ root, port });
  const transport = globalThis.fetch;
  const api = async (token: string, path: string, body?: Record<string, unknown>, executorId = '') => {
    const response = await transport(`${service.url}${path}`, { headers: { Authorization: `Bearer ${token}`, ...(executorId ? { 'X-Executor-Id': executorId } : {}), 'X-Bridge-Protocol': '1', 'Content-Type': 'application/json' }, method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`); return object(await response.json());
  };
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void; const waiting = new Promise<void>(resolve => { reached = resolve; });
  let gateOpen = false; let jobPolls = 0; let active = 0; let maxActive = 0; let submitCount = 0; let failCount = 0;
  vi.mocked(generateFromExplicitContext).mockImplementation(async () => { active++; maxActive = Math.max(maxActive, active); await Promise.resolve(); active--; return { succeeded: false, cumulativeBlob: null, errorMessage: 'MODEL_FIXTURE_STOPPED' }; });
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = input.replace(BRIDGE_URL, service.url);
    if ((url.includes('/captures?') || url.includes('/bindings?')) && !gateOpen) { reached(); await gate; }
    if (url.includes('/executor/jobs?')) {
      jobPolls++;
      if (mode === 'fail-jobs-auth') return new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'jobs denied' } }), { status: 403 });
    }
    if (url.endsWith('/fail')) {
      failCount++;
      if (mode === 'fail-jobs-auth') throw new TypeError('fail unavailable');
    }
    const response = await transport(url, init);
    if (url.endsWith('/submit') && ++submitCount === 1) {
      if (mode === 'lost') throw new TypeError('response lost');
      if (mode === 'server-error') return new Response(JSON.stringify({ error: { code: 'STALE_BINDING', message: 'uncertain' } }), { status: 503 });
    }
    return response;
  });
  try {
    const sessionId = stringField(await api(service.controlToken, '/sessions', { name: 'Scheduling fixture' }), 'sessionId');
    const pairCode = async (role: string) => stringField(await api(service.controlToken, '/pairings', { sessionId, role, projectId: project.id }), 'code');
    const owner = async () => stringField(await api('', '/pairings/claim', { code: await pairCode('native') }), 'token');
    const owners = [await owner(), await owner()];
    const captures = [];
    for (let i = 0; i < owners.length; i++) {
      const capture = await api(owners[i], '/captures', { sessionId, instanceId: `instance-${i}`, sampleRate: 48000, channels: 1, expectedFrames: 48000, hostStartSample: 0, tempo: 120, timeSignature: [4, 4] });
      const pcm = Buffer.alloc(48000 * 4); for (let frame = 0; frame < 48000; frame++) pcm.writeFloatLE(frame % 2 ? 0.25 : -0.25, frame * 4);
      const sha256 = createHash('sha256').update(pcm).digest('hex');
      const response = await transport(`${service.url}/captures/${capture.captureId}/chunks/0`, { method: 'PUT', headers: { Authorization: `Bearer ${owners[i]}`, 'X-Bridge-Protocol': '1', 'X-Start-Frame': '0', 'X-Chunk-SHA256': sha256 }, body: pcm }); expect(response.status).toBe(200);
      captures.push(await api(owners[i], `/captures/${capture.captureId}/finalize`, { sha256 }));
    }
    await connectBridge(await pairCode('executor')); await waiting;
    const executor = useLogicBridgeStore.getState(); if (!executor.token || !executor.executorId) throw new Error('No executor');
    const executorToken = executor.token, executorId = executor.executorId;
    const intents = [];
    for (let i = 0; i < owners.length; i++) {
      const capture = captures[i];
      const prepare = await api(owners[i], '/native-requests', { sessionId, kind: 'prepare', clientRequestId: `prepare-${i}`, captureId: capture.captureId });
      const track = useProjectStore.getState().addTrack('keyboard', 'sample');
      const clip = useProjectStore.getState().addClip(track.id, { startTime: 0, duration: 1, prompt: '', lyrics: '' });
      const wav = await transport(`${service.url}/assets/${capture.canonicalAssetId}`, { headers: { Authorization: `Bearer ${executorToken}`, 'X-Bridge-Protocol': '1' } });
      const audioKey = `source-${i}`; await set(audioKey, new NodeBlob([await wav.arrayBuffer()]));
      useProjectStore.getState().updateClipStatus(clip.id, 'ready', { isolatedAudioKey: audioKey, source: 'uploaded', audioDuration: 1, audioOffset: 0 });
      const binding = await api(executorToken, '/bindings', { sessionId, projectId: project.id, captureId: capture.captureId, clipId: clip.id, clientRequestId: `binding-${i}` }, executorId);
      await api(executorToken, `/native-requests/${prepare.requestId}/prepared`, { sessionId, bindingId: binding.bindingId }, executorId);
      intents.push(await api(owners[i], '/native-requests', { sessionId, kind: 'generation', clientRequestId: `intent-${i}`, preparedRequestId: prepare.requestId, instrument: 'bass' }));
    }
    gateOpen = true; release();
    if (mode === 'fail-jobs-auth') {
      await vi.waitFor(() => expect(useLogicBridgeStore.getState().error).toBe('jobs denied'), { timeout: 4000, interval: 20 });
      expect(generateFromExplicitContext).not.toHaveBeenCalled(); expect(failCount).toBe(1);
    } else {
      await vi.waitFor(() => expect(generateFromExplicitContext).toHaveBeenCalledTimes(1), { timeout: 4000, interval: 20 });
    }
    await vi.waitFor(async () => expect(await api(owners[1], `/native-requests/${intents[1].requestId}`)).toMatchObject(mode === 'busy' ? { state: 'failed', error: 'PROJECT_BUSY' } : { state: 'pending' }), { timeout: 4000, interval: 20 });
    if (mode === 'lost' || mode === 'server-error') { expect(submitCount).toBe(1); expect(failCount).toBe(0); }
    expect(await api(owners[0], `/native-requests/${intents[0].requestId}`)).toMatchObject({ state: 'submitted' });
    expect(jobPolls).toBeGreaterThan(0); expect(maxActive).toBe(mode === 'fail-jobs-auth' ? 0 : 1);
  } finally {
    release(); disconnectBridge(); vi.unstubAllGlobals(); await service.close();
    const probe = createServer(); await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); }); await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true }); await expect(access(root)).rejects.toThrow(); if (log) await appendFile(log, JSON.stringify({ phase: 'clean', root, port }) + '\n');
  }
});
