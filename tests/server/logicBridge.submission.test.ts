import { createServer } from 'node:http';
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
