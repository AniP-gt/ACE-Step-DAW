import { randomUUID } from 'node:crypto';
import type { BridgeJob, ContextBinding } from '../../shared/logic-bridge/types';
import type { BridgeState } from './storage';
import { check, integer, string } from './validation';
import { hash } from './audio';
export interface Executor {
  readonly executorId: string;
  readonly credentialToken: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly modelId: string;
  readonly instruments: readonly string[];
  seen: number;
}
export function binding(data: Record<string, unknown>, state: BridgeState): ContextBinding {
  const capture = state.captures.find(item => item.captureId === string(data, 'captureId') && item.sessionId === string(data, 'sessionId'));
  check(capture?.state === 'ready' && capture.canonicalSha256, 'SOURCE_UNAVAILABLE', 'Capture is not ready', 409);
  const proposed = { bindingId: randomUUID(), sessionId: capture.sessionId, projectId: string(data, 'projectId'), captureId: capture.captureId, clipId: string(data, 'clipId'), clientRequestId: string(data, 'clientRequestId'), canonicalSha256: capture.canonicalSha256 };
  const previous = state.bindings.find(item => item.sessionId === proposed.sessionId && item.clientRequestId === proposed.clientRequestId);
  if (previous) {
    check(previous.captureId === proposed.captureId && previous.projectId === proposed.projectId && previous.clipId === proposed.clipId, 'REQUEST_CONFLICT', 'Conflicting binding retry', 409);
    return previous;
  }
  state.bindings.push(proposed);
  return proposed;
}
export function createJob(data: Record<string, unknown>, state: BridgeState, executor: Executor | undefined): BridgeJob {
  const proposed = { sessionId: string(data, 'sessionId'), projectId: string(data, 'projectId'), captureId: string(data, 'captureId'), bindingId: string(data, 'bindingId'), clientRequestId: string(data, 'clientRequestId'), instrument: string(data, 'instrument'), startFrame: integer(data, 'startFrame'), endFrame: integer(data, 'endFrame'), prompt: string(data, 'prompt', 'Add an instrumental layer'), modelId: string(data, 'modelId'), seed: integer(data, 'seed', -1) };
  const parameterHash = hash(JSON.stringify(proposed));
  const previous = state.jobs.find(job => job.sessionId === proposed.sessionId && job.clientRequestId === proposed.clientRequestId);
  if (previous) { check(previous.parameterHash === parameterHash, 'REQUEST_CONFLICT', 'Conflicting job retry', 409); return previous; }
  const source = state.captures.find(capture => capture.captureId === proposed.captureId && capture.sessionId === proposed.sessionId);
  const bound = state.bindings.find(item => item.bindingId === proposed.bindingId && item.sessionId === proposed.sessionId && item.projectId === proposed.projectId && item.captureId === proposed.captureId);
  check(source?.state === 'ready' && source.canonicalFrameCount && source.canonicalSha256 && bound?.canonicalSha256 === source.canonicalSha256, 'STALE_BINDING', 'Source binding unavailable', 409);
  check(proposed.startFrame >= 0 && proposed.endFrame > proposed.startFrame && proposed.endFrame <= source.canonicalFrameCount, 'INVALID_RANGE', 'Invalid canonical range');
  check(executor && executor.projectId === proposed.projectId && Date.now() - executor.seen < 30000, 'EXECUTOR_UNAVAILABLE', 'Project executor is offline', 409);
  check(executor.modelId === proposed.modelId && executor.instruments.includes(proposed.instrument), 'LEGO_UNAVAILABLE', 'Compatible model/instrument unavailable', 409);
  const occupied = state.jobs.find(job => backendOccupancy(job) !== 'released');
  check(!occupied, occupied && backendOccupancy(occupied) === 'unknown' ? 'BACKEND_OUTCOME_UNKNOWN' : 'PROJECT_BUSY', occupied ? `Backend occupied by job ${occupied.jobId}; reconcile its terminal backend status before retrying` : 'Backend is busy', 409);
  const job: BridgeJob = { ...proposed, jobId: randomUUID(), parameterHash, canonicalSha256: source.canonicalSha256, state: 'queued', backendOccupancy: 'reserved' };
  state.jobs.push(job);
  return job;
}
export function transition(job: BridgeJob, data: Record<string, unknown>): BridgeJob {
  const next = string(data, 'state');
  const allowed: Record<string, readonly string[]> = { queued: ['dispatched', 'failed', 'interrupted'], dispatched: ['running', 'failed', 'interrupted'], running: ['exporting', 'failed', 'interrupted'], exporting: ['failed', 'interrupted'] };
  check(allowed[job.state]?.includes(next), 'INVALID_TRANSITION', 'Job cannot transition', 409);
  check(next === 'dispatched' || next === 'running' || next === 'exporting' || next === 'failed' || next === 'interrupted', 'INVALID_TRANSITION', 'Unsupported transition');
  return { ...job, state: next, backendOccupancy: next === 'failed' || next === 'interrupted' ? (job.state === 'queued' ? 'released' : 'unknown') : 'occupied', ...(typeof data.backendTaskId === 'string' ? { backendTaskId: data.backendTaskId } : {}), ...(typeof data.error === 'string' ? { error: data.error } : {}) };
}

export function backendOccupancy(job: BridgeJob): NonNullable<BridgeJob['backendOccupancy']> {
  if (job.backendOccupancy) return job.backendOccupancy;
  if (job.state === 'ready') return 'released';
  if (job.state === 'queued') return 'reserved';
  return 'unknown';
}
