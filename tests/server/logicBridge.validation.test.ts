import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeService } from '../../server/logic-bridge/service';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture(quotaBytes = 10 * 1024 ** 3) {
  const root = await mkdtemp(join(tmpdir(), 'logic-validation-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const service = await createBridgeService({ root, port: 0, quotaBytes });
  cleanup.push(() => service.close());
  const controlHeaders = { Authorization: `Bearer ${service.controlToken}`, 'X-Bridge-Protocol': '1', 'Content-Type': 'application/json' };
  const session = await (await fetch(`${service.url}/sessions`, { method: 'POST', headers: controlHeaders, body: JSON.stringify({ name: 'Validation' }) })).json();
  const pairing = await (await fetch(`${service.url}/pairings`, { method: 'POST', headers: controlHeaders, body: JSON.stringify({ sessionId: session.sessionId, role: 'native' }) })).json();
  const credential = await (await fetch(`${service.url}/pairings/claim`, { method: 'POST', headers: controlHeaders, body: JSON.stringify({ code: pairing.code }) })).json();
  const headers = { Authorization: `Bearer ${credential.token}`, 'X-Bridge-Protocol': '1', 'Content-Type': 'application/json' };
  const capture = (sampleRate = 48000, channels = 1, expectedFrames = sampleRate) => fetch(`${service.url}/captures`, { method: 'POST', headers, body: JSON.stringify({ sessionId: session.sessionId, instanceId: 'validation', sampleRate, channels, expectedFrames, hostStartSample: 0, tempo: 120, timeSignature: [4, 4] }) });
  return { ...service, root, headers, sessionId: session.sessionId, capture };
}

it('reserves quota for unfinished captures and rejects another capture without publishing assets', async () => {
  const service = await fixture(800000);
  expect((await service.capture()).status).toBe(200);
  const rejected = await service.capture();
  expect(rejected.status).toBe(413);
  expect(await rejected.json()).toMatchObject({ error: { code: 'QUOTA_EXCEEDED' } });
  const list = await (await fetch(`${service.url}/captures?sessionId=${service.sessionId}`, { headers: service.headers })).json();
  expect(list.captures).toHaveLength(1);
  expect(list.captures[0]).toMatchObject({ state: 'receiving', receivedFrames: 0 });
  expect(await readdir(join(service.root, 'assets'))).toEqual([]);
});

it.each([{ frames: 44105, quota: 560548, status: 200 }, { frames: 44106, quota: 560567, status: 413 }])('uses complete canonical frames at the quota boundary for $frames source frames', async ({ frames, quota, status }) => {
  const service = await fixture(quota);
  const response = await service.capture(44100, 1, frames);
  expect(response.status).toBe(status);
  if (status === 413) expect(await response.json()).toMatchObject({ error: { code: 'QUOTA_EXCEEDED' } });
});

it.each(['json', 'chunk'] as const)('rejects oversized %s requests before publishing assets', async kind => {
  const service = await fixture();
  const capture = await (await service.capture()).json();
  const bytes = Buffer.alloc(kind === 'json' ? 65537 : 1048577, 32);
  const response = await fetch(`${service.url}/captures/${capture.captureId}/${kind === 'json' ? 'finalize' : 'chunks/0'}`, {
    method: kind === 'json' ? 'POST' : 'PUT', headers: { ...service.headers, 'X-Start-Frame': '0', 'X-Chunk-SHA256': hash(bytes) }, body: bytes,
  });
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ error: { code: 'BODY_TOO_LARGE' } });
  expect(await readdir(join(service.root, 'assets'))).toEqual([]);
  expect(await readdir(join(service.root, 'staging'))).toEqual([]);
});

it.each([{ name: 'missing', start: undefined }, { name: 'empty', start: '' }, { name: 'nonnumeric', start: 'not-a-frame' }, { name: 'negative', start: '-1' }])('rejects $name chunk start header without accepting frames', async ({ start }) => {
  const service = await fixture();
  const capture = await (await service.capture()).json();
  const bytes = Buffer.alloc(4); bytes.writeFloatLE(0.5);
  const response = await fetch(`${service.url}/captures/${capture.captureId}/chunks/0`, {
    method: 'PUT', headers: { ...service.headers, 'X-Chunk-SHA256': hash(bytes), ...(start === undefined ? {} : { 'X-Start-Frame': start }) }, body: bytes,
  });
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.status).toBeLessThan(500);
  const list = await (await fetch(`${service.url}/captures?sessionId=${service.sessionId}`, { headers: service.headers })).json();
  expect(list.captures[0]).toMatchObject({ state: 'receiving', receivedFrames: 0 });
  expect(await readdir(join(service.root, 'staging'))).toEqual([]);
});

it.each(['..%2Foutside.wav', '%2e%2e%2foutside.wav', '%2Fetc%2Fpasswd'])('rejects an asset path instead of an asset ID: %s', async path => {
  const service = await fixture();
  await writeFile(join(service.root, 'outside.wav'), 'private sentinel');
  const response = await fetch(`${service.url}/assets/${path}`, { headers: service.headers });
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
});

async function exportingJob(service: Awaited<ReturnType<typeof fixture>>) {
  const capture = await (await service.capture()).json();
  const pcm = Buffer.alloc(48000 * 4); pcm.writeFloatLE(0.75, 12000 * 4);
  expect((await fetch(`${service.url}/captures/${capture.captureId}/chunks/0`, { method: 'PUT', headers: { ...service.headers, 'X-Start-Frame': '0', 'X-Chunk-SHA256': hash(pcm) }, body: pcm })).status).toBe(200);
  const source = await (await fetch(`${service.url}/captures/${capture.captureId}/finalize`, { method: 'POST', headers: service.headers, body: JSON.stringify({ sha256: hash(pcm) }) })).json();
  const controlHeaders = { ...service.headers, Authorization: `Bearer ${service.controlToken}` };
  const pairing = await (await fetch(`${service.url}/pairings`, { method: 'POST', headers: controlHeaders, body: JSON.stringify({ sessionId: service.sessionId, role: 'executor', projectId: 'validation-project' }) })).json();
  const executor = await (await fetch(`${service.url}/pairings/claim`, { method: 'POST', headers: controlHeaders, body: JSON.stringify({ code: pairing.code }) })).json();
  const headers = { ...service.headers, Authorization: `Bearer ${executor.token}`, 'X-Executor-Id': 'validation-executor' };
  expect((await fetch(`${service.url}/executor/register`, { method: 'POST', headers, body: JSON.stringify({ sessionId: service.sessionId, projectId: 'validation-project', executorId: 'validation-executor', modelId: 'base', instruments: ['bass'], outputSemantics: 'isolated-layer' }) })).status).toBe(200);
  const binding = await (await fetch(`${service.url}/bindings`, { method: 'POST', headers, body: JSON.stringify({ sessionId: service.sessionId, projectId: 'validation-project', captureId: source.captureId, clipId: 'reference', clientRequestId: 'binding' }) })).json();
  const job = await (await fetch(`${service.url}/jobs`, { method: 'POST', headers, body: JSON.stringify({ sessionId: service.sessionId, projectId: 'validation-project', captureId: source.captureId, bindingId: binding.bindingId, clientRequestId: 'job', instrument: 'bass', startFrame: 0, endFrame: 24000, modelId: 'base' }) })).json();
  for (const state of ['dispatched', 'running', 'exporting']) expect((await fetch(`${service.url}/jobs/${job.jobId}/transition`, { method: 'POST', headers, body: JSON.stringify({ state }) })).status).toBe(200);
  const canonical = Buffer.from(await (await fetch(`${service.url}/assets/${source.canonicalAssetId}`, { headers })).arrayBuffer());
  const output = Buffer.from(canonical.subarray(0, 44 + 24000 * 8));
  output.writeUInt32LE(output.length - 8, 4); output.writeUInt32LE(output.length - 44, 40);
  return { jobId: job.jobId, headers, output };
}

it.each([{ field: 'RIFF size', offset: 4 }, { field: 'byte rate', offset: 28 }, { field: 'block alignment', offset: 32 }])('rejects a result with inconsistent $field before publication', async ({ offset }) => {
  const service = await fixture(); const job = await exportingJob(service);
  job.output.writeUInt16LE(0, offset);
  const rejected = await fetch(`${service.url}/jobs/${job.jobId}/result`, { method: 'POST', headers: job.headers, body: job.output });
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toMatchObject({ error: { code: 'INVALID_RESULT' } });
  const current = await (await fetch(`${service.url}/jobs/${job.jobId}`, { headers: job.headers })).json();
  expect(current.state).toBe('exporting'); expect(current.resultId).toBeUndefined();
  expect(await readdir(join(service.root, 'assets'))).toHaveLength(2);
});

it('preserves receiving capture reservations when publishing a generation result', async () => {
  const service = await fixture(1200000); const job = await exportingJob(service);
  expect((await service.capture()).status).toBe(200);
  const rejected = await fetch(`${service.url}/jobs/${job.jobId}/result`, { method: 'POST', headers: job.headers, body: job.output });
  expect(rejected.status).toBe(413);
  expect(await rejected.json()).toMatchObject({ error: { code: 'QUOTA_EXCEEDED' } });
  const current = await (await fetch(`${service.url}/jobs/${job.jobId}`, { headers: job.headers })).json();
  expect(current.state).toBe('exporting'); expect(current.resultId).toBeUndefined();
  expect(await readdir(join(service.root, 'assets'))).toHaveLength(2);
});

it.each([44100, 48000, 88200, 96000].flatMap(rate => [1, 2].map(channels => ({ rate, channels }))))('preserves impulse timing and channel identity at $rate Hz / $channels channels', async ({ rate, channels }) => {
  const service = await fixture();
  const capture = await (await service.capture(rate, channels)).json();
  const pcm = Buffer.alloc(rate * channels * 4);
  pcm.writeFloatLE(0.75, rate / 4 * channels * 4);
  if (channels === 2) pcm.writeFloatLE(-0.5, (rate * 3 / 4 * channels + 1) * 4);
  const upload = await fetch(`${service.url}/captures/${capture.captureId}/chunks/0`, { method: 'PUT', headers: { ...service.headers, 'X-Start-Frame': '0', 'X-Chunk-SHA256': hash(pcm) }, body: pcm });
  expect(upload.status).toBe(200);
  const finalized = await fetch(`${service.url}/captures/${capture.captureId}/finalize`, { method: 'POST', headers: service.headers, body: JSON.stringify({ sha256: hash(pcm) }) });
  expect(finalized.status).toBe(200);
  const ready = await finalized.json();
  expect(ready).toMatchObject({ state: 'ready', canonicalFrameCount: 48000 });
  const asset = await fetch(`${service.url}/assets/${ready.canonicalAssetId}`, { headers: service.headers });
  expect(asset.status).toBe(200);
  const wav = Buffer.from(await asset.arrayBuffer());
  expect(wav.length).toBe(44 + 48000 * 8);
  expect(wav.readUInt32LE(24)).toBe(48000);
  expect(wav.readUInt16LE(22)).toBe(2);
  for (const channel of [0, 1]) {
    let peakFrame = -1; let peak = 0;
    for (let frame = 0; frame < 48000; frame++) {
      const value = wav.readFloatLE(44 + frame * 8 + channel * 4);
      if (Math.abs(value) > Math.abs(peak)) { peak = value; peakFrame = frame; }
    }
    expect(Math.abs(peakFrame - (channels === 2 && channel === 1 ? 36000 : 12000))).toBeLessThanOrEqual(1);
    expect(Math.sign(peak)).toBe(channels === 2 && channel === 1 ? -1 : 1);
    if (rate === 48000) expect(peak).toBe(channels === 2 && channel === 1 ? -0.5 : 0.75);
  }
  expect(hash(wav)).toBe(ready.canonicalSha256);
});

it('preserves a 96kHz impulse between canonical sample positions within one output frame', async () => {
  const service = await fixture();
  const capture = await (await service.capture(96000, 1)).json();
  const pcm = Buffer.alloc(96000 * 4); pcm.writeFloatLE(0.75, 12345 * 4);
  expect((await fetch(`${service.url}/captures/${capture.captureId}/chunks/0`, { method: 'PUT', headers: { ...service.headers, 'X-Start-Frame': '0', 'X-Chunk-SHA256': hash(pcm) }, body: pcm })).status).toBe(200);
  const finalized = await fetch(`${service.url}/captures/${capture.captureId}/finalize`, { method: 'POST', headers: service.headers, body: JSON.stringify({ sha256: hash(pcm) }) });
  expect(finalized.status).toBe(200);
  const ready = await finalized.json();
  expect(ready).toMatchObject({ state: 'ready', canonicalFrameCount: 48000 });
  const asset = await fetch(`${service.url}/assets/${ready.canonicalAssetId}`, { headers: service.headers });
  expect(asset.status).toBe(200);
  const wav = Buffer.from(await asset.arrayBuffer());
  let peakFrame = -1; let peak = 0;
  for (let frame = 0; frame < 48000; frame++) {
    const value = Math.abs(wav.readFloatLE(44 + frame * 8));
    if (value > peak) { peak = value; peakFrame = frame; }
  }
  expect(peak).toBeGreaterThan(0);
  expect(Math.abs(peakFrame - 6173)).toBeLessThanOrEqual(1);
});
