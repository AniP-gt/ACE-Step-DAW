import { BRIDGE_PORT, BRIDGE_PROTOCOL } from '../../shared/logic-bridge/types';
import { ExplicitContextError } from './explicitContextGeneration';
import { useLogicBridgeStore } from '../store/logicBridgeStore';

export const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}/v1`;
export type BridgeObject = Record<string, unknown>;

export class BridgeRequestError extends Error {
  override readonly name = 'BridgeRequestError';
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function object(value: unknown): BridgeObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ExplicitContextError('INVALID_RESPONSE');
  return Object.fromEntries(Object.entries(value));
}
export function stringField(value: BridgeObject, key: string): string {
  const field = value[key];
  if (typeof field !== 'string') throw new ExplicitContextError(`INVALID_RESPONSE: ${key}`);
  return field;
}
export function numberField(value: BridgeObject, key: string): number {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isFinite(field)) throw new ExplicitContextError(`INVALID_RESPONSE: ${key}`);
  return field;
}
export function objects(value: BridgeObject, key: string): BridgeObject[] {
  const field = value[key];
  if (!Array.isArray(field)) throw new ExplicitContextError(`INVALID_RESPONSE: ${key}`);
  return field.map(object);
}

export async function bridgeRequest(token: string, path: string, body?: BridgeObject | Blob): Promise<Response> {
  const executorId = useLogicBridgeStore.getState().executorId;
  const response = await fetch(`${BRIDGE_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Bridge-Protocol': String(BRIDGE_PROTOCOL),
      ...(executorId ? { 'X-Executor-Id': executorId } : {}),
      ...(body === undefined ? {} : { 'Content-Type': body instanceof Blob ? 'audio/wav' : 'application/json' }),
    },
    body: body instanceof Blob ? body : body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    let problem = new BridgeRequestError(`BRIDGE_${response.status}`, 'Bridge request failed. Check the local bridge service and try again.');
    try {
      const payload = object(await response.json());
      const error = object(payload.error);
      if (typeof error.code === 'string' && typeof error.message === 'string' && error.message.trim()) {
        problem = new BridgeRequestError(error.code, error.message);
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof ExplicitContextError)) throw error;
    }
    throw problem;
  }
  return response;
}

export async function bridgeJson(token: string, path: string, body?: BridgeObject): Promise<BridgeObject> {
  return object(await (await bridgeRequest(token, path, body)).json());
}

export async function canonicalBlob(token: string, capture: BridgeObject): Promise<Blob> {
  const blob = await (await bridgeRequest(token, `/assets/${encodeURIComponent(stringField(capture, 'canonicalAssetId'))}`)).blob();
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== stringField(capture, 'canonicalSha256')) throw new ExplicitContextError('HASH_MISMATCH');
  return blob;
}
