import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, appendFile, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeService } from '../../server/logic-bridge/service';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'logic-bridge-'));
  cleanup.push(async () => { await rm(root, { recursive: true, force: true }); await expect(access(root)).rejects.toThrow(); if (process.env.BRIDGE_TEST_RESOURCE_LOG) await appendFile(process.env.BRIDGE_TEST_RESOURCE_LOG, JSON.stringify({ phase: 'root-absent', root }) + '\n'); });
  const reserve = createServer();
  await new Promise<void>((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
  const address = reserve.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
  const port = address.port;
  if (process.env.BRIDGE_TEST_RESOURCE_LOG) await appendFile(process.env.BRIDGE_TEST_RESOURCE_LOG, JSON.stringify({ phase: 'registered', root, port }) + '\n');
  await new Promise<void>((resolve, reject) => reserve.close(error => error ? reject(error) : resolve()));
  const service = await createBridgeService({ root, port });
  cleanup.push(async () => {
    await service.close();
    const probe = createServer();
    await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
    await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    if (process.env.BRIDGE_TEST_RESOURCE_LOG) await appendFile(process.env.BRIDGE_TEST_RESOURCE_LOG, JSON.stringify({ phase: 'rebound', root, port }) + '\n');
  });
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

it('prepares a reference and submits a deduplicated native intent only after executor acknowledgement', async () => {
  const service = await fixture(); const source = await captured(service); const executor = await paired(service, 'executor', source.sessionId);
  const register = { sessionId: source.sessionId, projectId: 'project-a', executorId: 'executor-a', modelId: 'fixture-base', instruments: ['piano'], outputSemantics: 'isolated-layer' };
  expect((await api(service, executor.token, '/executor/register', register)).status).toBe(200);
  const prepare = { sessionId: source.sessionId, kind: 'prepare', clientRequestId: 'prepare-1', captureId: source.capture.captureId };
  const first = await json(await api(service, source.token, '/native-requests', prepare));
  expect(first.state).toBe('pending'); expect(first.projectId).toBe('project-a');
  expect(JSON.stringify(first)).not.toMatch(/ownerCredentialHash|payloadFingerprint|jobClientRequestId|clientRequestId/);
  expect((await json(await api(service, source.token, '/native-requests', prepare))).requestId).toBe(first.requestId);
  expect((await api(service, source.token, '/native-requests', { ...prepare, captureId: 'other' })).status).toBe(409);
  const binding = await json(await api(service, executor.token, '/bindings', { sessionId: source.sessionId, projectId: 'project-a', captureId: source.capture.captureId, clipId: 'clip-a', clientRequestId: 'bind-a' }));
  expect((await api(service, executor.token, `/native-requests/${first.requestId}/prepared`, { sessionId: source.sessionId, bindingId: binding.bindingId })).status).toBe(200);
  const intent = { sessionId: source.sessionId, kind: 'generation', clientRequestId: 'job-a', preparedRequestId: first.requestId, instrument: 'piano', prompt: ' ' };
  const pending = await json(await api(service, source.token, '/native-requests', intent)); expect(pending.state).toBe('pending');
  expect((await json(await api(service, executor.token, `/executor/jobs?sessionId=${source.sessionId}`))).jobs).toEqual([]);
  const submitted = await json(await api(service, executor.token, `/native-requests/${pending.requestId}/submit`, { sessionId: source.sessionId }));
  expect(submitted.state).toBe('submitted'); expect(submitted.jobId).toBeTruthy(); expect(submitted.prompt).toBe('Add an instrumental layer');
  expect((await json(await api(service, executor.token, `/executor/jobs?sessionId=${source.sessionId}`))).jobs).toEqual([expect.objectContaining({ jobId: submitted.jobId, nativePreparedRequestId: first.requestId })]);
  expect((await json(await api(service, executor.token, `/native-requests/${pending.requestId}/submit`, { sessionId: source.sessionId }))).jobId).toBe(submitted.jobId);
  expect((await json(await api(service, source.token, '/native-requests', intent))).requestId).toBe(pending.requestId);
});

it('checks capabilities, prompt bounds, poll lease and queued cancellation', async () => {
  const service = await fixture(); const source = await captured(service); const executor = await paired(service, 'executor', source.sessionId);
  const register = { sessionId: source.sessionId, projectId: 'project-a', executorId: 'executor-a', modelId: '', instruments: [] as string[] };
  await api(service, executor.token, '/executor/register', register);
  const prep = await json(await api(service, source.token, '/native-requests', { sessionId: source.sessionId, kind: 'prepare', clientRequestId: 'p', captureId: source.capture.captureId }));
  const poll = await json(await api(service, executor.token, `/executor/native-requests?sessionId=${source.sessionId}`)); expect(poll.requests).toHaveLength(1);
  const wrongLease = await fetch(`${service.url}/executor/native-requests?sessionId=${source.sessionId}`, { headers: { Authorization: `Bearer ${executor.token}`, 'X-Executor-Id': 'wrong' } }); expect(wrongLease.status).toBe(409);
  const binding = await json(await api(service, executor.token, '/bindings', { sessionId: source.sessionId, projectId: 'project-a', captureId: source.capture.captureId, clipId: 'clip', clientRequestId: 'binding' }));
  await api(service, executor.token, `/native-requests/${prep.requestId}/prepared`, { sessionId: source.sessionId, bindingId: binding.bindingId });
  const body = { sessionId: source.sessionId, kind: 'generation', clientRequestId: 'g', preparedRequestId: prep.requestId, instrument: 'piano', prompt: 'x'.repeat(4096) };
  expect((await api(service, source.token, '/native-requests', body)).status).toBe(409);
  await api(service, executor.token, '/executor/register', { ...register, modelId: 'base', instruments: ['piano'], outputSemantics: 'isolated-layer' });
  expect((await api(service, source.token, '/native-requests', { ...body, prompt: 'x'.repeat(4097) })).status).toBe(400);
  const intent = await json(await api(service, source.token, '/native-requests', body)); expect(intent.state).toBe('pending');
  await api(service, executor.token, '/executor/register', register);
  expect((await api(service, executor.token, `/native-requests/${intent.requestId}/submit`, { sessionId: source.sessionId })).status).toBe(400);
  await api(service, executor.token, '/executor/register', { ...register, modelId: 'base', instruments: ['piano'], outputSemantics: 'isolated-layer' });
  const submitted = await json(await api(service, executor.token, `/native-requests/${intent.requestId}/submit`, { sessionId: source.sessionId })); expect(submitted.state).toBe('submitted');
  await api(service, source.token, `/native-requests/${intent.requestId}/cancel`, {});
  const job = await json(await api(service, executor.token, `/jobs/${submitted.jobId}`)); expect(job.state).toBe('canceled'); expect(job.backendOccupancy).toBe('released');
});

it('invalidates prepared references idempotently and prevents a linked intent from creating a job', async () => {
  const service = await fixture(); const source = await captured(service); const executor = await paired(service, 'executor', source.sessionId);
  await api(service, executor.token, '/executor/register', { sessionId: source.sessionId, projectId: 'project-a', executorId: 'executor-a', modelId: 'base', instruments: ['piano'], outputSemantics: 'isolated-layer' });
  const prep = await json(await api(service, source.token, '/native-requests', { sessionId: source.sessionId, kind: 'prepare', clientRequestId: 'p', captureId: source.capture.captureId }));
  const binding = await json(await api(service, executor.token, '/bindings', { sessionId: source.sessionId, projectId: 'project-a', captureId: source.capture.captureId, clipId: 'clip', clientRequestId: 'bind' }));
  await api(service, executor.token, `/native-requests/${prep.requestId}/prepared`, { sessionId: source.sessionId, bindingId: binding.bindingId });
  const intent = await json(await api(service, source.token, '/native-requests', { sessionId: source.sessionId, kind: 'generation', clientRequestId: 'g', preparedRequestId: prep.requestId, instrument: 'piano' }));
  expect((await json(await api(service, executor.token, `/executor/native-requests?sessionId=${source.sessionId}`))).requests).toEqual(expect.arrayContaining([expect.objectContaining({ requestId: prep.requestId, state: 'prepared' })]));
  const body = { sessionId: source.sessionId, error: 'STALE_BINDING' };
  expect((await api(service, source.token, `/native-requests/${prep.requestId}/invalidate`, body)).status).toBe(403);
  expect((await api(service, executor.token, `/native-requests/${prep.requestId}/invalidate`, body)).status).toBe(200);
  expect((await api(service, executor.token, `/native-requests/${prep.requestId}/invalidate`, body)).status).toBe(200);
  expect((await api(service, executor.token, `/native-requests/${intent.requestId}/submit`, { sessionId: source.sessionId })).status).toBe(409);
  expect((await json(await api(service, executor.token, `/executor/jobs?sessionId=${source.sessionId}`))).jobs).toEqual([]);
  expect(await json(await api(service, source.token, `/native-readiness?sessionId=${source.sessionId}`))).toMatchObject({ ready: false, reason: 'STALE_BINDING' });
});

it('does not fall back to an older prepared reference after the latest preparation fails', async () => {
  const service = await fixture(); const source = await captured(service); const executor = await paired(service, 'executor', source.sessionId);
  await api(service, executor.token, '/executor/register', { sessionId: source.sessionId, projectId: 'project-a', executorId: 'executor-a', modelId: 'base', instruments: ['piano'], outputSemantics: 'isolated-layer' });
  const prepare = { sessionId: source.sessionId, kind: 'prepare', captureId: source.capture.captureId };
  const first = await json(await api(service, source.token, '/native-requests', { ...prepare, clientRequestId: 'first' }));
  const binding = await json(await api(service, executor.token, '/bindings', { sessionId: source.sessionId, projectId: 'project-a', captureId: source.capture.captureId, clipId: 'clip', clientRequestId: 'binding' }));
  await api(service, executor.token, `/native-requests/${first.requestId}/prepared`, { sessionId: source.sessionId, bindingId: binding.bindingId });
  const second = await json(await api(service, source.token, '/native-requests', { ...prepare, clientRequestId: 'second' }));
  await api(service, executor.token, `/native-requests/${second.requestId}/fail`, { sessionId: source.sessionId, error: 'IMPORT_FAILED' });
  expect(await json(await api(service, source.token, `/native-readiness?sessionId=${source.sessionId}`))).toMatchObject({ ready: false, preparedRequestId: second.requestId, reason: 'IMPORT_FAILED' });
  expect((await api(service, service.controlToken, `/native-requests/${first.requestId}/invalidate`, { sessionId: source.sessionId, error: 'STALE_BINDING' })).status).toBe(403);
});


async function preparedFixture() {
  const service = await fixture(); const source = await captured(service); const executor = await paired(service, 'executor', source.sessionId);
  await api(service, executor.token, '/executor/register', { sessionId: source.sessionId, projectId: 'project-a', executorId: 'executor-a', modelId: 'base', instruments: ['piano'], outputSemantics: 'isolated-layer' });
  const prepare = { sessionId: source.sessionId, kind: 'prepare', captureId: source.capture.captureId };
  const first = await json(await api(service, source.token, '/native-requests', { ...prepare, clientRequestId: 'first' }));
  const binding = await json(await api(service, executor.token, '/bindings', { sessionId: source.sessionId, projectId: 'project-a', captureId: source.capture.captureId, clipId: 'clip', clientRequestId: 'binding' }));
  expect((await api(service, executor.token, `/native-requests/${first.requestId}/prepared`, { sessionId: source.sessionId, bindingId: binding.bindingId })).status).toBe(200);
  return { service, source, executor, prepare, first };
}

it.each(['pending', 'failed', 'canceled'] as const)('rejects old references after a newer accepted prepare is %s', async status => {
  const { service, source, executor, prepare, first } = await preparedFixture();
  const second = await json(await api(service, source.token, '/native-requests', { ...prepare, clientRequestId: 'second' }));
  if (status === 'failed') expect((await api(service, executor.token, `/native-requests/${second.requestId}/fail`, { sessionId: source.sessionId, error: 'IMPORT_FAILED' })).status).toBe(200);
  if (status === 'canceled') expect((await api(service, source.token, `/native-requests/${second.requestId}/cancel`, {})).status).toBe(200);
  const response = await api(service, source.token, '/native-requests', { sessionId: source.sessionId, kind: 'generation', clientRequestId: 'new-intent', preparedRequestId: first.requestId, instrument: 'piano' });
  expect(response.status).toBe(409); expect(await json(response)).toMatchObject({ error: { code: 'STALE_BINDING' } });
  expect((await json(await api(service, executor.token, `/executor/jobs?sessionId=${source.sessionId}`))).jobs).toEqual([]);
});

it.each(['pending', 'failed', 'canceled'] as const)('does not submit an old pending intent after a replacement is %s and preserves its retry receipt', async status => {
  const { service, source, executor, prepare, first } = await preparedFixture();
  const payload = { sessionId: source.sessionId, kind: 'generation', clientRequestId: 'intent', preparedRequestId: first.requestId, instrument: 'piano' };
  const intent = await json(await api(service, source.token, '/native-requests', payload));
  const second = await json(await api(service, source.token, '/native-requests', { ...prepare, clientRequestId: 'second' }));
  if (status === 'failed') await api(service, executor.token, `/native-requests/${second.requestId}/fail`, { sessionId: source.sessionId, error: 'IMPORT_FAILED' });
  if (status === 'canceled') await api(service, source.token, `/native-requests/${second.requestId}/cancel`, {});
  expect((await json(await api(service, source.token, '/native-requests', payload))).requestId).toBe(intent.requestId);
  const submit = await api(service, executor.token, `/native-requests/${intent.requestId}/submit`, { sessionId: source.sessionId });
  expect(submit.status).toBe(409); expect(await json(submit)).toMatchObject({ error: { code: 'STALE_BINDING' } });
  expect((await json(await api(service, executor.token, `/executor/jobs?sessionId=${source.sessionId}`))).jobs).toEqual([]);
});

it('keeps a submitted receipt idempotent after a newer accepted prepare', async () => {
  const { service, source, executor, prepare, first } = await preparedFixture();
  const payload = { sessionId: source.sessionId, kind: 'generation', clientRequestId: 'intent', preparedRequestId: first.requestId, instrument: 'piano' };
  const intent = await json(await api(service, source.token, '/native-requests', payload));
  const submitted = await json(await api(service, executor.token, `/native-requests/${intent.requestId}/submit`, { sessionId: source.sessionId }));
  await api(service, source.token, '/native-requests', { ...prepare, clientRequestId: 'second' });
  expect(await json(await api(service, source.token, '/native-requests', payload))).toMatchObject({ requestId: intent.requestId, state: 'submitted', jobId: submitted.jobId });
  expect(await json(await api(service, executor.token, `/native-requests/${intent.requestId}/submit`, { sessionId: source.sessionId }))).toMatchObject({ state: 'submitted', jobId: submitted.jobId });
  expect((await json(await api(service, executor.token, `/executor/jobs?sessionId=${source.sessionId}`))).jobs).toHaveLength(1);
});

it('keeps the old prepared reference when a replacement was rejected or belongs to another owner', async () => {
  const { service, source, executor, prepare, first } = await preparedFixture();
  expect((await api(service, source.token, '/native-requests', { ...prepare, captureId: 'missing', clientRequestId: 'rejected' })).status).toBe(409);
  const other = await paired(service, 'native', source.sessionId);
  expect((await api(service, other.token, '/native-requests', { ...prepare, clientRequestId: 'other' })).status).toBe(200);
  const response = await api(service, source.token, '/native-requests', { sessionId: source.sessionId, kind: 'generation', clientRequestId: 'intent', preparedRequestId: first.requestId, instrument: 'piano' });
  expect(response.status).toBe(200);
  const intent = await json(response);
  expect((await api(service, executor.token, `/native-requests/${intent.requestId}/submit`, { sessionId: source.sessionId })).status).toBe(200);
});
