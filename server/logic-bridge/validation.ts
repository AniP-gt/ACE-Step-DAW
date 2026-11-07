export class BridgeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function check(condition: unknown, code: string, message: string, status = 400): asserts condition {
  if (!condition) throw new BridgeError(status, code, message);
}
export function object(value: unknown): Record<string, unknown> {
  check(typeof value === 'object' && value !== null && !Array.isArray(value), 'INVALID_BODY', 'Expected an object');
  return Object.fromEntries(Object.entries(value));
}
export function string(data: Record<string, unknown>, key: string, fallback?: string): string {
  const value = data[key] ?? fallback;
  check(typeof value === 'string' && value.length > 0 && value.length <= 4096, 'INVALID_FIELD', `Invalid ${key}`);
  return value;
}
export function number(data: Record<string, unknown>, key: string, fallback?: number): number {
  const value = data[key] ?? fallback;
  check(typeof value === 'number' && Number.isFinite(value), 'INVALID_FIELD', `Invalid ${key}`);
  return value;
}
export function integer(data: Record<string, unknown>, key: string, fallback?: number): number {
  const value = number(data, key, fallback);
  check(Number.isSafeInteger(value), 'INVALID_FIELD', `Invalid ${key}`);
  return value;
}
