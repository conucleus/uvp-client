// Wallet proof transport：challenge→verify 存 token、session/refresh/revoke 带 header、
// 严格解码；没有账户/anchoredAddress 字段。

import { describe, expect, it } from 'vitest';
import {
  createWalletProofTransport,
  WalletProofTransportError,
  type WalletProofFetcher,
} from '../../src/browser/session/index.js';

const WALLET = '0x0000000000000000000000000000000000000002';
const TOKEN = 'a'.repeat(64);

interface Call {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function fetcherFor(
  handler: (call: Call) => Response,
  calls: Call[],
): WalletProofFetcher {
  return async (input, init) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: (init?.headers as Record<string, string> | undefined) ?? {},
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call);
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('wallet proof transport', () => {
  it('challenges, verifies, stores the token and refreshes/revokes it', async () => {
    const calls: Call[] = [];
    let stored: string | undefined;
    const transport = createWalletProofTransport({
      baseUrl: 'https://app.example',
      tokenStore: {
        read: () => stored,
        write: (token) => {
          stored = token;
        },
      },
      fetcher: fetcherFor((call) => {
        if (call.url.endsWith('/wallet-proof/challenge')) {
          return json({
            challenge: {
              nonce: 'b'.repeat(32),
              wallet: WALLET,
              message: 'UVP wallet proof',
              issuedAt: '2026-10-27T00:00:00.000Z',
              expiresAt: '2026-10-27T00:05:00.000Z',
            },
          }, 201);
        }
        if (call.url.endsWith('/wallet-proof/verify')) {
          return json({
            token: TOKEN,
            session: { wallet: WALLET, expiresAt: '2026-10-28T00:00:00.000Z' },
          }, 201);
        }
        if (call.url.endsWith('/wallet-proof/session')) {
          return json({ session: { wallet: WALLET, expiresAt: '2026-10-28T00:00:00.000Z' } });
        }
        if (call.url.endsWith('/wallet-proof/refresh')) {
          return json({ session: { wallet: WALLET, expiresAt: '2026-10-29T00:00:00.000Z' } });
        }
        return json({ revoked: true });
      }, calls),
    });

    const challenge = await transport.challenge(WALLET);
    expect(calls[0]?.body).toEqual({ wallet: '0x0000000000000000000000000000000000000002' });
    expect(challenge.nonce).toBe('b'.repeat(32));

    const verified = await transport.verify(challenge.nonce, `0x${'11'.repeat(65)}`);
    expect(verified.session.wallet).toBe(WALLET);
    expect(stored).toBe(TOKEN);
    expect(calls[1]?.body).toEqual({ nonce: challenge.nonce, signature: `0x${'11'.repeat(65)}` });

    const session = await transport.session();
    expect(session.wallet).toBe(WALLET);
    expect(calls[2]?.headers['x-uvp-store-session']).toBe(TOKEN);

    const refreshed = await transport.refresh();
    expect(refreshed.expiresAt).toBe('2026-10-29T00:00:00.000Z');

    expect(await transport.revoke()).toBe(true);
    expect(stored).toBeUndefined();
  });

  it('rejects malformed responses and exposes named HTTP failures', async () => {
    const malformed = createWalletProofTransport({
      baseUrl: 'https://app.example',
      fetcher: fetcherFor(() => json({ challenge: { nonce: 'n' } }), []),
    });
    await expect(malformed.challenge(WALLET)).rejects.toMatchObject({
      code: 'invalid_response',
    });

    const expired = createWalletProofTransport({
      baseUrl: 'https://app.example',
      tokenStore: { read: () => TOKEN, write: () => undefined },
      fetcher: fetcherFor(
        () => json({ error: 'wallet_proof_expired', message: 'wallet proof token has expired' }, 410),
        [],
      ),
    });
    try {
      await expired.session();
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(WalletProofTransportError);
      expect(error).toMatchObject({
        code: 'http',
        status: 410,
        errorCode: 'wallet_proof_expired',
      });
    }
  });
});
