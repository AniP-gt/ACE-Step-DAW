import { randomUUID } from 'node:crypto';
import type { BridgeCredential, NativeGenerationReadiness, NativeRequestReceipt, NativeRequestRecord } from '../../shared/logic-bridge/types';
import type { BridgeState } from './storage';
import { hash } from './audio';
import { backendOccupancy, createJob, type Executor } from './jobs';
import { check, string } from './validation';

export function publicReceipt(record: NativeRequestRecord): NativeRequestReceipt {
  const base = { requestId: record.requestId, sessionId: record.sessionId, projectId: record.projectId, captureId: record.captureId };
  if (record.kind === 'prepare') return record.state === 'prepared'
    ? { ...base, kind: 'prepare', state: 'prepared', bindingId: record.bindingId }
    : { ...base, kind: 'prepare', state: record.state, ...(record.error ? { error: record.error } : {}) };
  const generation = { ...base, kind: 'generation' as const, preparedRequestId: record.preparedRequestId, bindingId: record.bindingId, instrument: record.instrument, prompt: record.prompt };
  return record.state === 'submitted' ? { ...generation, state: 'submitted', jobId: record.jobId }
    : { ...generation, state: record.state, ...(record.error ? { error: record.error } : {}) };
}
export function owner(credential: BridgeCredential | 'control' | undefined, sessionId: string): string {
  check(credential && credential !== 'control' && credential.role === 'native' && credential.sessionId === sessionId, 'FORBIDDEN', 'Native owner required', 403);
  return hash(credential.token);
}
function sourceValid(state: BridgeState, record: NativeRequestRecord): boolean {
  const source = state.captures.find(c => c.captureId === record.captureId && c.sessionId === record.sessionId);
  if (!source || source.state !== 'ready' || !source.canonicalSha256 || !source.canonicalFrameCount) return false;
  if (record.kind === 'prepare' && record.state !== 'prepared') return true;
  if (record.kind === 'generation' || record.state === 'prepared') return state.bindings.some(b => b.bindingId === record.bindingId && b.sessionId === record.sessionId && b.projectId === record.projectId && b.captureId === record.captureId && b.canonicalSha256 === source.canonicalSha256);
  return false;
}
function active(executor: Executor | undefined, projectId?: string): executor is Executor {
  return !!executor && Date.now() - executor.seen < 30000 && (!projectId || executor.projectId === projectId);
}
export function readiness(state: BridgeState, sessionId: string, ownerHash: string, executor: Executor | undefined): NativeGenerationReadiness {
  const prepared = [...state.nativeRequests].reverse().find(r => r.sessionId === sessionId && r.ownerCredentialHash === ownerHash && r.kind === 'prepare' && r.state === 'prepared');
  const instruments = active(executor) ? executor.instruments : [];
  let reason: string | undefined;
  if (!prepared) reason = 'REFERENCE_UNAVAILABLE';
  else if (!active(executor, prepared.projectId)) reason = 'EXECUTOR_UNAVAILABLE';
  else if (!sourceValid(state, prepared)) reason = 'STALE_BINDING';
  else if (!executor.modelId || !executor.instruments.length) reason = 'LEGO_UNAVAILABLE';
  else if (state.jobs.some(job => backendOccupancy(job) !== 'released') || state.directCoverJobs.some(job => job.backendOccupancy !== 'released')) reason = 'BACKEND_BUSY';
  return { preparedRequestId: prepared?.requestId ?? null, ready: !reason, ...(reason ? { reason } : {}), instruments };
}
export function owned(state: BridgeState, id: string, credential: BridgeCredential | 'control' | undefined): NativeRequestRecord {
  const record = state.nativeRequests.find(r => r.requestId === id); check(record, 'NOT_FOUND', 'Request missing', 404);
  check(record.ownerCredentialHash === owner(credential, record.sessionId), 'FORBIDDEN', 'Request owner mismatch', 403); return record;
}
export function accept(state: BridgeState, data: Record<string, unknown>, credential: BridgeCredential | 'control' | undefined, executor: Executor | undefined): NativeRequestReceipt {
  const sessionId = string(data, 'sessionId'); const ownerHash = owner(credential, sessionId); const clientId = string(data, 'clientRequestId'); const kind = string(data, 'kind');
  check(kind === 'prepare' || kind === 'generation', 'INVALID_FIELD', 'Invalid request kind');
  const payload = kind === 'prepare' ? { kind, captureId: string(data, 'captureId') } : { kind, preparedRequestId: string(data, 'preparedRequestId'), instrument: string(data, 'instrument'), prompt: data.prompt ?? '' };
  if (payload.kind === 'generation') check(typeof payload.prompt === 'string' && payload.prompt.length <= 4096, 'INVALID_FIELD', 'Invalid prompt');
  const fingerprint = hash(JSON.stringify(payload));
  const previous = state.nativeRequests.find(r => r.sessionId === sessionId && r.ownerCredentialHash === ownerHash && r.clientRequestId === clientId);
  if (previous) { check(previous.payloadFingerprint === fingerprint, 'REQUEST_CONFLICT', 'Conflicting native retry', 409); return publicReceipt(previous); }
  check(active(executor), 'EXECUTOR_UNAVAILABLE', 'Project executor is offline', 409);
  const common = { requestId: randomUUID(), sessionId, projectId: executor.projectId, ownerCredentialHash: ownerHash, clientRequestId: clientId, payloadFingerprint: fingerprint };
  let record: NativeRequestRecord;
  if (payload.kind === 'prepare') {
    const capture = state.captures.find(c => c.captureId === payload.captureId && c.sessionId === sessionId);
    check(capture?.state === 'ready' && capture.canonicalSha256 && capture.canonicalFrameCount, 'SOURCE_UNAVAILABLE', 'Capture is not ready', 409);
    record = { ...common, captureId: capture.captureId, kind: 'prepare', state: 'pending' };
  } else {
    const prepared = owned(state, payload.preparedRequestId, credential);
    check(prepared.kind === 'prepare' && prepared.state === 'prepared' && prepared.projectId === executor.projectId && sourceValid(state, prepared), 'STALE_BINDING', 'Prepared reference unavailable', 409);
    check(executor.modelId && executor.instruments.includes(payload.instrument), 'LEGO_UNAVAILABLE', 'Compatible model/instrument unavailable', 409);
    check(!state.jobs.some(job => backendOccupancy(job) !== 'released'), 'BACKEND_BUSY', 'Backend occupied; reconcile before retrying', 409);
    const prompt = typeof payload.prompt === 'string' && payload.prompt.trim() ? payload.prompt : 'Add an instrumental layer';
    record = { ...common, captureId: prepared.captureId, kind: 'generation', state: 'pending', preparedRequestId: prepared.requestId, bindingId: prepared.bindingId, instrument: payload.instrument, prompt, jobClientRequestId: randomUUID() };
  }
  state.nativeRequests.push(record); return publicReceipt(record);
}
export function update(state: BridgeState, record: NativeRequestRecord, action: string, data: Record<string, unknown>, executor?: Executor): NativeRequestReceipt {
  let next: NativeRequestRecord = record;
  if (action === 'cancel') {
    if (record.kind === 'generation' && record.state === 'submitted') {
      const job = state.jobs.find(j => j.jobId === record.jobId); check(job, 'NOT_FOUND', 'Linked job missing', 404);
      if (!['ready', 'failed', 'interrupted', 'canceled'].includes(job.state)) state.jobs = state.jobs.map(j => j.jobId === job.jobId ? { ...job, state: 'canceled', backendOccupancy: job.state === 'queued' ? 'released' : 'unknown' } : j);
    } else if (record.state === 'pending') next = { ...record, state: 'canceled' };
  } else {
    check(active(executor, record.projectId), 'EXECUTOR_UNAVAILABLE', 'Matching executor required', 409);
    if (action === 'prepared') {
      check(record.kind === 'prepare', 'INVALID_TRANSITION', 'Expected preparation', 409);
      const bindingId = string(data, 'bindingId');
      if (record.state === 'prepared') check(record.bindingId === bindingId, 'REQUEST_CONFLICT', 'Conflicting acknowledgement', 409);
      else {
        check(record.state === 'pending', 'INVALID_TRANSITION', 'Preparation is closed', 409);
        const bound = state.bindings.find(b => b.bindingId === bindingId && b.sessionId === record.sessionId && b.projectId === record.projectId && b.captureId === record.captureId);
        check(bound && sourceValid(state, { ...record, state: 'prepared', bindingId }), 'STALE_BINDING', 'Binding unavailable', 409);
        next = { ...record, state: 'prepared', bindingId };
      }
    } else if (action === 'submit') {
      check(record.kind === 'generation', 'INVALID_TRANSITION', 'Expected generation', 409);
      if (record.state !== 'submitted') {
        check(record.state === 'pending' && sourceValid(state, record), 'STALE_BINDING', 'Reference unavailable', 409);
        const source = state.captures.find(c => c.captureId === record.captureId && c.sessionId === record.sessionId);
        check(source?.canonicalFrameCount, 'SOURCE_UNAVAILABLE', 'Capture unavailable', 409);
        const job = createJob({ sessionId: record.sessionId, projectId: record.projectId, captureId: record.captureId, bindingId: record.bindingId, clientRequestId: record.jobClientRequestId, instrument: record.instrument, prompt: record.prompt, modelId: executor.modelId, startFrame: 0, endFrame: source.canonicalFrameCount }, state, executor);
        next = { ...record, state: 'submitted', jobId: job.jobId };
      }
    } else if (action === 'fail') {
      check(record.state === 'pending', 'INVALID_TRANSITION', 'Request is closed', 409);
      next = { ...record, state: 'failed', error: string(data, 'error') };
    } else check(false, 'NOT_FOUND', 'Route missing', 404);
  }
  state.nativeRequests = state.nativeRequests.map(r => r.requestId === record.requestId ? next : r); return publicReceipt(next);
}
