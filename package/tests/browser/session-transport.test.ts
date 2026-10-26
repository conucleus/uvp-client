import { describe, expect, it } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import {
  WalletSessionError,
  createWalletSessionTransport,
  type WalletSessionFetcher,
  type WalletSessionTokenStore,
} from '../../src/browser/session/index.js';

const ACCOUNT = getAddress('0x0000000000000000000000000000000000000002');
const SIGNATURE = `0x${'11'.repeat(65)}` as Hex;
const BASE_URL = 'https://participants.example';

interface FetchCall {
  readonly url: string;
  readonly body: unknown;
}

function jsonFetcher(
  handler: (url: string, body: unknown) => Response | Promise<Response>,
): { readonly fetcher: WalletSessionFetcher; readonly calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher: WalletSessionFetcher = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ url, body });
    return handler(url, body);
  };
  return { fetcher, calls };
}

function memoryTokenStore(initial?: string): WalletSessionTokenStore & {
  readonly writes: Array<string | undefined>;
} {
  const writes: Array<string | undefined> = [];
  let token = initial;
  return {
    writes,
    read: () => token,
    write: (next) => {
      token = next;
      writes.push(next);
    },
  };
}

function session(fetcher: WalletSessionFetcher, tokenStore?: WalletSessionTokenStore) {
  return createWalletSessionTransport({
    baseUrl: BASE_URL,
    personalSign: async () => SIGNATURE,
    fetcher,
    ...(tokenStore === undefined ? {} : { tokenStore }),
  });
}

describe('wallet session transport', () => {
  it('runs challenge → personal_sign → verify and persists the injected token store', async () => {
    const { fetcher, calls } = jsonFetcher((url) => {
      if (url.endsWith('/store/auth/challenge')) {
        return Response.json({ challenge: { nonce: 'nonce-1', message: 'UVP login nonce-1' } });
      }
      return Response.json({ token: 'session-token-1', session: { anchoredAddress: ACCOUNT } });
    });
    const tokenStore = memoryTokenStore('seed-token');

    const transport = session(fetcher, tokenStore);
    const proof = await transport.proveWalletControl(ACCOUNT);

    expect(calls.map((call) => call.url)).toEqual([
      `${BASE_URL}/store/auth/challenge`,
      `${BASE_URL}/store/auth/verify`,
    ]);
    expect(calls[0]?.body).toEqual({ address: ACCOUNT, intent: 'login' });
    expect(calls[1]?.body).toEqual({ nonce: 'nonce-1', signature: SIGNATURE });
    expect(proof).toEqual({ sessionToken: 'session-token-1', anchoredAddress: ACCOUNT });
    expect(transport.currentSessionToken()).toBe('session-token-1');
    expect(tokenStore.writes).toEqual(['session-token-1']);
    expect(transport.restoreSessionToken(undefined)).toBe(true);
    expect(transport.currentSessionToken()).toBeUndefined();
    expect(tokenStore.writes).toEqual(['session-token-1', undefined]);
  });

  it('maps every session failure to an explicit code instead of a silent fallback', async () => {
    const rejectWith = (error: unknown) => session(async () => {
      throw error;
    });
    await expect(rejectWith(new DOMException('signal aborted', 'TimeoutError')).proveWalletControl(ACCOUNT))
      .rejects.toMatchObject({ name: 'WalletSessionError', code: 'timeout', retryable: true });
    await expect(rejectWith(new Error('ECONNREFUSED')).proveWalletControl(ACCOUNT))
      .rejects.toMatchObject({ code: 'transport', retryable: true });

    const invalidAddress = session(jsonFetcher(() => Response.json({})).fetcher);
    await expect(invalidAddress.proveWalletControl('not-an-address'))
      .rejects.toMatchObject({ code: 'invalid_address', retryable: false });

    const rejected = session(jsonFetcher(() => Response.json(
      { error: 'wallet_identity_required', message: 'sign in first' },
      { status: 401 },
    )).fetcher);
    await expect(rejected.proveWalletControl(ACCOUNT)).rejects.toMatchObject({
      code: 'http',
      status: 401,
      errorCode: 'wallet_identity_required',
      retryable: false,
    });
    const unavailable = session(jsonFetcher(() => Response.json({}, { status: 503 })).fetcher);
    await expect(unavailable.proveWalletControl(ACCOUNT))
      .rejects.toMatchObject({ code: 'http', status: 503, retryable: true });

    const redirected = session(jsonFetcher(() => new Response(null, {
      status: 302,
      headers: { location: 'https://elsewhere.example' },
    })).fetcher);
    await expect(redirected.proveWalletControl(ACCOUNT))
      .rejects.toMatchObject({ code: 'redirect_refused', status: 302, retryable: false });

    const nonJson = session(jsonFetcher(() => new Response('not-json', { status: 200 })).fetcher);
    await expect(nonJson.proveWalletControl(ACCOUNT))
      .rejects.toMatchObject({ code: 'invalid_response', retryable: false });

    const partialChallenge = session(jsonFetcher(() => Response.json({
      challenge: { nonce: 'nonce-1' },
    })).fetcher);
    await expect(partialChallenge.proveWalletControl(ACCOUNT))
      .rejects.toBeInstanceOf(WalletSessionError);
    await expect(partialChallenge.proveWalletControl(ACCOUNT))
      .rejects.toMatchObject({ code: 'invalid_response' });

    const signerRejects = createWalletSessionTransport({
      baseUrl: BASE_URL,
      personalSign: async () => {
        throw new Error('user rejected');
      },
      fetcher: jsonFetcher(() => Response.json({
        challenge: { nonce: 'nonce-1', message: 'sign me' },
      })).fetcher,
    });
    await expect(signerRejects.proveWalletControl(ACCOUNT))
      .rejects.toMatchObject({ code: 'signature_failed', retryable: false });

    const badSignature = createWalletSessionTransport({
      baseUrl: BASE_URL,
      personalSign: async () => '0xdead',
      fetcher: jsonFetcher(() => Response.json({
        challenge: { nonce: 'nonce-1', message: 'sign me' },
      })).fetcher,
    });
    await expect(badSignature.proveWalletControl(ACCOUNT))
      .rejects.toMatchObject({ code: 'signature_failed' });
  });
});
