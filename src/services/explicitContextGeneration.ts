import type { ModelEntry } from '../types/api';
import type { LogicSourceTiming } from './logicBridgeTiming';

export class ExplicitContextError extends Error {
  override readonly name = 'ExplicitContextError';
}

export function requireLegoModel(models: readonly ModelEntry[], modelId: string): string {
  const model = models.find(entry => entry.name === modelId && entry.is_loaded && entry.supported_task_types?.includes('lego'));
  if (!model || /turbo/i.test(model.name)) throw new ExplicitContextError('LEGO_UNAVAILABLE: Load a compatible Base Lego model explicitly.');
  return model.name;
}

export function validateContextRange(frameCount: number, startFrame: number, endFrame: number): void {
  if (![frameCount, startFrame, endFrame].every(Number.isSafeInteger) || startFrame < 0 || startFrame >= endFrame || endFrame > frameCount) {
    throw new ExplicitContextError('INVALID_RANGE: Use a nonempty range within the canonical reference.');
  }
}

export interface ExplicitContextRequest {
  readonly sourceTiming?: LogicSourceTiming;
  readonly bridgeJobId?: string;
  readonly projectId: string;
  readonly clipId: string;
  readonly canonicalBlob: Blob;
  readonly frameCount: number;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly modelId: string;
  readonly seed: number;
  readonly signal: AbortSignal;
  readonly onSubmissionStarted?: () => void;
  readonly onSubmitted: (taskId: string) => Promise<void>;
}
