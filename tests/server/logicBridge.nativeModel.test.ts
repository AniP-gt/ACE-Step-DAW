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


it('isolates owners and executor leases and recovers a retry after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-restart-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const service = await createBridgeService({ root, port: 0 }); cleanup.push(() => service.close());
  const source = await captured(service); const executor = await paired(service, 'executor', source.sessionId); const stranger = await paired(service, 'native', source.sessionId);
  const reg = { sessionId: source.sessionId, projectId: 'project-a', executorId: 'executor-a', instruments: [] };
  expect((await api(service, executor.token, '/executor/register', reg)).status).toBe(200);
  const body = { sessionId: source.sessionId, kind: 'prepare', clientRequestId: 'same', captureId: source.capture.captureId };
  const pending = await json(await api(service, source.token, '/native-requests', body)); expect(pending.state).toBe('pending');
  expect((await api(service, stranger.token, `/native-requests/${pending.requestId}`)).status).toBe(403);
  expect((await api(service, stranger.token, `/native-requests/${pending.requestId}/cancel`, {})).status).toBe(403);
  expect((await api(service, source.token, `/native-requests/${pending.requestId}/prepared`, { sessionId: source.sessionId, bindingId: 'forged' })).status).toBe(403);
  expect((await api(service, executor.token, `/native-requests/${pending.requestId}/prepared`, { sessionId: source.sessionId, bindingId: 'forged' })).status).toBe(409);
  await service.close(); const restarted = await createBridgeService({ root, port: 0 }); cleanup.push(() => restarted.close());
  expect((await json(await api(restarted, source.token, '/native-requests', body))).requestId).toBe(pending.requestId);
  expect((await api(restarted, executor.token, `/native-requests/${pending.requestId}/prepared`, { sessionId: source.sessionId, bindingId: 'forged' })).status).toBe(409);
});

it('retains unknown occupancy after cancel and isolates native IDs from ordinary jobs', async () => {
  const service = await fixture(); const source = await captured(service); const executor = await paired(service, 'executor', source.sessionId);
  const reg = { sessionId: source.sessionId, projectId: 'project-a', executorId: 'executor-a', modelId: 'base', instruments: ['piano'], outputSemantics: 'isolated-layer' };
  await api(service, executor.token, '/executor/register', reg);
  const binding = await json(await api(service, executor.token, '/bindings', { sessionId: source.sessionId, projectId: 'project-a', captureId: source.capture.captureId, clipId: 'clip-a', clientRequestId: 'bind' }));
  const prep = await json(await api(service, source.token, '/native-requests', { sessionId: source.sessionId, kind: 'prepare', clientRequestId: 'prep', captureId: source.capture.captureId }));
  await api(service, executor.token, `/native-requests/${prep.requestId}/prepared`, { sessionId: source.sessionId, bindingId: binding.bindingId });
  const ordinary = await json(await api(service, executor.token, '/jobs', { sessionId: source.sessionId, projectId: 'project-a', captureId: source.capture.captureId, bindingId: binding.bindingId, clientRequestId: 'collision', instrument: 'piano', startFrame: 0, endFrame: 48000, prompt: 'piano', modelId: 'base' }));
  await api(service, executor.token, `/jobs/${ordinary.jobId}/cancel`, {});
  const intent = await json(await api(service, source.token, '/native-requests', { sessionId: source.sessionId, kind: 'generation', clientRequestId: 'collision', preparedRequestId: prep.requestId, instrument: 'piano', prompt: 'piano' }));
  const submitted = await json(await api(service, executor.token, `/native-requests/${intent.requestId}/submit`, { sessionId: source.sessionId }));
  expect(submitted.jobId).not.toBe(ordinary.jobId);
  await api(service, executor.token, `/jobs/${submitted.jobId}/transition`, { state: 'dispatched' });
  await api(service, source.token, `/native-requests/${intent.requestId}/cancel`, {});
  const job = await json(await api(service, executor.token, `/jobs/${submitted.jobId}`)); expect(job.backendOccupancy).toBe('unknown');
  expect((await json(await api(service, source.token, `/native-readiness?sessionId=${source.sessionId}`))).ready).toBe(false);
});

it('allocates distinct receipt IDs for two native owners using the same caller ID', async () => {
  const service = await fixture(); const source = await captured(service); const other = await paired(service, 'native', source.sessionId); const executor = await paired(service, 'executor', source.sessionId);
  await api(service, executor.token, '/executor/register', { sessionId: source.sessionId, projectId: 'project-a', executorId: 'executor-a', instruments: [] });
  const body = { sessionId: source.sessionId, kind: 'prepare', clientRequestId: 'shared', captureId: source.capture.captureId };
  const first = await json(await api(service, source.token, '/native-requests', body)); const second = await json(await api(service, other.token, '/native-requests', body));
  expect(first.requestId).not.toBe(second.requestId); expect(first.requestId).not.toBe('shared');
  expect((await json(await api(service, source.token, '/native-requests', body))).requestId).toBe(first.requestId);
  expect((await json(await api(service, other.token, '/native-requests', body))).requestId).toBe(second.requestId);
});

it('keeps the pinned project when the executor lease expires and another project registers', async () => {
  const service = await fixture(); const source = await captured(service); const executor = await paired(service, 'executor', source.sessionId);
  const secondCode = await json(await api(service, service.controlToken, '/pairings', { sessionId: source.sessionId, role: 'executor', projectId: 'project-b' }));
  const second = await json(await api(service, '', '/pairings/claim', { code: secondCode.code }));
  await api(service, executor.token, '/executor/register', { sessionId: source.sessionId, projectId: 'project-a', executorId: 'executor-a', instruments: [] });
  const body = { sessionId: source.sessionId, kind: 'prepare', clientRequestId: 'project-test', captureId: source.capture.captureId };
  const pending = await json(await api(service, source.token, '/native-requests', body));
  const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 31000);
  try {
    expect((await api(service, String(second.token), '/executor/register', { sessionId: source.sessionId, projectId: 'project-b', executorId: 'executor-a', instruments: [] })).status).toBe(200);
    expect((await api(service, String(second.token), `/native-requests/${pending.requestId}/prepared`, { sessionId: source.sessionId, bindingId: 'forged' })).status).toBe(403);
    expect((await json(await api(service, source.token, '/native-requests', body))).projectId).toBe('project-a');
    expect((await json(await api(service, String(second.token), `/executor/native-requests?sessionId=${source.sessionId}`))).requests).toEqual([]);
  } finally { clock.mockRestore(); }
});

it('recovers a lost response by caller ID without crossing native owners', async () => {
  const service = await fixture(); const source = await captured(service); const other = await paired(service, 'native', source.sessionId); const executor = await paired(service, 'executor', source.sessionId);
  await api(service, executor.token, '/executor/register', { sessionId: source.sessionId, projectId: 'project-a', executorId: 'executor-a', instruments: [] });
  const body = { sessionId: source.sessionId, kind: 'prepare', clientRequestId: 'lost reply', captureId: source.capture.captureId };
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest(`${service.url}/native-requests`, { method: 'POST', headers: { Authorization: `Bearer ${source.token}`, 'X-Bridge-Protocol': '1', 'Content-Type': 'application/json' } }, response => { response.destroy(); resolve(); });
    request.on('error', reject); request.end(JSON.stringify(body));
  });
  const path = `/native-requests?sessionId=${encodeURIComponent(source.sessionId)}&clientRequestId=${encodeURIComponent(body.clientRequestId)}`;
  const accepted = await json(await api(service, source.token, path)); expect(accepted.state).toBe('pending');
  expect((await api(service, other.token, path)).status).toBe(404);
  const otherReceipt = await json(await api(service, other.token, '/native-requests', body));
  expect(otherReceipt.requestId).not.toBe(accepted.requestId);
  expect((await json(await api(service, other.token, path))).requestId).toBe(otherReceipt.requestId);
  expect((await api(service, executor.token, path)).status).toBe(403);
});
