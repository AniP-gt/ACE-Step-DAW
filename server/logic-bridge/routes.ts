import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BridgeCredential, BridgeRole } from '../../shared/logic-bridge/types';
import type { storage } from './storage';
import { check, object, string } from './validation';
import { appendChunk, createCapture, finalize } from './captures';
import { binding, createJob, transition, backendOccupancy, type Executor } from './jobs';
import { hash, validateResult } from './audio';
export interface RouteRequest {
  readonly method: string;
  readonly url: URL;
  readonly credential: BridgeCredential | 'control' | undefined;
  readonly bytes: Buffer;
  readonly headers: Record<string, string | string[] | undefined>;
}
export function routes(db: Awaited<ReturnType<typeof storage>>, root: string, quota: number) {
  const pairings = new Map<string, { sessionId: string; role: BridgeRole; projectId?: string; expiresAt: number }>();
  const executors = new Map<string, Executor>();
  let failedClaims = 0;
  let claimWindow = Date.now();
  return async (request: RouteRequest): Promise<unknown> => {
    const expired = [...executors.values()].filter(executor => Date.now() - executor.seen >= 30000);
    if (expired.length) {
      for (const executor of expired) executors.delete(executor.sessionId);
      db.state.jobs = db.state.jobs.map(job => expired.some(executor => executor.sessionId === job.sessionId) && ['queued', 'dispatched', 'running', 'exporting'].includes(job.state)
        ? { ...job, state: 'interrupted', error: 'EXECUTOR_LEASE_EXPIRED', backendOccupancy: job.state === 'queued' ? 'released' : 'unknown' }
        : job);
      await db.save();
    }
    const { method, url, credential, bytes, headers } = request;
    const parts = url.pathname.split('/').filter(Boolean).slice(1);
    const [resource, id, action, sequence] = parts;
    const data = bytes.length && !['chunks', 'result'].includes(action ?? '') ? object(JSON.parse(bytes.toString('utf8'))) : {};
    const scope = (sessionId: string, role?: BridgeRole, projectId?: string) => {
      check(credential && (credential === 'control' || credential.sessionId === sessionId), 'FORBIDDEN', 'Session scope mismatch', 403);
      if (role) check(credential === 'control' || credential.role === role, 'FORBIDDEN', 'Role mismatch', 403);
      if (projectId) check(credential === 'control' || credential.projectId === projectId, 'FORBIDDEN', 'Project scope mismatch', 403);
    };
    const liveExecutor = (sessionId: string) => {
      const executor = executors.get(sessionId);
      check(executor && Date.now() - executor.seen < 30000 && headers['x-executor-id'] === executor.executorId && (credential === 'control' || credential?.token === executor.credentialToken), 'EXECUTOR_UNAVAILABLE', 'Current executor lease required', 409);
      return executor;
    };
    if (resource === 'pairings' && id === 'claim' && method === 'POST') {
      if (Date.now() - claimWindow > 60000) { claimWindow = Date.now(); failedClaims = 0; }
      check(failedClaims < 10, 'RATE_LIMITED', 'Too many failed pairing claims', 429);
      const code = string(data, 'code');
      const pairing = pairings.get(code);
      if (!pairing || pairing.expiresAt < Date.now()) { failedClaims++; check(false, 'INVALID_PAIRING', 'Pairing code invalid or expired', 401); }
      pairings.delete(code);
      const issued: BridgeCredential = { token: randomBytes(32).toString('hex'), sessionId: pairing.sessionId, role: pairing.role, ...(pairing.projectId ? { projectId: pairing.projectId } : {}) };
      db.state.credentials.push(issued); return issued;
    }
    if (resource === 'sessions' && method === 'POST') {
      check(credential === 'control', 'FORBIDDEN', 'Control credential required', 403);
      const session = { sessionId: randomUUID(), name: string(data, 'name'), protocolVersion: 1 };
      db.state.sessions.push(session); return session;
    }
    if (resource === 'pairings' && method === 'POST') {
      check(credential === 'control', 'FORBIDDEN', 'Control credential required', 403);
      const sessionId = string(data, 'sessionId'); const role = string(data, 'role');
      check(db.state.sessions.some(session => session.sessionId === sessionId), 'NOT_FOUND', 'Session missing', 404);
      check(role === 'native' || role === 'executor' || role === 'mcp', 'INVALID_ROLE', 'Invalid role');
      const projectId = role === 'executor' || role === 'mcp' ? string(data, 'projectId') : undefined;
      const code = randomBytes(12).toString('hex'); const expiresAt = Date.now() + 120000;
      pairings.set(code, { sessionId, role, ...(projectId ? { projectId } : {}), expiresAt });
      return { code, expiresAt };
    }
    if (resource === 'captures' && !id) {
      const sessionId = method === 'GET' ? url.searchParams.get('sessionId') ?? '' : string(data, 'sessionId'); scope(sessionId);
      if (method === 'GET') return { captures: db.state.captures.filter(capture => capture.sessionId === sessionId) };
      check(method === 'POST', 'METHOD_NOT_ALLOWED', 'Unsupported method', 405); scope(sessionId, 'native');
      const capture = createCapture(data, db.state, quota); db.state.captures.push(capture); return capture;
    }
    if (resource === 'captures' && id) {
      const capture = db.state.captures.find(item => item.captureId === id); check(capture, 'NOT_FOUND', 'Capture missing', 404); scope(capture.sessionId, 'native');
      let updated = capture;
      if (method === 'PUT' && action === 'chunks') updated = await appendChunk(root, capture, { sequence: Number(sequence), startFrame: Number(headers['x-start-frame']), sha256: String(headers['x-chunk-sha256'] ?? ''), bytes });
      else if (method === 'POST' && action === 'finalize') {
        const sha256 = string(data, 'sha256');
        if (capture.state === 'ready') check(capture.originalPcmSha256 === sha256, 'HASH_MISMATCH', 'Conflicting finalization retry', 409);
        updated = capture.state === 'ready' ? capture : await finalize(root, capture, sha256, db.state);
      }
      else if (method === 'POST' && action === 'cancel') { check(capture.state !== 'ready', 'CAPTURE_CLOSED', 'Ready capture is immutable', 409); await rm(join(root, 'staging', capture.captureId), { force: true }); updated = { ...capture, state: 'canceled' }; }
      else check(false, 'NOT_FOUND', 'Route missing', 404);
      db.state.captures = db.state.captures.map(item => item.captureId === id ? updated : item); return updated;
    }
    if (resource === 'assets' && method === 'GET') {
      const asset = db.state.assets.find(item => item.assetId === id); check(asset, 'NOT_FOUND', 'Asset missing', 404); scope(asset.sessionId);
      const content = await readFile(join(root, 'assets', asset.assetId)); check(hash(content) === asset.sha256, 'ASSET_CORRUPT', 'Asset integrity check failed', 409); return content;
    }
    if (resource === 'executor') {
      const sessionId = method === 'GET' ? url.searchParams.get('sessionId') ?? '' : string(data, 'sessionId'); scope(sessionId, 'executor');
      if (id === 'register' && method === 'POST') {
        const projectId = string(data, 'projectId'); scope(sessionId, 'executor', projectId);
        const executorId = string(data, 'executorId'); const previous = executors.get(sessionId);
        check(!previous || (previous.executorId === executorId && (credential === 'control' || previous.credentialToken === credential?.token)) || Date.now() - previous.seen >= 30000, 'EXECUTOR_CONFLICT', 'Another executor is active', 409);
        const instruments = data.instruments; check(Array.isArray(instruments) && instruments.every(value => typeof value === 'string'), 'INVALID_CAPABILITY', 'Invalid instruments');
        const modelId = typeof data.modelId === 'string' && data.modelId.length <= 4096 ? data.modelId : '';
        check(instruments.length === 0 || modelId.length > 0, 'INVALID_CAPABILITY', 'Model ID required');
        check(instruments.length === 0 || (data.outputSemantics === 'isolated-layer' && !modelId.toLowerCase().includes('turbo')), 'UNSUPPORTED_OUTPUT_SEMANTICS', 'Verified isolated-layer capability required', 409);
        executors.set(sessionId, { sessionId, projectId, executorId, credentialToken: credential === 'control' ? db.controlToken : credential?.token ?? '', modelId, instruments, seen: Date.now() }); return { registered: true };
      }
      const executor = liveExecutor(sessionId); executor.seen = Date.now();
      if (id === 'jobs' && method === 'GET') return { jobs: db.state.jobs.filter(job => job.sessionId === sessionId && job.projectId === executor.projectId && (backendOccupancy(job) !== 'released' || job.state === 'canceled')) };
    }
    if (resource === 'bindings') {
      const sessionId = method === 'GET' ? url.searchParams.get('sessionId') ?? '' : string(data, 'sessionId'); scope(sessionId);
      if (method === 'GET') return { bindings: db.state.bindings.filter(item => item.sessionId === sessionId) };
      check(method === 'POST', 'METHOD_NOT_ALLOWED', 'Unsupported method', 405); scope(sessionId, 'executor', string(data, 'projectId')); liveExecutor(sessionId); return binding(data, db.state);
    }
    if (resource === 'jobs' && !id && method === 'POST') {
      const sessionId = string(data, 'sessionId'); scope(sessionId, undefined, string(data, 'projectId'));
      check(credential === 'control' || credential?.role === 'mcp' || credential?.role === 'executor', 'FORBIDDEN', 'Generation role required', 403);
      return createJob(data, db.state, executors.get(sessionId));
    }
    if (resource === 'jobs' && id) {
      const job = db.state.jobs.find(item => item.jobId === id); check(job, 'NOT_FOUND', 'Job missing', 404); scope(job.sessionId);
      if (credential && credential !== 'control' && (credential.role === 'mcp' || credential.role === 'executor')) scope(job.sessionId, credential.role, job.projectId);
      if (method === 'GET' && !action) return job;
      let updated = job;
      if (method === 'POST' && action === 'cancel') {
        check(credential === 'control' || credential?.role === 'mcp' || credential?.role === 'executor', 'FORBIDDEN', 'Generation role required', 403);
        updated = ['ready', 'failed', 'interrupted', 'canceled'].includes(job.state) ? job : { ...job, state: 'canceled', backendOccupancy: job.state === 'queued' ? 'released' : 'unknown' };
      }
      else if (method === 'POST' && action === 'submission') {
        scope(job.sessionId, 'executor', job.projectId); liveExecutor(job.sessionId);
        const backendTaskId = string(data, 'backendTaskId');
        check(['dispatched', 'running', 'canceled', 'interrupted'].includes(job.state) && backendOccupancy(job) !== 'released', 'INVALID_TRANSITION', 'Job cannot record submission', 409);
        check(!job.backendTaskId || job.backendTaskId === backendTaskId, 'TASK_CONFLICT', 'Conflicting backend task ID', 409);
        updated = { ...job, backendTaskId, state: job.state === 'dispatched' ? 'running' : job.state, backendOccupancy: ['canceled', 'interrupted'].includes(job.state) ? 'unknown' : 'occupied' };
      }
      else if (method === 'POST' && action === 'reconcile') {
        if (data.backendStopped === true) check(credential === 'control', 'FORBIDDEN', 'Control verification of backend shutdown required', 403);
        else {
          scope(job.sessionId, 'executor', job.projectId); liveExecutor(job.sessionId);
          check(job.backendTaskId && data.backendTaskId === job.backendTaskId, 'TASK_CONFLICT', 'Exact persisted backend task ID required', 409);
          check(['completed', 'failed', 'canceled'].includes(string(data, 'outcome')), 'INVALID_OUTCOME', 'Terminal backend outcome required');
        }
        updated = { ...job, backendOccupancy: 'released', state: ['queued', 'dispatched', 'running', 'exporting'].includes(job.state) ? 'interrupted' : job.state };
      }
      else if (method === 'POST' && action === 'transition') { scope(job.sessionId, 'executor', job.projectId); liveExecutor(job.sessionId); updated = transition(job, data); }
      else if (method === 'POST' && action === 'result') {
        scope(job.sessionId, 'executor', job.projectId); liveExecutor(job.sessionId); check(job.state === 'exporting', 'INVALID_TRANSITION', 'Job is not exporting', 409);
        validateResult(bytes, job.endFrame - job.startFrame);
        check(db.state.assets.reduce((sum, asset) => sum + asset.size, 0) + bytes.length <= quota, 'QUOTA_EXCEEDED', 'Result quota exceeded', 413);
        const capture = db.state.captures.find(item => item.captureId === job.captureId); check(capture, 'SOURCE_UNAVAILABLE', 'Source missing', 409);
        const assetId = randomUUID(); const resultId = randomUUID(); const sha256 = hash(bytes);
        await writeFile(join(root, 'assets', assetId), bytes, { mode: 0o600 });
        db.state.assets.push({ assetId, sessionId: job.sessionId, sha256, size: bytes.length });
        db.state.results.push({ resultId, sessionId: job.sessionId, jobId: job.jobId, assetId, sha256, frameCount: job.endFrame - job.startFrame, placementSeconds: capture.hostStartSample / capture.sampleRate + job.startFrame / 48000 });
        updated = { ...job, state: 'ready', resultId, backendOccupancy: 'released' };
      } else check(false, 'NOT_FOUND', 'Route missing', 404);
      db.state.jobs = db.state.jobs.map(item => item.jobId === id ? updated : item); return updated;
    }
    if (resource === 'results' && method === 'GET') {
      const result = db.state.results.find(item => item.resultId === id); check(result, 'NOT_FOUND', 'Result missing', 404); scope(result.sessionId); return result;
    }
    check(false, 'NOT_FOUND', 'Route missing', 404);
  };
}
