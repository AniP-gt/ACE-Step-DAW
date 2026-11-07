import { randomUUID } from 'node:crypto';
import { appendFile, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BridgeCapture } from '../../shared/logic-bridge/types';
import type { BridgeState } from './storage';
import { canonicalize, hash, wav } from './audio';
import { check, integer, number, string } from './validation';
export function createCapture(data: Record<string, unknown>, state: BridgeState, quota: number): BridgeCapture {
  const sampleRate = integer(data, 'sampleRate');
  const channels = integer(data, 'channels');
  const expectedFrames = integer(data, 'expectedFrames');
  check([44100, 48000, 88200, 96000].includes(sampleRate) && [1, 2].includes(channels), 'UNSUPPORTED_FORMAT', 'Unsupported rate or layout');
  check(expectedFrames >= sampleRate && expectedFrames <= sampleRate * 120, 'INVALID_DURATION', 'Capture must be 1 to 120 seconds');
  const reserved = state.captures.filter(capture => capture.state === 'receiving').reduce((sum, capture) => sum + capture.expectedFrames * (capture.channels * 4 + 8 * 48000 / capture.sampleRate) + 88, 0);
  check(state.assets.reduce((sum, asset) => sum + asset.size, 0) + reserved + expectedFrames * (channels * 4 + 8 * 48000 / sampleRate) + 88 <= quota, 'QUOTA_EXCEEDED', 'Insufficient bridge quota', 413);
  const meter = data.timeSignature;
  check(Array.isArray(meter) && meter.length === 2 && meter.every(value => Number.isSafeInteger(value) && value > 0), 'INVALID_METER', 'Invalid timeSignature');
  const tempo = number(data, 'tempo');
  check(tempo > 0 && tempo <= 999, 'INVALID_TEMPO', 'Invalid tempo');
  return { captureId: randomUUID(), sessionId: string(data, 'sessionId'), instanceId: string(data, 'instanceId'), label: string(data, 'label', 'Logic capture'), sampleRate, channels, expectedFrames, receivedFrames: 0, hostStartSample: integer(data, 'hostStartSample'), tempo, timeSignature: meter, state: 'receiving', chunks: [] };
}
export async function appendChunk(root: string, capture: BridgeCapture, input: { sequence: number; startFrame: number; sha256: string; bytes: Buffer }): Promise<BridgeCapture> {
  check(capture.state === 'receiving', 'CAPTURE_CLOSED', 'Capture no longer accepts chunks', 409);
  check(input.bytes.length > 0 && input.bytes.length <= 1048576 && input.bytes.length % (capture.channels * 4) === 0, 'INVALID_CHUNK', 'Invalid chunk size');
  check(hash(input.bytes) === input.sha256, 'HASH_MISMATCH', 'Chunk checksum mismatch');
  const previous = capture.chunks[input.sequence];
  if (previous) {
    const expectedStart = capture.chunks.slice(0, input.sequence).reduce((sum, chunk) => sum + chunk.frames, 0);
    check(previous.sha256 === input.sha256 && input.startFrame === expectedStart, 'CHUNK_CONFLICT', 'Conflicting retry', 409);
    return capture;
  }
  check(input.sequence === capture.chunks.length && input.startFrame === capture.receivedFrames, 'CHUNK_ORDER', 'Chunks must be contiguous', 409);
  const frames = input.bytes.length / (capture.channels * 4);
  check(capture.receivedFrames + frames <= capture.expectedFrames, 'FRAME_LIMIT', 'Too many frames');
  await appendFile(join(root, 'staging', capture.captureId), input.bytes, { mode: 0o600 });
  return { ...capture, receivedFrames: capture.receivedFrames + frames, chunks: [...capture.chunks, { sha256: input.sha256, frames }] };
}
export async function finalize(root: string, capture: BridgeCapture, sha256: string, state: BridgeState): Promise<BridgeCapture> {
  check(capture.state === 'receiving' && capture.receivedFrames === capture.expectedFrames, 'INCOMPLETE_CAPTURE', 'Capture is incomplete', 409);
  const pcm = await readFile(join(root, 'staging', capture.captureId));
  check(hash(pcm) === sha256, 'HASH_MISMATCH', 'Stream checksum mismatch');
  const canonical = canonicalize(pcm, capture.sampleRate, capture.channels);
  const original = wav(pcm, capture.sampleRate, capture.channels);
  const originalAssetId = randomUUID();
  const canonicalAssetId = randomUUID();
  await writeFile(join(root, 'assets', originalAssetId), original, { mode: 0o600 });
  await writeFile(join(root, 'assets', canonicalAssetId), canonical, { mode: 0o600 });
  await rm(join(root, 'staging', capture.captureId), { force: true });
  state.assets.push({ assetId: originalAssetId, sessionId: capture.sessionId, sha256: hash(original), size: original.length }, { assetId: canonicalAssetId, sessionId: capture.sessionId, sha256: hash(canonical), size: canonical.length });
  return { ...capture, state: 'ready', originalPcmSha256: sha256, originalAssetId, canonicalAssetId, canonicalSha256: hash(canonical), canonicalFrameCount: (canonical.length - 44) / 8 };
}
