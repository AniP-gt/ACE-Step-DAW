import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { DirectCoverJob } from '../../shared/logic-bridge/types';
import type { BridgeState } from './storage';
import { hash } from './audio';
import { reservedCaptureBytes } from './captures';
import { canonicalCover } from './directCoverAudio';
import { BridgeError, check, object } from './validation';

type Transaction = <T>(fn: (state: BridgeState) => Promise<T> | T) => Promise<T>;
const maxAudio = 64 * 1024 * 1024;
function apiOrigin(value: string) {
  const url = new URL(value);
  check(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && (url.pathname === '/' || !url.pathname) && !url.search && !url.hash, 'INVALID_API_URL', 'ACE-Step API must use a loopback HTTP origin');
  return url.origin;
}
async function bounded(response: Response, limit: number): Promise<Buffer> {
  const parts: Buffer[] = []; let length = 0;
  check(response.body, 'API_RESPONSE_INVALID', 'Empty API response');
  const reader = response.body.getReader();
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; const chunk = Buffer.from(part.value); length += chunk.length; check(length <= limit, 'API_RESPONSE_TOO_LARGE', 'ACE-Step response exceeds limit'); parts.push(chunk); }
  } finally { reader.releaseLock(); }
  return Buffer.concat(parts);
}
async function responseObject(response: Response): Promise<Record<string, unknown>> {
  return object(JSON.parse((await bounded(response, 1024 * 1024)).toString('utf8')));
}
export function createDirectCoverWorker(options: { root: string; quota: number; apiUrl: string; apiKey?: string; transact: Transaction }) {
  const base = apiOrigin(options.apiUrl); const abort = new AbortController();
  const running = new Map<string, Promise<void>>(); let stopping = false;
  const request = (path: string, init: RequestInit = {}, timeout = 30000) => {
    const headers = new Headers(init.headers); if (options.apiKey) headers.set('Authorization', `Bearer ${options.apiKey}`);
    return fetch(base + path, { ...init, headers, redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeout)]) });
  };
  const patch = (id: string, fn: (job: DirectCoverJob) => DirectCoverJob) => options.transact(state => {
    const index = state.directCoverJobs.findIndex(item => item.requestId === id);
    check(index >= 0, 'NOT_FOUND', 'Direct job disappeared', 404);
    const current = state.directCoverJobs[index];
    if (current.backendOccupancy === 'released') return current;
    const job = fn(current); state.directCoverJobs[index] = job; return job;
  });
  async function poll(id: string, taskId: string) {
    let retryDelayMs = 1000;
    while (!stopping) {
      try {
      const current = await options.transact(state => state.directCoverJobs.find(job => job.requestId === id));
      if (!current || current.backendOccupancy === 'released' || current.backendTaskId !== taskId) return;
      const response = await request('/query_result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_id_list: [taskId] }) });
      check(response.ok, 'API_POLL_FAILED', `ACE-Step task lookup failed (HTTP ${response.status})`);
      const envelope = await responseObject(response); check(Array.isArray(envelope.data), 'API_RESPONSE_INVALID', 'Invalid task response');
      const entry = envelope.data.map(object).find(item => item.task_id === taskId);
      check(entry && [0, 1, 2].includes(Number(entry.status)), 'API_RESPONSE_INVALID', 'Task status unavailable');
      if (entry.status === 2) {
        // The API can synthesize outer status 2 while the embedded cache status is still 0.
        let confirmed = false;
        try {
          const detail: unknown = typeof entry.result === 'string' ? JSON.parse(entry.result) : entry.result;
          confirmed = Array.isArray(detail) && detail.length > 0 && detail.every(item => object(item).status === 2);
        } catch { /* Malformed status cannot establish a terminal backend outcome. */ }
        check(confirmed, 'API_STATUS_UNCERTAIN', 'ACE-Step task status does not confirm termination');
        await patch(id, job => ({ ...job, state: 'failed', backendOccupancy: 'released', error: 'ACE-Step generation failed' })); return;
      }
      if (entry.status === 1) {
        try {
          const result = typeof entry.result === 'string' ? JSON.parse(entry.result) : entry.result;
          check(Array.isArray(result) && result.length > 0, 'API_RESPONSE_INVALID', 'Completed task has no audio');
          const file = object(result[0]).file; check(typeof file === 'string' && file.length <= 8192, 'API_RESPONSE_INVALID', 'Completed task has no audio path');
          const url = new URL(file, base); check(url.origin === base && url.pathname === '/v1/audio' && !url.username && !url.password && url.searchParams.has('path'), 'API_RESPONSE_INVALID', 'Untrusted audio download URL');
          const audio = await request(url.pathname + url.search, {}, 120000);
          check(audio.ok || audio.status >= 500 || audio.status === 408 || audio.status === 429, 'API_DOWNLOAD_PERMANENT', `ACE-Step audio download failed (HTTP ${audio.status})`);
          check(audio.ok, 'API_DOWNLOAD_FAILED', `ACE-Step audio download failed (HTTP ${audio.status})`);
          const canonical = await canonicalCover(await bounded(audio, maxAudio));
          await options.transact(async state => {
            const index = state.directCoverJobs.findIndex(job => job.requestId === id); check(index >= 0, 'NOT_FOUND', 'Direct job disappeared', 404);
            const job = state.directCoverJobs[index];
            if (job.backendOccupancy === 'released' || job.backendTaskId !== taskId) return;
            const capture = state.captures.find(c => c.captureId === job.captureId && c.sessionId === job.sessionId);
            check(capture?.state === 'ready', 'SOURCE_UNAVAILABLE', 'Source capture disappeared', 409);
            check(state.assets.reduce((sum, item) => sum + item.size, 0) + reservedCaptureBytes(state) + canonical.length <= options.quota, 'QUOTA_EXCEEDED', 'Result quota exceeded', 413);
            const assetId = randomUUID(), resultId = randomUUID(), sha256 = hash(canonical), frameCount = (canonical.length - 44) / 8;
            await writeFile(join(options.root, 'assets', assetId), canonical, { mode: 0o600 });
            state.assets.push({ assetId, sessionId: job.sessionId, sha256, size: canonical.length });
            state.results.push({ resultId, sessionId: job.sessionId, jobId: job.requestId, assetId, sha256, frameCount, placementSeconds: capture.hostStartSample / capture.sampleRate });
            state.directCoverJobs[index] = { ...job, state: 'ready', backendOccupancy: 'released', resultId, error: undefined };
          });
        } catch (error) {
          if (stopping) throw error;
          // Invalid result data cannot be recovered by retrying transport; network and I/O failures can.
          const invalid = error instanceof SyntaxError || error instanceof TypeError && error.message.includes('Invalid URL') || error instanceof BridgeError && ['API_DOWNLOAD_PERMANENT', 'API_RESPONSE_INVALID', 'INVALID_BODY', 'INVALID_RESULT', 'INVALID_AUDIO', 'SILENT_AUDIO', 'API_RESPONSE_TOO_LARGE', 'QUOTA_EXCEEDED', 'SOURCE_UNAVAILABLE'].includes(error.code);
          if (!invalid) throw error;
          await patch(id, job => ({ ...job, state: 'failed', backendOccupancy: 'released', error: error instanceof Error ? error.message : 'Invalid Cover result' }));
        }
        return;
      }
      retryDelayMs = 1000;
      await patch(id, job => ({ ...job, state: 'running', backendOccupancy: 'occupied', error: undefined }));
      await delay(1000, undefined, { signal: abort.signal });
      } catch (error) {
        if (stopping) throw error;
        const message = error instanceof Error ? error.message : 'ACE-Step status lookup failed';
        const job = await patch(id, current => ({ ...current, state: 'interrupted', backendOccupancy: 'unknown', error: `Generation outcome unknown: ${message}` }));
        if (job.backendOccupancy === 'released') return;
        await delay(retryDelayMs, undefined, { signal: abort.signal });
        retryDelayMs = Math.min(retryDelayMs * 2, 30000);
      }
    }
  }
  async function run(id: string, resumed: boolean) {
    let submitted = resumed; let taskId: string | undefined;
    try {
      let job = await options.transact(state => { const found = state.directCoverJobs.find(j => j.requestId === id); check(found, 'NOT_FOUND', 'Direct job missing', 404); return found; });
      if (resumed) { taskId = job.backendTaskId; check(taskId, 'INVALID_STATE', 'Missing known backend task'); await patch(id, current => ({ ...current, state: 'running', backendOccupancy: 'unknown', error: undefined })); }
      else {
        const health = await request('/health', {}, 3000); check(health.ok, 'API_UNAVAILABLE', `ACE-Step API unavailable (HTTP ${health.status})`);
        const healthBody = await responseObject(health); const healthData = object(healthBody.data);
        check(healthData.service === 'ACE-Step API', 'API_UNAVAILABLE', 'The configured service is not ACE-Step API');
        check(healthData.models_initialized !== false, 'MODEL_UNAVAILABLE', 'ACE-Step has no initialized model');
        const source = await options.transact(state => { const capture = state.captures.find(c => c.captureId === job.captureId && c.sessionId === job.sessionId); check(capture?.state === 'ready' && capture.canonicalAssetId, 'SOURCE_UNAVAILABLE', 'Source capture unavailable', 409); return capture; });
        const bytes = await readFile(join(options.root, 'assets', source.canonicalAssetId!)); check(hash(bytes) === source.canonicalSha256, 'ASSET_CORRUPT', 'Source audio is corrupt', 409);
        const form = new FormData(); form.append('src_audio', new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), 'source.wav');
        for (const [key, value] of Object.entries({ task_type: 'cover', caption: job.prompt, lyrics: '[inst]', audio_cover_strength: '1.0', batch_size: '1', audio_format: 'wav32', thinking: 'false', sample_mode: 'false', use_format: 'false' })) form.append(key, value);
        job = await patch(id, current => ({ ...current, state: 'running', backendOccupancy: 'occupied' })); submitted = true;
        const response = await request('/release_task', { method: 'POST', body: form }, 120000);
        if (response.status === 429) {
          // The maintained API emits this exact response before queue insertion.
          let rejected = false;
          try { rejected = (await responseObject(response)).detail === 'Server busy: queue is full'; } catch { /* Unknown response: retain occupancy. */ }
          if (rejected) { await patch(id, current => ({ ...current, state: 'failed', backendOccupancy: 'released', error: 'ACE-Step queue is full' })); return; }
        }
        if (!response.ok && response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
          await patch(id, current => ({ ...current, state: 'failed', backendOccupancy: 'released', error: `ACE-Step rejected Cover request (HTTP ${response.status})` })); return;
        }
        check(response.ok, 'API_SUBMISSION_UNKNOWN', `ACE-Step submission outcome unknown (HTTP ${response.status})`);
        const envelope = await responseObject(response); const data = object(envelope.data); check(typeof data.task_id === 'string' && data.task_id.length > 0, 'API_SUBMISSION_UNKNOWN', 'ACE-Step did not return a task ID');
        taskId = data.task_id; await patch(id, current => ({ ...current, backendTaskId: taskId }));
      }
      await poll(id, taskId!);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ACE-Step request failed';
      await patch(id, current => ({ ...current, state: submitted ? 'interrupted' : 'failed', backendOccupancy: submitted ? 'unknown' : 'released', error: submitted ? `Generation outcome unknown: ${message}` : `ACE-Step unavailable: ${message}` }));
    }
  }
  return {
    kick(id: string, resumed = false) { if (stopping || running.has(id)) return; const promise = run(id, resumed).catch(() => { process.stderr.write('Direct Cover worker failed to persist its state; restart and inspect the bridge state.\n'); }).finally(() => running.delete(id)); running.set(id, promise); },
    async stop() { stopping = true; abort.abort(); await Promise.allSettled(running.values()); },
  };
}
