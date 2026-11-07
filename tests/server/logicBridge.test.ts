import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeService } from '../../server/logic-bridge/service';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'logic-bridge-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const service = await createBridgeService({ root, port: 0 });
  cleanup.push(() => service.close());
  return service;
}
it('requires authentication and protocol negotiation at the real HTTP boundary', async () => {
  const service = await fixture();
  expect((await fetch(`${service.url}/sessions`, { method: 'POST' })).status).toBe(401);
  expect((await fetch(`${service.url}/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${service.controlToken}` } })).status).toBe(426);
});

import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
const checksum = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function api(service: { url: string }, token: string, path: string, body?: unknown) {
  return fetch(`${service.url}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Bridge-Protocol': '1', 'Content-Type': 'application/json', 'X-Executor-Id': 'executor-a' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function json(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (typeof value !== 'object' || value === null) throw new Error('Expected JSON object');
  return Object.fromEntries(Object.entries(value));
}
async function paired(service: Awaited<ReturnType<typeof fixture>>, role = 'native', sessionId?: string) {
  const session = sessionId ?? String((await json(await api(service, service.controlToken, '/sessions', { name: 'Fixture session' }))).sessionId);
  const code = (await json(await api(service, service.controlToken, '/pairings', { sessionId: session, role, projectId: 'project-a' }))).code;
  const claim = await api(service, '', '/pairings/claim', { code });
  expect(claim.status).toBe(200);
  const credential = await json(claim);
  return { token: String(credential.token), sessionId: session, code };
}
async function captured(service: Awaited<ReturnType<typeof fixture>>) {
  const auth = await paired(service);
  const created = await json(await api(service, auth.token, '/captures', { sessionId: auth.sessionId, instanceId: 'native-instance', sampleRate: 48000, channels: 1, expectedFrames: 48000, hostStartSample: -24000, tempo: 120, timeSignature: [4, 4] }));
  const pcm = Buffer.alloc(48000 * 4); for (let i = 0; i < 48000; i++) pcm.writeFloatLE(i % 2 ? 0.25 : -0.25, i * 4);
  const path = `/captures/${created.captureId}`;
  const upload = () => fetch(`${service.url}${path}/chunks/0`, { method: 'PUT', headers: { Authorization: `Bearer ${auth.token}`, 'X-Bridge-Protocol': '1', 'X-Start-Frame': '0', 'X-Chunk-SHA256': checksum(pcm) }, body: pcm });
  expect((await upload()).status).toBe(200);
  expect((await upload()).status).toBe(200);
  const finalized = await api(service, auth.token, `${path}/finalize`, { sha256: checksum(pcm) });
  expect(finalized.status).toBe(200);
  return { ...auth, capture: await json(finalized), pcm };
}
it('enforces one-use pairing and session isolation', async () => {
  const service = await fixture(); const first = await paired(service); const second = await paired(service);
  expect((await api(service, '', '/pairings/claim', { code: first.code })).status).toBe(401);
  expect((await api(service, first.token, `/captures?sessionId=${second.sessionId}`)).status).toBe(403);
});
it('rejects untrusted HTTP Origin and Host', async () => {
  const service = await fixture();
  expect((await fetch(`${service.url}/health`, { headers: { Origin: 'https://attacker.invalid' } })).status).toBe(403);
  const status = await new Promise<number | undefined>((resolve, reject) => { const request = httpRequest(`${service.url}/health`, { headers: { Host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); request.end(); });
  expect(status).toBe(403);
});
it('persists exact canonical stereo source bytes and rejects foreign asset access', async () => {
  const service = await fixture(); const source = await captured(service); const stranger = await paired(service);
  const response = await api(service, source.token, `/assets/${source.capture.canonicalAssetId}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(bytes.length).toBe(48000 * 8 + 44);
  expect(bytes.readFloatLE(44)).toBe(-0.25); expect(bytes.readFloatLE(48)).toBe(-0.25); expect(bytes.readFloatLE(52)).toBe(0.25);
  expect(checksum(bytes)).toBe(source.capture.canonicalSha256);
  expect((await api(service, stranger.token, `/assets/${source.capture.canonicalAssetId}`)).status).toBe(403);
});
it.each(['bad-hash', 'gap', 'silence', 'nan'])('rejects corrupt capture scenario %s', async scenario => {
  const service = await fixture(); const auth = await paired(service);
  const capture = await json(await api(service, auth.token, '/captures', { sessionId: auth.sessionId, instanceId: 'instance', sampleRate: 48000, channels: 1, expectedFrames: 48000, hostStartSample: 0, tempo: 120, timeSignature: [4, 4] }));
  const pcm = Buffer.alloc(48000 * 4); if (scenario === 'nan') pcm.writeFloatLE(NaN);
  const upload = await fetch(`${service.url}/captures/${capture.captureId}/chunks/${scenario === 'gap' ? 1 : 0}`, { method: 'PUT', headers: { Authorization: `Bearer ${auth.token}`, 'X-Bridge-Protocol': '1', 'X-Start-Frame': '0', 'X-Chunk-SHA256': scenario === 'bad-hash' ? 'wrong' : checksum(pcm) }, body: pcm });
  if (scenario === 'gap' || scenario === 'bad-hash') expect(upload.status).toBe(scenario === 'gap' ? 409 : 400);
  else expect((await api(service, auth.token, `/captures/${capture.captureId}/finalize`, { sha256: checksum(pcm) })).status).toBe(400);
});
async function bound(service: Awaited<ReturnType<typeof fixture>>) {
  const source = await captured(service); const executor = await paired(service, 'executor', source.sessionId);
  expect((await api(service, executor.token, '/executor/register', { sessionId: source.sessionId, projectId: 'project-a', executorId: 'executor-a', modelId: 'fixture-base', instruments: ['piano'], outputSemantics: 'isolated-layer' })).status).toBe(200);
  const binding = await json(await api(service, executor.token, '/bindings', { sessionId: source.sessionId, projectId: 'project-a', captureId: source.capture.captureId, clipId: 'clip-a', clientRequestId: 'bind-a' }));
  return { ...source, executor, parameters: { sessionId: source.sessionId, projectId: 'project-a', captureId: source.capture.captureId, bindingId: binding.bindingId, clientRequestId: 'job-a', instrument: 'piano', startFrame: 12000, endFrame: 36000, prompt: 'piano', modelId: 'fixture-base' } };
}
it('deduplicates jobs, rejects conflicting retries and prevents late canceled publication', async () => {
  const service = await fixture(); const context = await bound(service);
  const first = await json(await api(service, context.executor.token, '/jobs', context.parameters));
  const retry = await json(await api(service, context.executor.token, '/jobs', context.parameters));
  expect(retry.jobId).toBe(first.jobId);
  expect((await api(service, context.executor.token, '/jobs', { ...context.parameters, prompt: 'different' })).status).toBe(409);
  expect((await json(await api(service, context.executor.token, `/jobs/${first.jobId}/cancel`, {}))).state).toBe('canceled');
  expect((await api(service, context.executor.token, `/jobs/${first.jobId}/transition`, { state: 'dispatched' })).status).toBe(409);
  expect((await fetch(`${service.url}/jobs/${first.jobId}/result`, { method: 'POST', headers: { Authorization: `Bearer ${context.executor.token}`, 'X-Bridge-Protocol': '1', 'X-Executor-Id': 'executor-a' }, body: Buffer.alloc(44) })).status).toBe(409);
});
it('validates the exact exported range and publishes persisted result placement', async () => {
  const service = await fixture(); const context = await bound(service);
  const job = await json(await api(service, context.executor.token, '/jobs', context.parameters));
  for (const state of ['dispatched', 'running', 'exporting']) expect((await api(service, context.executor.token, `/jobs/${job.jobId}/transition`, { state })).status).toBe(200);
  const source = Buffer.from(await (await api(service, context.token, `/assets/${context.capture.canonicalAssetId}`)).arrayBuffer());
  const output = Buffer.from(source.subarray(0, 44 + 24000 * 8)); output.writeUInt32LE(output.length - 8, 4); output.writeUInt32LE(output.length - 44, 40);
  const result = await fetch(`${service.url}/jobs/${job.jobId}/result`, { method: 'POST', headers: { Authorization: `Bearer ${context.executor.token}`, 'X-Bridge-Protocol': '1', 'X-Executor-Id': 'executor-a' }, body: output });
  expect(result.status).toBe(200); const ready = await json(result); expect(ready.state).toBe('ready');
  const metadata = await json(await api(service, context.token, `/results/${ready.resultId}`));
  expect(metadata.placementSeconds).toBe(-0.25); expect(metadata.frameCount).toBe(24000);
  expect((await json(await api(service, context.executor.token, `/jobs/${job.jobId}/cancel`, {}))).state).toBe('ready');
});
it('recovers pending jobs as interrupted and retains scoped credentials across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logic-restart-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const first = await createBridgeService({ root, port: 0 }); cleanup.push(() => first.close()); const context = await bound(first);
  const job = await json(await api(first, context.executor.token, '/jobs', context.parameters)); await first.close();
  const second = await createBridgeService({ root, port: 0 }); cleanup.push(() => second.close());
  expect((await json(await api(second, context.token, `/jobs/${job.jobId}`))).state).toBe('interrupted');
  expect((await readFile(join(root, 'journal.jsonl'), 'utf8')).includes('/v1/jobs')).toBe(true);
});
it('rejects a second writer for the same owned data directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logic-lock-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const first = await createBridgeService({ root, port: 0 }); cleanup.push(() => first.close());
  await expect(createBridgeService({ root, port: 0 })).rejects.toThrow('Service lock exists');
});
it('rejects a finalized capture retry with a different stream hash', async () => {
  const service = await fixture(); const source = await captured(service);
  expect((await api(service, source.token, `/captures/${source.capture.captureId}/finalize`, { sha256: 'different' })).status).toBe(409);
});
it('fails a formerly ready capture if its immutable audio is corrupt on restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logic-corrupt-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const first = await createBridgeService({ root, port: 0 }); cleanup.push(() => first.close()); const source = await captured(first); await first.close();
  await writeFile(join(root, 'assets', String(source.capture.canonicalAssetId)), 'corrupt');
  const second = await createBridgeService({ root, port: 0 }); cleanup.push(() => second.close());
  const snapshot = await json(await api(second, source.token, `/captures?sessionId=${source.sessionId}`));
  expect(snapshot.captures).toEqual([expect.objectContaining({ captureId: source.capture.captureId, state: 'failed' })]);
});
it('rejects Turbo capabilities and accepts browsing-only registration', async () => {
  const service = await fixture(); const executor = await paired(service, 'executor');
  const request = { sessionId: executor.sessionId, projectId: 'project-a', executorId: 'executor-a', modelId: '', instruments: [], outputSemantics: 'unverified' };
  expect((await api(service, executor.token, '/executor/register', request)).status).toBe(200);
  expect((await api(service, executor.token, '/executor/register', { ...request, modelId: 'acestep-turbo', instruments: ['piano'], outputSemantics: 'isolated-layer' })).status).toBe(409);
});
it('rejects stale executor identity even with a valid project credential', async () => {
  const service = await fixture(); const context = await bound(service);
  const response = await fetch(`${service.url}/executor/jobs?sessionId=${context.sessionId}`, { headers: { Authorization: `Bearer ${context.executor.token}`, 'X-Executor-Id': 'previous-executor' } });
  expect(response.status).toBe(409);
});
it.each(['mcp', 'executor'])('rejects a project-scoped %s credential canceling another project within the same session', async role => {
  const service = await fixture(); const context = await bound(service);
  const job = await json(await api(service, context.executor.token, '/jobs', context.parameters));
  const pairing = await json(await api(service, service.controlToken, '/pairings', { sessionId: context.sessionId, role, projectId: 'project-b' }));
  const foreign = await json(await api(service, '', '/pairings/claim', { code: pairing.code }));
  expect((await api(service, String(foreign.token), `/jobs/${job.jobId}/cancel`, {})).status).toBe(403);
  expect(await json(await api(service, context.executor.token, `/jobs/${job.jobId}`))).toMatchObject({ state: 'queued' });
});
it('permits native capture cancellation but forbids native generation cancellation', async () => {
  const service = await fixture(); const context = await bound(service);
  const job = await json(await api(service, context.executor.token, '/jobs', context.parameters));
  expect((await api(service, context.token, `/jobs/${job.jobId}/cancel`, {})).status).toBe(403);
  const capture = await json(await api(service, context.token, '/captures', { sessionId: context.sessionId, instanceId: 'cancel-native', sampleRate: 48000, channels: 1, expectedFrames: 48000, hostStartSample: 0, tempo: 120, timeSignature: [4, 4] }));
  expect((await api(service, context.token, `/captures/${capture.captureId}/cancel`, {})).status).toBe(200);
  expect(await json(await api(service, context.executor.token, `/jobs/${job.jobId}`))).toMatchObject({ state: 'queued' });
});
import { WebSocket } from 'ws';
import { once } from 'node:events';
it('authenticates WebSocket in its first frame and delivers capture notifications', async () => {
  const service = await fixture(); const auth = await paired(service);
  const socket = new WebSocket(service.url.replace('http:', 'ws:') + '/events');
  await once(socket, 'open');
  cleanup.push(async () => { socket.terminate(); });
  const received = once(socket, 'message');
  socket.send(JSON.stringify({ token: auth.token, protocolVersion: 1 }));
  const [message] = await received;
  expect(JSON.parse(String(message))).toMatchObject({ type: 'authenticated' });
  const next = once(socket, 'message');
  await api(service, auth.token, '/captures', { sessionId: auth.sessionId, instanceId: 'instance', sampleRate: 48000, channels: 1, expectedFrames: 48000, hostStartSample: 0, tempo: 120, timeSignature: [4, 4] });
  const [event] = await next;
  expect(JSON.parse(String(event))).toMatchObject({ sessionId: auth.sessionId });
});
it('persists uncertain submission as interrupted while retaining backend occupancy', async () => {
  const service = await fixture(); const context = await bound(service);
  const job = await json(await api(service, context.executor.token, '/jobs', context.parameters));
  await api(service, context.executor.token, `/jobs/${job.jobId}/transition`, { state: 'dispatched' });
  const interrupted = await api(service, context.executor.token, `/jobs/${job.jobId}/transition`, { state: 'interrupted', error: 'SUBMISSION_OUTCOME_UNKNOWN' });
  expect(interrupted.status).toBe(200);
  expect(await json(interrupted)).toMatchObject({ state: 'interrupted', backendOccupancy: 'unknown' });
  const blocked = await api(service, context.executor.token, '/jobs', { ...context.parameters, clientRequestId: 'replacement' });
  expect(await json(blocked)).toMatchObject({ error: { code: 'BACKEND_OUTCOME_UNKNOWN' } });
  expect((await api(service, context.executor.token, `/jobs/${job.jobId}/reconcile`, { backendStopped: true })).status).toBe(403);
  expect((await api(service, service.controlToken, `/jobs/${job.jobId}/reconcile`, { backendStopped: true })).status).toBe(200);
  expect((await api(service, context.executor.token, '/jobs', { ...context.parameters, clientRequestId: 'replacement' })).status).toBe(202);
});
it('expires crashed executor work without publishing late results or reissuing inference', async () => {
  const service = await fixture(); const context = await bound(service);
  const job = await json(await api(service, context.executor.token, '/jobs', context.parameters));
  await api(service, context.executor.token, `/jobs/${job.jobId}/transition`, { state: 'dispatched' });
  await api(service, context.executor.token, `/jobs/${job.jobId}/transition`, { state: 'running', backendTaskId: 'backend-task-1' });
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 31000);
  const snapshot = await json(await api(service, context.token, `/jobs/${job.jobId}`));
  expect(snapshot).toMatchObject({ state: 'interrupted', backendTaskId: 'backend-task-1', backendOccupancy: 'unknown' });
  const registration = { sessionId: context.sessionId, projectId: 'project-a', executorId: 'executor-new', modelId: 'fixture-base', instruments: ['piano'], outputSemantics: 'isolated-layer' };
  expect((await api(service, context.executor.token, '/executor/register', registration)).status).toBe(200);
  expect((await api(service, context.executor.token, `/jobs/${job.jobId}/transition`, { state: 'exporting' })).status).toBe(409);
  expect((await api(service, context.executor.token, '/jobs', { ...context.parameters, clientRequestId: 'new' })).status).toBe(409);
  const reconcile = await fetch(`${service.url}/jobs/${job.jobId}/reconcile`, { method: 'POST', headers: { Authorization: `Bearer ${context.executor.token}`, 'X-Bridge-Protocol': '1', 'X-Executor-Id': 'executor-new' }, body: JSON.stringify({ backendTaskId: 'backend-task-1', outcome: 'completed' }) });
  expect(reconcile.status).toBe(200);
  expect((await api(service, context.executor.token, '/jobs', { ...context.parameters, clientRequestId: 'new' })).status).toBe(202);
});
it('retains canceled backend occupancy until its matching terminal confirmation', async () => {
  const service = await fixture(); const context = await bound(service);
  const job = await json(await api(service, context.executor.token, '/jobs', context.parameters));
  await api(service, context.executor.token, `/jobs/${job.jobId}/transition`, { state: 'dispatched' });
  await api(service, context.executor.token, `/jobs/${job.jobId}/transition`, { state: 'running', backendTaskId: 'task-active' });
  await api(service, context.executor.token, `/jobs/${job.jobId}/cancel`, {});
  expect((await api(service, context.executor.token, '/jobs', { ...context.parameters, clientRequestId: 'second' })).status).toBe(409);
  expect((await api(service, context.executor.token, `/jobs/${job.jobId}/reconcile`, { backendTaskId: 'wrong-task', outcome: 'completed' })).status).toBe(409);
  expect((await api(service, context.executor.token, `/jobs/${job.jobId}/reconcile`, { backendTaskId: 'task-active', outcome: 'completed' })).status).toBe(200);
  expect((await json(await api(service, context.token, `/jobs/${job.jobId}`))).state).toBe('canceled');
  expect((await api(service, context.executor.token, '/jobs', { ...context.parameters, clientRequestId: 'second' })).status).toBe(202);
});
it('records late submission after cancellation without reviving publication', async () => {
  const service = await fixture(); const context = await bound(service);
  const job = await json(await api(service, context.executor.token, '/jobs', context.parameters));
  await api(service, context.executor.token, `/jobs/${job.jobId}/transition`, { state: 'dispatched' });
  await api(service, context.executor.token, `/jobs/${job.jobId}/cancel`, {});
  const receipt = await api(service, context.executor.token, `/jobs/${job.jobId}/submission`, { backendTaskId: 'late-task' });
  expect(receipt.status).toBe(200);
  expect(await json(receipt)).toMatchObject({ state: 'canceled', backendTaskId: 'late-task', backendOccupancy: 'unknown' });
  expect((await api(service, context.executor.token, `/jobs/${job.jobId}/submission`, { backendTaskId: 'different-task' })).status).toBe(409);
  expect((await api(service, context.executor.token, `/jobs/${job.jobId}/reconcile`, { backendTaskId: 'late-task', outcome: 'completed' })).status).toBe(200);
  expect((await api(service, context.executor.token, '/jobs', { ...context.parameters, clientRequestId: 'after-confirmed-terminal' })).status).toBe(202);
});
it('releases queued cancellation without requiring nonexistent backend confirmation', async () => {
  const service = await fixture(); const context = await bound(service);
  const job = await json(await api(service, context.executor.token, '/jobs', context.parameters));
  const canceled = await json(await api(service, context.executor.token, `/jobs/${job.jobId}/cancel`, {}));
  expect(canceled).toMatchObject({ state: 'canceled', backendOccupancy: 'released' });
  expect((await api(service, context.executor.token, '/jobs', { ...context.parameters, clientRequestId: 'after-queued-cancel' })).status).toBe(202);
});
it('retains unknown backend occupancy across service restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logic-occupancy-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const first = await createBridgeService({ root, port: 0 }); cleanup.push(() => first.close()); const context = await bound(first);
  const job = await json(await api(first, context.executor.token, '/jobs', context.parameters));
  await api(first, context.executor.token, `/jobs/${job.jobId}/transition`, { state: 'dispatched' });
  await api(first, context.executor.token, `/jobs/${job.jobId}/cancel`, {}); await first.close();
  const second = await createBridgeService({ root, port: 0 }); cleanup.push(() => second.close());
  expect(await json(await api(second, context.token, `/jobs/${job.jobId}`))).toMatchObject({ state: 'canceled', backendOccupancy: 'unknown' });
  await api(second, context.executor.token, '/executor/register', { sessionId: context.sessionId, projectId: 'project-a', executorId: 'executor-a', modelId: 'fixture-base', instruments: ['piano'], outputSemantics: 'isolated-layer' });
  const blocked = await api(second, context.executor.token, '/jobs', { ...context.parameters, clientRequestId: 'after-restart' });
  expect(await json(blocked)).toMatchObject({ error: { code: 'BACKEND_OUTCOME_UNKNOWN' } });
});
