import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeService } from '../../server/logic-bridge/service';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const behavior = { status: 1, failHealth: false, noModel: false, dropSubmit: false, invalidAudioPath: false, pollFailures: 0, holdPoll: false, heldPolls: 0, syntheticTimeouts: 0, downloadFailures: 0, downloadCode: 503, invalidWav: false, queueFull: false, ambiguous429: false, holdAudio: false, heldAudios: 0 };
  let releasePoll: (() => void) | undefined; let releaseAudio: (() => void) | undefined;
  let count = 0;
  let submitted = '';
  const pcm = Buffer.alloc(48000 * 8);
  for (let i = 0; i < 48000 * 2; i++) pcm.writeFloatLE(i % 2 ? 0.1 : -0.1, i * 4);
  const resultPcm = Buffer.alloc(48000 * 2 * 2);
  for (let i = 0; i < 48000 * 2; i++) resultPcm.writeInt16LE(i % 2 ? 4096 : -4096, i * 2);
  const resultWav = Buffer.alloc(44 + resultPcm.length); resultWav.write('RIFF'); resultWav.writeUInt32LE(resultWav.length - 8, 4); resultWav.write('WAVEfmt ', 8); resultWav.writeUInt32LE(16, 16); resultWav.writeUInt16LE(1, 20); resultWav.writeUInt16LE(2, 22); resultWav.writeUInt32LE(48000, 24); resultWav.writeUInt32LE(192000, 28); resultWav.writeUInt16LE(4, 32); resultWav.writeUInt16LE(16, 34); resultWav.write('data', 36); resultWav.writeUInt32LE(resultPcm.length, 40); resultPcm.copy(resultWav, 44);
  const fake = createServer(async (req, res) => {
    const chunks: Buffer[] = []; try { for await (const chunk of req) chunks.push(Buffer.from(chunk)); } catch { return; }
    if (req.url === '/health' && behavior.failHealth) { res.statusCode = 503; res.end(); }
    else if (req.url === '/health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: { status: 'ok', service: 'ACE-Step API', models_initialized: !behavior.noModel }, code: 200 })); }
    else if (req.url === '/release_task') {
      count++; submitted = Buffer.concat(chunks).toString('latin1');
      if (behavior.dropSubmit) { req.socket.destroy(); return; }
      if (behavior.queueFull || behavior.ambiguous429) { res.statusCode = 429; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ detail: behavior.queueFull ? 'Server busy: queue is full' : 'other rate limit' })); return; }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: { task_id: 'cover-task' }, code: 200 }));
    } else if (req.url === '/query_result') {
      if (behavior.syntheticTimeouts > 0) { behavior.syntheticTimeouts--; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ task_id: 'cover-task', status: 2, result: JSON.stringify([{ status: 0, create_time: 1, file: '' }]) }], code: 200 })); return; }
      if (behavior.pollFailures > 0) { behavior.pollFailures--; res.statusCode = 503; res.end(); return; }
      if (behavior.holdPoll) { behavior.heldPolls++; await new Promise<void>(resolve => { releasePoll = resolve; }); }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ task_id: 'cover-task', status: behavior.status, result: JSON.stringify([{ status: behavior.status, file: behavior.invalidAudioPath ? 'http://example.com/private' : '/v1/audio?path=%2Ftmp%2Fcover.wav' }]) }], code: 200 }));
    } else if (req.url?.startsWith('/v1/audio?') && behavior.downloadFailures > 0) { behavior.downloadFailures--; res.statusCode = behavior.downloadCode; res.end(); }
    else if (req.url?.startsWith('/v1/audio?')) { if (behavior.holdAudio) { behavior.heldAudios++; await new Promise<void>(resolve => { releaseAudio = resolve; }); } res.setHeader('Content-Type', 'audio/wav'); res.end(behavior.invalidWav ? Buffer.from('invalid') : resultWav); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>(resolve => fake.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => fake.close(() => resolve())));
  const addr = fake.address(); if (!addr || typeof addr === 'string') throw new Error('No fake API address');
  const root = await mkdtemp(join(tmpdir(), 'bridge-direct-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const service = await createBridgeService({ root, port: 0, apiUrl: `http://127.0.0.1:${addr.port}` });
  cleanup.push(() => service.close());
  const api = (token: string, path: string, body?: unknown) => fetch(`${service.url}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Bridge-Protocol': '1', 'Content-Type': 'application/json', 'X-Executor-Id': 'executor-a' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = async (response: Response): Promise<Record<string, unknown>> => response.json();
  const session = await json(await api(service.controlToken, '/sessions', { name: 'Direct fixture' }));
  const pair = async (role = 'native') => {
    const code = await json(await api(service.controlToken, '/pairings', { sessionId: session.sessionId, role, projectId: 'project-a' }));
    return String((await json(await api('', '/pairings/claim', { code: code.code }))).token);
  };
  const token = await pair();
  const capture = await json(await api(token, '/captures', { sessionId: session.sessionId, instanceId: 'direct-fixture', sampleRate: 48000, channels: 2, expectedFrames: 48000, hostStartSample: 24000, tempo: 120, timeSignature: [4, 4] }));
  expect((await fetch(`${service.url}/captures/${capture.captureId}/chunks/0`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'X-Bridge-Protocol': '1', 'X-Start-Frame': '0', 'X-Chunk-SHA256': digest(pcm) }, body: pcm })).status).toBe(200);
  expect((await api(token, `/captures/${capture.captureId}/finalize`, { sha256: digest(pcm) })).status).toBe(200);
  return { service, api, json, pair, token, behavior, releasePoll: () => releasePoll?.(), releaseAudio: () => releaseAudio?.(), root, apiUrl: `http://127.0.0.1:${addr.port}`, sessionId: String(session.sessionId), captureId: String(capture.captureId), count: () => count, submitted: () => submitted };
}

it('runs Cover without DAW executor, publishes WAV and deduplicates a native request', async () => {
  const f = await fixture();
  const request = { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'req-1', prompt: 'solo violin' };
  const response = await f.api(f.token, '/direct-jobs', request);
  expect(response.status).toBe(200);
  const first = await f.json(response);
  const repeated = await f.json(await f.api(f.token, '/direct-jobs', request));
  expect(repeated.requestId).toBe(first.requestId);
  expect((await f.api(f.token, '/direct-jobs', { ...request, prompt: 'other' })).status).toBe(409);
  await expect.poll(async () => (await f.json(await f.api(f.token, `/direct-jobs/${first.requestId}`))).state, { timeout: 5000 }).toBe('ready');
  const result = await f.json(await f.api(f.token, `/direct-jobs/${first.requestId}`));
  expect(f.count()).toBe(1); expect(f.submitted()).toContain('solo violin'); expect(f.submitted()).toContain('name="src_audio"'); expect(f.submitted()).toContain('cover');
  const meta = await f.json(await f.api(f.token, `/results/${result.resultId}`));
  expect(meta).toMatchObject({ frameCount: 48000, placementSeconds: 0.5 });
  const audio = await f.api(f.token, `/assets/${meta.assetId}`); expect(audio.status).toBe(200);
  const bytes = Buffer.from(await audio.arrayBuffer()); expect(bytes.readUInt16LE(20)).toBe(3); expect(bytes.readUInt16LE(34)).toBe(32); expect(bytes.readFloatLE(44)).toBe(-0.125);
});

it('rejects empty or unavailable source and protects request ownership', async () => {
  const f = await fixture();
  const request = { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'req-2', prompt: '   ' };
  expect((await f.api(f.token, '/direct-jobs', request)).status).toBe(400);
  expect((await f.api(f.token, '/direct-jobs', { ...request, prompt: 'violin', captureId: 'missing' })).status).toBe(409);
  const first = await f.json(await f.api(f.token, '/direct-jobs', { ...request, prompt: 'violin' }));
  const secondToken = await f.pair();
  expect((await f.api(secondToken, `/direct-jobs/${first.requestId}`)).status).toBe(403);
});

async function untilState(f: Awaited<ReturnType<typeof fixture>>, id: unknown, state: string) {
  await expect.poll(async () => (await f.json(await f.api(f.token, `/direct-jobs/${id}`))).state, { timeout: 5000 }).toBe(state);
}
it('fails safely before submission when API health is unavailable', async () => {
  const f = await fixture(); f.behavior.failHealth = true;
  const first = await f.json(await f.api(f.token, '/direct-jobs', { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'offline', prompt: 'violin' }));
  await untilState(f, first.requestId, 'failed'); expect(f.count()).toBe(0);
  const again = await f.api(f.token, '/direct-jobs', { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'offline-new', prompt: 'violin' }); expect(again.status).toBe(200);
});
it('does not resend an uncertain submission and allows owner to recover its receipt', async () => {
  const f = await fixture(); f.behavior.dropSubmit = true;
  const request = { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'uncertain', prompt: 'violin' };
  const first = await f.json(await f.api(f.token, '/direct-jobs', request)); await untilState(f, first.requestId, 'interrupted');
  const found = await f.json(await f.api(f.token, `/direct-jobs?sessionId=${f.sessionId}&clientRequestId=uncertain`)); expect(found.requestId).toBe(first.requestId);
  expect((await f.api(f.token, '/direct-jobs', { ...request, clientRequestId: 'different' })).status).toBe(409);
  expect((await f.api(f.token, `/direct-jobs/${first.requestId}/reconcile`, { backendStopped: true })).status).toBe(403);
  expect((await f.api(f.service.controlToken, `/direct-jobs/${first.requestId}/reconcile`, { backendStopped: true })).status).toBe(200);
  const released = await f.json(await f.api(f.token, `/direct-jobs/${first.requestId}`)); expect(released.state).toBe('failed');
  const replay = await f.json(await f.api(f.token, '/direct-jobs', request)); expect(replay).toMatchObject({ requestId: first.requestId, state: 'failed' });
  expect(f.count()).toBe(1);
  f.behavior.dropSubmit = false;
  expect((await f.api(f.token, '/direct-jobs', { ...request, clientRequestId: 'explicit-new' })).status).toBe(200);
});
it('reconciles a known backend task after bridge restart without resubmission', async () => {
  const f = await fixture(); f.behavior.status = 0;
  const first = await f.json(await f.api(f.token, '/direct-jobs', { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'restart', prompt: 'violin' }));
  await untilState(f, first.requestId, 'running'); await expect.poll(() => f.count()).toBe(1);
  await expect.poll(async () => JSON.parse(await readFile(join(f.root, 'state.json'), 'utf8')).directCoverJobs[0]?.backendTaskId).toBe('cover-task');
  await f.service.close(); f.behavior.status = 1;
  const restarted = await createBridgeService({ root: f.root, port: 0, apiUrl: f.apiUrl }); cleanup.push(() => restarted.close());
  const get = () => fetch(`${restarted.url}/direct-jobs/${first.requestId}`, { headers: { Authorization: `Bearer ${f.token}` } }).then(r => r.json());
  await expect.poll(async () => (await get()).state, { timeout: 5000 }).toBe('ready'); expect(f.count()).toBe(1);
});
it('rejects untrusted audio URLs after completed generation and releases occupancy', async () => {
  const f = await fixture(); f.behavior.invalidAudioPath = true;
  const first = await f.json(await f.api(f.token, '/direct-jobs', { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'bad-url', prompt: 'violin' }));
  await untilState(f, first.requestId, 'failed');
  expect((await f.api(f.token, '/direct-jobs', { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'next', prompt: 'violin' })).status).toBe(200);
});

async function createDawJob(f: Awaited<ReturnType<typeof fixture>>) {
  const executor = await f.pair('executor');
  const registered = await f.api(executor, '/executor/register', { sessionId: f.sessionId, projectId: 'project-a', executorId: 'executor-a', modelId: 'fixture-base', instruments: ['piano'], outputSemantics: 'isolated-layer' }); expect(registered.status).toBe(200);
  const binding = await f.json(await f.api(executor, '/bindings', { sessionId: f.sessionId, projectId: 'project-a', captureId: f.captureId, clipId: 'fixture-clip', clientRequestId: 'bind' }));
  return f.api(executor, '/jobs', { sessionId: f.sessionId, projectId: 'project-a', captureId: f.captureId, bindingId: binding.bindingId, clientRequestId: 'daw-job', instrument: 'piano', startFrame: 0, endFrame: 48000, prompt: 'piano', modelId: 'fixture-base' });
}
it('prevents direct generation while the DAW owns backend occupancy', async () => {
  const f = await fixture(); expect((await createDawJob(f)).status).toBe(202);
  expect((await f.api(f.token, '/direct-jobs', { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'direct-busy', prompt: 'violin' })).status).toBe(409);
  expect(f.count()).toBe(0);
});
it('prevents DAW generation while direct Cover owns backend occupancy', async () => {
  const f = await fixture(); f.behavior.status = 0;
  const first = await f.api(f.token, '/direct-jobs', { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'direct-running', prompt: 'violin' }); expect(first.status).toBe(200);
  expect((await createDawJob(f)).status).toBe(409);
});

it('reports an uninitialized model before attempting submission', async () => {
  const f = await fixture(); f.behavior.noModel = true;
  const first = await f.json(await f.api(f.token, '/direct-jobs', { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'no-model', prompt: 'violin' }));
  await untilState(f, first.requestId, 'failed'); const result = await f.json(await f.api(f.token, `/direct-jobs/${first.requestId}`));
  expect(result.error).toContain('no initialized model'); expect(f.count()).toBe(0);
});

it('retries status polling after a transient error without resubmitting', async () => {
  const f = await fixture(); f.behavior.pollFailures = 1;
  const first = await f.json(await f.api(f.token, '/direct-jobs', { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'transient', prompt: 'violin' }));
  await untilState(f, first.requestId, 'ready'); expect(f.count()).toBe(1);
});
it('does not publish a stale in-flight poll after operator reconciliation', async () => {
  const f = await fixture(); f.behavior.pollFailures = 1; f.behavior.holdPoll = true;
  const first = await f.json(await f.api(f.token, '/direct-jobs', { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'stale', prompt: 'violin' }));
  await untilState(f, first.requestId, 'interrupted');
  await expect.poll(() => f.behavior.heldPolls, { timeout: 5000 }).toBe(1);
  expect((await f.api(f.service.controlToken, `/direct-jobs/${first.requestId}/reconcile`, { backendStopped: true })).status).toBe(200);
  f.releasePoll(); await new Promise(resolve => setTimeout(resolve, 250));
  const result = await f.json(await f.api(f.token, `/direct-jobs/${first.requestId}`)); expect(result.state).toBe('failed'); expect(result.resultId).toBeUndefined(); expect(f.count()).toBe(1);
  const catalog = await f.json(await f.api(f.token, `/results?sessionId=${f.sessionId}`)); expect(catalog.results).toEqual([]);
});
it('returns failed for an unsent queued request recovered after service restart', async () => {
  const f = await fixture(); f.behavior.failHealth = true;
  const first = await f.json(await f.api(f.token, '/direct-jobs', { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'queued-restart', prompt: 'violin' }));
  await untilState(f, first.requestId, 'failed'); await f.service.close();
  const statePath = join(f.root, 'state.json'); const persisted = JSON.parse(await readFile(statePath, 'utf8'));
  persisted.directCoverJobs[0].state = 'queued'; persisted.directCoverJobs[0].backendOccupancy = 'reserved'; delete persisted.directCoverJobs[0].error;
  await writeFile(statePath, JSON.stringify(persisted));
  const restarted = await createBridgeService({ root: f.root, port: 0, apiUrl: f.apiUrl }); cleanup.push(() => restarted.close());
  const response = await fetch(`${restarted.url}/direct-jobs/${first.requestId}`, { headers: { Authorization: `Bearer ${f.token}` } });
  expect((await response.json()).state).toBe('failed'); expect(f.count()).toBe(0);
});

it('stops a waiting status retry without resubmission and retains unknown occupancy', async () => {
  const f = await fixture(); f.behavior.pollFailures = 1000;
  const first = await f.json(await f.api(f.token, '/direct-jobs', { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'stop-retry', prompt: 'violin' }));
  await untilState(f, first.requestId, 'interrupted');
  const started = Date.now(); await f.service.close(); expect(Date.now() - started).toBeLessThan(2000);
  const saved = JSON.parse(await readFile(join(f.root, 'state.json'), 'utf8')).directCoverJobs[0];
  expect(saved).toMatchObject({ state: 'interrupted', backendOccupancy: 'unknown', backendTaskId: 'cover-task' }); expect(f.count()).toBe(1);
});

it('keeps a synthetically timed out but internally running API task occupied until a later terminal result', async () => {
  const f = await fixture(); f.behavior.syntheticTimeouts = 1;
  const first = await f.json(await f.api(f.token, '/direct-jobs', { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'synthetic-timeout', prompt: 'violin' }));
  await untilState(f, first.requestId, 'interrupted');
  expect((await f.api(f.token, '/direct-jobs', { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'while-running', prompt: 'violin' })).status).toBe(409);
  await untilState(f, first.requestId, 'ready'); expect(f.count()).toBe(1);
});
it('releases only a definite API queue-full 429 and requires a fresh explicit submission', async () => {
  const f = await fixture(); f.behavior.queueFull = true;
  const request = { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'queue-full', prompt: 'violin' };
  const first = await f.json(await f.api(f.token, '/direct-jobs', request)); await untilState(f, first.requestId, 'failed');
  expect((await f.json(await f.api(f.token, '/direct-jobs', request))).state).toBe('failed'); expect(f.count()).toBe(1);
  f.behavior.queueFull = false;
  const next = await f.json(await f.api(f.token, '/direct-jobs', { ...request, clientRequestId: 'new-explicit' }));
  await untilState(f, next.requestId, 'ready'); expect(f.count()).toBe(2);
});
it('keeps a nonmatching 429 submission outcome unknown', async () => {
  const f = await fixture(); f.behavior.ambiguous429 = true;
  const request = { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'ambiguous-429', prompt: 'violin' };
  const first = await f.json(await f.api(f.token, '/direct-jobs', request)); await untilState(f, first.requestId, 'interrupted');
  expect((await f.api(f.token, '/direct-jobs', { ...request, clientRequestId: 'different' })).status).toBe(409); expect(f.count()).toBe(1);
});
it('recovers a successful task after transient WAV download failure without new inference', async () => {
  const f = await fixture(); f.behavior.downloadFailures = 1;
  const request = { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'audio-temporary', prompt: 'violin' };
  const first = await f.json(await f.api(f.token, '/direct-jobs', request)); await untilState(f, first.requestId, 'interrupted');
  expect((await f.api(f.token, '/direct-jobs', { ...request, clientRequestId: 'during-download' })).status).toBe(409);
  await untilState(f, first.requestId, 'ready'); expect(f.count()).toBe(1);
});
it('releases a terminal API failure only when the inner task status confirms failure', async () => {
  const f = await fixture(); f.behavior.status = 2;
  const first = await f.json(await f.api(f.token, '/direct-jobs', { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'actual-fail', prompt: 'violin' }));
  await untilState(f, first.requestId, 'failed'); expect(f.count()).toBe(1);
});

it('does not publish a delayed audio response after operator reconciliation', async () => {
  const f = await fixture(); f.behavior.downloadFailures = 1; f.behavior.holdAudio = true;
  const first = await f.json(await f.api(f.token, '/direct-jobs', { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'delayed-audio', prompt: 'violin' }));
  await untilState(f, first.requestId, 'interrupted'); await expect.poll(() => f.behavior.heldAudios, { timeout: 5000 }).toBe(1);
  expect((await f.api(f.service.controlToken, `/direct-jobs/${first.requestId}/reconcile`, { backendStopped: true })).status).toBe(200);
  f.releaseAudio(); await new Promise(resolve => setTimeout(resolve, 250));
  const result = await f.json(await f.api(f.token, `/direct-jobs/${first.requestId}`)); expect(result.state).toBe('failed'); expect(result.resultId).toBeUndefined(); expect(f.count()).toBe(1);
  expect((await f.json(await f.api(f.token, `/results?sessionId=${f.sessionId}`))).results).toEqual([]);
});
it('preserves an earlier result and resumes download of the known task after restart', async () => {
  const f = await fixture();
  const request = { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'preserved', prompt: 'violin' };
  const old = await f.json(await f.api(f.token, '/direct-jobs', request)); await untilState(f, old.requestId, 'ready');
  const oldResult = await f.json(await f.api(f.token, `/direct-jobs/${old.requestId}`));
  f.behavior.downloadFailures = 1000;
  const next = await f.json(await f.api(f.token, '/direct-jobs', { ...request, clientRequestId: 'resume-download' })); await untilState(f, next.requestId, 'interrupted');
  expect((await f.api(f.token, `/results/${oldResult.resultId}`)).status).toBe(200);
  await f.service.close(); f.behavior.downloadFailures = 0;
  const restarted = await createBridgeService({ root: f.root, port: 0, apiUrl: f.apiUrl }); cleanup.push(() => restarted.close());
  const get = () => fetch(`${restarted.url}/direct-jobs/${next.requestId}`, { headers: { Authorization: `Bearer ${f.token}` } }).then(r => r.json());
  await expect.poll(async () => (await get()).state, { timeout: 5000 }).toBe('ready'); expect(f.count()).toBe(2);
  const oldAfter = await fetch(`${restarted.url}/results/${oldResult.resultId}`, { headers: { Authorization: `Bearer ${f.token}` } }); expect(oldAfter.status).toBe(200);
});

it('fails permanently when completed audio download returns a non-transient HTTP error', async () => {
  const f = await fixture(); f.behavior.downloadFailures = 1; f.behavior.downloadCode = 404;
  const request = { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'audio-404', prompt: 'violin' };
  const first = await f.json(await f.api(f.token, '/direct-jobs', request)); await untilState(f, first.requestId, 'failed');
  expect(f.count()).toBe(1); expect((await f.api(f.token, '/direct-jobs', { ...request, clientRequestId: 'after-404' })).status).toBe(200);
});
it('rejects malformed completed WAV without retry and releases occupancy', async () => {
  const f = await fixture(); f.behavior.invalidWav = true;
  const request = { sessionId: f.sessionId, captureId: f.captureId, clientRequestId: 'audio-invalid', prompt: 'violin' };
  const first = await f.json(await f.api(f.token, '/direct-jobs', request)); await untilState(f, first.requestId, 'failed');
  expect(f.count()).toBe(1); expect((await f.api(f.token, '/direct-jobs', { ...request, clientRequestId: 'after-invalid' })).status).toBe(200);
});
