import { randomUUID } from 'node:crypto';
import type { BridgeCredential, DirectCoverJob } from '../../shared/logic-bridge/types';
import type { BridgeState } from './storage';
import { owner } from './nativeRequests';
import { backendOccupancy } from './jobs';
import { hash } from './audio';
import { check, string } from './validation';

export function directReceipt(job: DirectCoverJob) {
  return { requestId: job.requestId, sessionId: job.sessionId, captureId: job.captureId, state: job.state === 'interrupted' && job.backendOccupancy === 'released' ? 'failed' : job.state,
    ...(job.resultId ? { resultId: job.resultId } : {}), ...(job.error ? { error: job.error } : {}) };
}
export function ownedDirect(state: BridgeState, requestId: string, credential: BridgeCredential | 'control' | undefined) {
  const job = state.directCoverJobs.find(item => item.requestId === requestId);
  check(job, 'NOT_FOUND', 'Direct generation not found', 404);
  check(job.ownerCredentialHash === owner(credential, job.sessionId), 'FORBIDDEN', 'Direct generation owner mismatch', 403);
  return job;
}
export function acceptDirect(state: BridgeState, data: Record<string, unknown>, credential: BridgeCredential | 'control' | undefined) {
  const sessionId = string(data, 'sessionId'); const ownerHash = owner(credential, sessionId);
  const captureId = string(data, 'captureId'); const clientRequestId = string(data, 'clientRequestId');
  const prompt = string(data, 'prompt'); check(prompt.trim().length > 0, 'INVALID_FIELD', 'Enter a prompt');
  const fingerprint = hash(JSON.stringify({ captureId, prompt }));
  const old = state.directCoverJobs.find(job => job.sessionId === sessionId && job.ownerCredentialHash === ownerHash && job.clientRequestId === clientRequestId);
  if (old) { check(old.payloadFingerprint === fingerprint, 'REQUEST_CONFLICT', 'Request ID already used with different input', 409); return directReceipt(old); }
  const capture = state.captures.find(item => item.captureId === captureId && item.sessionId === sessionId);
  check(capture?.state === 'ready' && capture.canonicalAssetId && capture.canonicalSha256 && capture.canonicalFrameCount, 'SOURCE_UNAVAILABLE', 'Ready source audio is required', 409);
  const direct = state.directCoverJobs.find(job => job.backendOccupancy !== 'released');
  const daw = state.jobs.find(job => backendOccupancy(job) !== 'released');
  check(!direct && !daw, direct?.backendOccupancy === 'unknown' || (daw && backendOccupancy(daw) === 'unknown') ? 'BACKEND_OUTCOME_UNKNOWN' : 'PROJECT_BUSY', 'Another bridge generation occupies the backend', 409);
  const job: DirectCoverJob = { requestId: randomUUID(), sessionId, captureId, clientRequestId, ownerCredentialHash: ownerHash, payloadFingerprint: fingerprint, prompt, state: 'queued', backendOccupancy: 'reserved' };
  state.directCoverJobs.push(job); return directReceipt(job);
}
