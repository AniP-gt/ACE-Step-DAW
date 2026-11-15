import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createBridgeService } from '../../server/logic-bridge/service';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const frames = 96_000;
export const modelId = 'fixture-base-lego';

function wav(): Buffer {
  const dataSize = frames * 8;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + dataSize, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(48_000, 24); bytes.writeUInt32LE(384_000, 28);
  bytes.writeUInt16LE(8, 32); bytes.writeUInt16LE(32, 34); bytes.write('data', 36); bytes.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < frames; i++) {
    const sample = Math.sin(i * 2 * Math.PI * 330 / 48_000) * 0.1;
    bytes.writeFloatLE(sample, 44 + i * 8); bytes.writeFloatLE(sample, 48 + i * 8);
  }
  return bytes;
}

export async function createGenerationFixture(options: { allowHostPort?: boolean; evidence?: string; seedCapture?: boolean } = {}) {
  const bridgePort = Number(process.env.VITE_LOGIC_BRIDGE_PORT);
  const uiPort = Number(process.env.E2E_PORT);
  if (!bridgePort || !uiPort || (bridgePort === 5176 && !options.allowHostPort) || bridgePort === uiPort) throw new Error('Provide isolated VITE_LOGIC_BRIDGE_PORT and E2E_PORT');
  const evidence = options.evidence ?? join(process.cwd(), '.codex/omo/evidence/bridge-plugin-generation-ui/resume6/integration');
  await mkdir(evidence, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), 'ace-bridge-e2e-'));
  const resourcePath = join(evidence, 'resources.json');
  const resources = { pid: process.pid, root, bridgePort, uiPort, modelPort: 0, state: 'starting' };
  await writeFile(resourcePath, JSON.stringify(resources, null, 2));
  const audio = wav();
  const submissions: { fields: Record<string, string>; sourceSize: number; sourceHash: string }[] = [];
  let loaded = true;
  const inventoryReads: { at: number; loaded: boolean }[] = [];
  const model: Server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    res.setHeader('Content-Type', 'application/json');
    if (path === '/health') { res.end(JSON.stringify({ status: 'ok' })); return; }
    if (path === '/v1/model_inventory') {
      inventoryReads.push({ at: Date.now(), loaded });
      res.end(JSON.stringify({ data: { models: [{ name: modelId, is_loaded: loaded, is_default: true, supported_task_types: ['lego'] }], lm_models: [] } })); return;
    }
    if (path === '/release_task' && req.method === 'POST') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': String(req.headers['content-type']) } }).formData();
      const fields: Record<string, string> = {}; let sourceSize = 0; let sourceHash = '';
      for (const [key, value] of form.entries()) {
        if (typeof value === 'string') fields[key] = value;
        else if (key === 'src_audio') { const b = Buffer.from(await value.arrayBuffer()); sourceSize = b.length; sourceHash = digest(b); }
      }
      submissions.push({ fields, sourceSize, sourceHash });
      res.end(JSON.stringify({ data: { task_id: 'fixture-task', status: 'queued' } })); return;
    }
    if (path === '/query_result') { res.end(JSON.stringify({ data: [{ task_id: 'fixture-task', status: 1, result: JSON.stringify([{ file: '/v1/audio?path=result.wav' }]) }] })); return; }
    if (path === '/v1/audio') { res.setHeader('Content-Type', 'audio/wav'); res.end(audio); return; }
    res.writeHead(404).end('{}');
  });
  let bridge: Awaited<ReturnType<typeof createBridgeService>> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { model.once('error', reject); model.listen(0, '127.0.0.1', resolve); });
    const address = model.address(); if (!address || typeof address === 'string') throw new Error('No model address');
    resources.modelPort = address.port;
    await writeFile(resourcePath, JSON.stringify(resources, null, 2));
    const modelUrl = `http://127.0.0.1:${address.port}`;
    bridge = await createBridgeService({ root, port: bridgePort, origins: [`http://127.0.0.1:${uiPort}`], apiUrl: modelUrl });
    resources.state = 'running'; await writeFile(resourcePath, JSON.stringify(resources, null, 2));
    const service = bridge;
    async function request(token: string, path: string, body?: unknown) {
      const response = await fetch(`${service.url}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Bridge-Protocol': '1', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json();
      if (!response.ok) throw new Error(`Bridge ${path}: ${response.status} ${JSON.stringify(value)}`);
      return value as Record<string, unknown>;
    }
    const session = await request(service.controlToken, '/sessions', { name: 'Browser integration' });
    const sessionId = String(session.sessionId);
    async function pairing(role: 'native' | 'executor', projectId?: string) {
      return request(service.controlToken, '/pairings', { sessionId, role, ...(projectId ? { projectId } : {}) });
    }
    let token = ''; let finalized: Record<string, unknown> = {};
    if (options.seedCapture !== false) {
      const nativePair = await pairing('native');
      const native = await request('', '/pairings/claim', { code: nativePair.code });
      token = String(native.token);
      const capture = await request(token, '/captures', { sessionId, instanceId: randomUUID(), sampleRate: 48_000, channels: 2, expectedFrames: frames, hostStartSample: 0, tempo: 120, timeSignature: [4, 4] });
      const pcm = audio.subarray(44);
      const uploaded = await fetch(`${service.url}/captures/${capture.captureId}/chunks/0`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'X-Bridge-Protocol': '1', 'X-Start-Frame': '0', 'X-Chunk-SHA256': digest(pcm) }, body: pcm });
      if (!uploaded.ok) throw new Error(`Capture upload: ${uploaded.status}`);
      finalized = await request(token, `/captures/${capture.captureId}/finalize`, { sha256: digest(pcm) });
    }
    return { root, resourcePath, sessionId, token, controlToken: service.controlToken, capture: finalized, modelUrl, submissions, inventoryReads, request, pairing,
      async snapshot() { const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8')); return { nativeRequests: (state.nativeRequests as Record<string, unknown>[]).map(({ kind, state: status, error, requestId, jobId }) => ({ kind, state: status, error, requestId, jobId })), jobs: (state.jobs as Record<string, unknown>[]).map(({ jobId, state: status, backendOccupancy, error }) => ({ jobId, state: status, backendOccupancy, error })) }; },
      async jobCount() { const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8')); return (state.jobs as unknown[]).length; },
      async asset(assetId: string) { const response = await fetch(`${service.url}/assets/${assetId}`, { headers: { Authorization: `Bearer ${token}`, 'X-Bridge-Protocol': '1' } }); if (!response.ok) throw new Error(`Asset: ${response.status}`); return Buffer.from(await response.arrayBuffer()); },
      setLoaded(value: boolean) { loaded = value; },
      async close() {
        await service.close(); await new Promise<void>((resolve, reject) => model.close(error => error ? reject(error) : resolve()));
        await rm(root, { recursive: true, force: true });
        const absent = await readFile(join(root, 'state.json')).then(() => false, () => true);
        for (const port of [bridgePort, address.port]) {
          const probe = createServer(); await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
          await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
        }
        resources.state = absent ? 'closed-root-absent-bridge-model-ports-rebound' : 'cleanup-failed';
        await writeFile(resourcePath, JSON.stringify(resources, null, 2));
        await copyFile(resourcePath, join(evidence, `resources-${basename(root)}.json`));
        if (!absent) throw new Error('Fixture root remains');
      },
    };
  } catch (error) {
    if (bridge) await bridge.close();
    if (model.listening) await new Promise<void>(resolve => model.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    resources.state = 'startup-failed-cleaned'; await writeFile(resourcePath, JSON.stringify(resources, null, 2));
    throw error;
  }
}
