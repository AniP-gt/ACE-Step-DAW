import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { downloadAudio, queryResult, releaseLegoTask, setBackendUrl } from '../../src/services/aceStepApi';
import type { LegoTaskParams } from '../../src/types/api';

const params: LegoTaskParams = { task_type: 'lego', track_name: 'bass', prompt: 'bass', global_caption: '', lyrics: '', instruction: 'bass', repainting_start: 0, repainting_end: 1, audio_duration: 1, bpm: 120, key_scale: '', time_signature: '4/4', inference_steps: 32, guidance_scale: 7, shift: 3, batch_size: 1, audio_format: 'wav', thinking: false, model: 'base' };
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
});
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); for (const close of cleanup.splice(0).reverse()) await close(); });

it.each([true, false, undefined])('preserves canonical WAV bytes only when preserveSourceAudio=%s', async (preserveSourceAudio) => {
  // Two seconds of antiphase stereo exceeds the upload optimization threshold.
  const canonical = Buffer.alloc(44 + 96000 * 8);
  canonical.write('RIFF', 0);
  canonical.writeUInt32LE(canonical.length - 8, 4);
  canonical.write('WAVEfmt ', 8);
  canonical.writeUInt32LE(16, 16);
  canonical.writeUInt16LE(3, 20);
  canonical.writeUInt16LE(2, 22);
  canonical.writeUInt32LE(48000, 24);
  canonical.writeUInt32LE(48000 * 8, 28);
  canonical.writeUInt16LE(8, 32);
  canonical.writeUInt16LE(32, 34);
  canonical.write('data', 36);
  canonical.writeUInt32LE(canonical.length - 44, 40);
  for (let frame = 0; frame < 96000; frame++) {
    const sample = 0.5 * Math.sin(2 * Math.PI * 440 * frame / 48000);
    canonical.writeFloatLE(sample, 44 + frame * 8);
    canonical.writeFloatLE(-sample, 48 + frame * 8);
  }

  // Node has no Web Audio. Model only the platform's stereo-to-mono mix;
  // the production downsampler, WAV encoder, fetch and multipart remain real.
  vi.stubGlobal('OfflineAudioContext', class {
    constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {}
    readonly destination = {};
    async decodeAudioData(bytes: ArrayBuffer) {
      const wav = new DataView(bytes);
      return { duration: wav.getUint32(40, true) / wav.getUint32(28, true), sampleRate: wav.getUint32(24, true), numberOfChannels: wav.getUint16(22, true) };
    }
    createBufferSource() { return { buffer: undefined, connect() {}, start() {} }; }
    async startRendering() {
      return { numberOfChannels: this.numberOfChannels, sampleRate: this.sampleRate, length: this.length, getChannelData: () => new Float32Array(this.length) };
    }
  });

  let received: FormData | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': request.headers['content-type'] ?? '' } }).formData();
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: { task_id: 'canonical-upload' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  setBackendUrl(`http://127.0.0.1:${address.port}`);
  const referenceAudioBlob = new Blob([canonical], { type: 'audio/wav' });
  const options = { preserveSourceAudio, retrySubmission: false, referenceAudioBlob };

  await releaseLegoTask(referenceAudioBlob, params, options);

  const source = received?.get('src_audio');
  const reference = received?.get('reference_audio');
  if (!(source instanceof Blob) || !(reference instanceof Blob)) throw new Error('Missing uploaded WAV');
  const uploaded = Buffer.from(await source.arrayBuffer());
  const hash = createHash('sha256').update(uploaded).digest('hex');
  const canonicalHash = createHash('sha256').update(canonical).digest('hex');
  expect(createHash('sha256').update(Buffer.from(await reference.arrayBuffer())).digest('hex')).toBe(canonicalHash);
  if (preserveSourceAudio) {
    expect(hash).toBe(canonicalHash);
    expect([uploaded.readUInt16LE(20), uploaded.readUInt16LE(22), uploaded.readUInt32LE(24), uploaded.readUInt16LE(34)]).toEqual([3, 2, 48000, 32]);
  } else {
    expect(hash).not.toBe(canonicalHash);
    expect([uploaded.readUInt16LE(20), uploaded.readUInt16LE(22), uploaded.readUInt32LE(24), uploaded.readUInt16LE(34)]).toEqual([1, 1, 16000, 16]);
    expect(uploaded.subarray(44).equals(Buffer.alloc(32000 * 2))).toBe(true);
  }
});

it('does not submit again when an HTTP server accepts the full bridge request then drops its response', async () => {
  const accepted: string[] = [];
  const server = createServer(async (request) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    accepted.push(Buffer.concat(chunks).toString());
    request.socket.destroy();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  setBackendUrl(`http://127.0.0.1:${address.port}`);
  const options = { signal: new AbortController().signal, retrySubmission: false };
  await expect(releaseLegoTask(new Blob(['canonical reference']), params, options)).rejects.toBeInstanceOf(TypeError);
  expect(accepted).toHaveLength(1);
  expect(accepted[0]).toContain('canonical reference');
}, 10000);

it('preserves the three-attempt default for ordinary generation after transport failure', async () => {
  vi.useFakeTimers();
  const transport = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  vi.stubGlobal('fetch', transport);
  const rejected = expect(releaseLegoTask(new Blob(['reference']), params)).rejects.toThrow('Failed to fetch');
  await vi.advanceTimersByTimeAsync(6001);
  await rejected;
  expect(transport).toHaveBeenCalledTimes(3);
});

it('keeps download retries and independent result polling when submission retry is disabled', async () => {
  vi.useFakeTimers();
  const transport = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(new Response('audio'));
  vi.stubGlobal('fetch', transport);
  const options = { signal: new AbortController().signal, retrySubmission: false };
  const download = downloadAudio('/v1/audio', options);
  await vi.advanceTimersByTimeAsync(2001);
  expect(await (await download).text()).toBe('audio');
  expect(transport).toHaveBeenCalledTimes(2);
  transport.mockRejectedValueOnce(new TypeError('Lost poll response')).mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ task_id: 'known-task', status: 1 }] })));
  await expect(queryResult(['known-task'], options)).rejects.toThrow('Lost poll response');
  expect(await queryResult(['known-task'], options)).toEqual([{ task_id: 'known-task', status: 1 }]);
  expect(transport).toHaveBeenCalledTimes(4);
});
