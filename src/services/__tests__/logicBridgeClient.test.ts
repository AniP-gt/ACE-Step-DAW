import { afterEach, describe, expect, it, vi } from 'vitest';
import { bridgeRequest } from '../logicBridgeClient';

describe('bridge HTTP errors', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('preserves the structured code and exposes only the actionable service message', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 'INVALID_PAIRING', message: 'Pairing code invalid or expired', requestId: 'internal-request-identity', retryable: false } }), { status: 401 }));
    await expect(bridgeRequest('', '/pairings/claim', { code: 'bad' })).rejects.toMatchObject({ code: 'INVALID_PAIRING', message: 'Pairing code invalid or expired' });
  });

  it.each(['<html>Internal server trace</html>', '{broken', '{"error":{"requestId":"private"}}'])('uses a safe message for malformed error bodies: %s', async body => {
    vi.stubGlobal('fetch', async () => new Response(body, { status: 502 }));
    await expect(bridgeRequest('', '/pairings/claim', { code: 'bad' })).rejects.toMatchObject({ code: 'BRIDGE_502', message: 'Bridge request failed. Check the local bridge service and try again.' });
  });
});
