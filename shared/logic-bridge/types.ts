export const BRIDGE_PROTOCOL = 1;
export const BRIDGE_PORT = 5176;
export type BridgeRole = 'native' | 'executor' | 'mcp';
export interface BridgeCredential {
  readonly token: string;
  readonly sessionId: string;
  readonly role: BridgeRole;
  readonly projectId?: string;
}
export interface BridgeSession {
  readonly sessionId: string;
  readonly name: string;
  readonly protocolVersion: number;
}
export interface BridgeCapture {
  readonly captureId: string;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly label: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly expectedFrames: number;
  readonly receivedFrames: number;
  readonly hostStartSample: number;
  readonly tempo: number;
  readonly timeSignature: readonly number[];
  readonly state: 'receiving' | 'ready' | 'canceled' | 'failed';
  readonly chunks: readonly { readonly sha256: string; readonly frames: number }[];
  readonly originalAssetId?: string;
  readonly originalPcmSha256?: string;
  readonly canonicalAssetId?: string;
  readonly canonicalSha256?: string;
  readonly canonicalFrameCount?: number;
}
export interface ContextBinding {
  readonly bindingId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly captureId: string;
  readonly clipId: string;
  readonly clientRequestId: string;
  readonly canonicalSha256: string;
}
export type JobState = 'queued' | 'dispatched' | 'running' | 'exporting' | 'ready' | 'failed' | 'interrupted' | 'canceled';
export interface BridgeJob {
  readonly jobId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly captureId: string;
  readonly bindingId: string;
  readonly clientRequestId: string;
  readonly canonicalSha256: string;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly instrument: string;
  readonly prompt: string;
  readonly modelId: string;
  readonly seed: number;
  readonly state: JobState;
  readonly parameterHash: string;
  readonly backendOccupancy?: 'reserved' | 'occupied' | 'unknown' | 'released';
  readonly backendTaskId?: string;
  readonly error?: string;
  readonly resultId?: string;
}
export interface BridgeResult {
  readonly resultId: string;
  readonly sessionId: string;
  readonly jobId: string;
  readonly assetId: string;
  readonly sha256: string;
  readonly frameCount: number;
  readonly placementSeconds: number;
}
