import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeRequestError, bridgeRequest, bridgeUrlForPort } from '../logicBridgeClient';

describe('bridge HTTP errors', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('preserves the structured code and exposes only the actionable service message', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 'INVALID_PAIRING', message: 'Pairing code invalid or expired', requestId: 'internal-request-identity', retryable: false } }), { status: 401 }));
    await expect(bridgeRequest('', '/pairings/claim', { code: 'bad' })).rejects.toMatchObject({ code: 'INVALID_PAIRING', status: 401, message: 'Pairing code invalid or expired' });
    const error = await bridgeRequest('', '/pairings/claim', { code: 'bad' }).catch(value => value);
    expect(error).toBeInstanceOf(BridgeRequestError);
    expect(error).toBeInstanceOf(Error);
  });

  it('preserves network errors without classifying them as HTTP responses', async () => {
    const network = new TypeError('offline');
    vi.stubGlobal('fetch', async () => { throw network; });
    const error = await bridgeRequest('', '/pairings/claim').catch(value => value);
    expect(error).toBe(network);
    expect(error).not.toBeInstanceOf(BridgeRequestError);
  });

  it.each(['<html>Internal server trace</html>', '{broken', '{"error":{"requestId":"private"}}'])('uses a safe message for malformed error bodies: %s', async body => {
    vi.stubGlobal('fetch', async () => new Response(body, { status: 502 }));
    await expect(bridgeRequest('', '/pairings/claim', { code: 'bad' })).rejects.toMatchObject({ code: 'BRIDGE_502', message: 'Bridge request failed. Check the local bridge service and try again.' });
  });
});

describe('bridge endpoint configuration', () => {
  it('defaults to the production loopback endpoint', () => {
    expect(bridgeUrlForPort(undefined)).toBe('http://127.0.0.1:5176/v1');
  });
  it.each(['1', '43210', '65535'])('accepts a numeric port %s', port => {
    expect(bridgeUrlForPort(port)).toBe(`http://127.0.0.1:${Number(port)}/v1`);
  });
  it.each(['', '0', '65536', '-1', '1.5', ' 5176', '5176 ', 'abc', 'http://localhost:5176'])('rejects invalid explicit port %j', port => {
    expect(() => bridgeUrlForPort(port)).toThrow();
  });
});

describe('configured bridge URL', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  it('uses the configured port in requests', async () => {
    vi.stubEnv('VITE_LOGIC_BRIDGE_PORT', '43210');
    vi.resetModules();
    const client = await import('../logicBridgeClient');
    expect(client.BRIDGE_URL).toBe('http://127.0.0.1:43210/v1');
  });
  it('rejects malformed explicit configuration during import', async () => {
    vi.stubEnv('VITE_LOGIC_BRIDGE_PORT', '');
    vi.resetModules();
    await expect(import('../logicBridgeClient')).rejects.toThrow('Invalid VITE_LOGIC_BRIDGE_PORT');
  });
});
