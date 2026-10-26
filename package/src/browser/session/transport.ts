/**
 * Wallet session transport: POST challenge → wallet personal_sign → POST verify →
 * session token. Wallet signing and token persistence are injected (the host owns
 * the provider/UI and storage); this module owns the HTTP protocol, redirect
 * refusal, timeouts and the explicit session error taxonomy. It never reads env
 * or localStorage and never touches private keys.
 */
import { getAddress, isAddress, isHex, type Address } from 'viem';

export type WalletSessionFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface WalletSessionTokenStore {
  read(): string | undefined;
  write(token: string | undefined): void;
}

export type PersonalSigner = (address: Address, message: string) => Promise<string>;

export interface WalletSessionTransportOptions {
  readonly baseUrl: string;
  readonly personalSign: PersonalSigner;
  readonly tokenStore?: WalletSessionTokenStore | undefined;
  readonly challengePath?: string | undefined;
  readonly verifyPath?: string | undefined;
  readonly intent?: string | undefined;
  readonly fetcher?: WalletSessionFetcher | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface WalletSessionProof {
  readonly sessionToken: string;
  readonly anchoredAddress: Address;
}

export interface WalletSessionTransport {
  currentSessionToken(): string | undefined;
  restoreSessionToken(token: string | undefined): boolean;
  proveWalletControl(address: Address | string): Promise<WalletSessionProof>;
}

export type WalletSessionErrorCode =
  | 'invalid_config'
  | 'invalid_address'
  | 'signature_failed'
  | 'timeout'
  | 'transport'
  | 'redirect_refused'
  | 'http'
  | 'invalid_response';

export interface WalletSessionErrorInput {
  readonly code: WalletSessionErrorCode;
  readonly message: string;
  readonly status?: number | undefined;
  readonly errorCode?: string | undefined;
  readonly cause?: unknown;
}

export class WalletSessionError extends Error {
  override readonly name = 'WalletSessionError';
  readonly code: WalletSessionErrorCode;
  readonly status: number | undefined;
  readonly errorCode: string | undefined;
  readonly retryable: boolean;

  constructor(input: WalletSessionErrorInput) {
    super(input.message);
    if (input.cause !== undefined) {
      this.cause = input.cause;
    }
    this.code = input.code;
    this.status = input.status;
    this.errorCode = input.errorCode;
    this.retryable = sessionErrorRetryable(input.code, input.status);
  }
}

const DEFAULT_TIMEOUT_MS = 6_000;
const DEFAULT_CHALLENGE_PATH = '/store/auth/challenge';
const DEFAULT_VERIFY_PATH = '/store/auth/verify';
const DEFAULT_INTENT = 'login';

export function createWalletSessionTransport(
  options: WalletSessionTransportOptions,
): WalletSessionTransport {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/u, '');
  if (baseUrl.length === 0) {
    throw new WalletSessionError({
      code: 'invalid_config',
      message: 'wallet session transport requires a non-empty baseUrl',
    });
  }
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tokenStore = options.tokenStore;
  let sessionToken = tokenStore?.read();

  async function postJson(pathname: string, body: unknown): Promise<Record<string, unknown>> {
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetcher(`${baseUrl}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === 'TimeoutError')) {
        throw new WalletSessionError({
          code: 'timeout',
          message: `wallet session request ${pathname} timed out after ${timeoutMs}ms; the result is unknown`,
          cause: error,
        });
      }
      throw new WalletSessionError({
        code: 'transport',
        message: `wallet session request ${pathname} did not reach the service: ${describe(error)}`,
        cause: error,
      });
    }
    if (response.status === 0 || (response.status >= 300 && response.status < 400)) {
      throw new WalletSessionError({
        code: 'redirect_refused',
        message: `wallet session endpoint ${pathname} answered with a redirect (${response.status}); credentials are not replayed`,
        status: response.status,
      });
    }
    const payload = await readJson(response, pathname);
    if (!response.ok) {
      const serverMessage = readString(payload, 'message');
      const errorCode = readString(payload, 'error');
      throw new WalletSessionError({
        code: 'http',
        message: serverMessage ?? `wallet session endpoint ${pathname} failed with HTTP ${response.status}`,
        status: response.status,
        ...(errorCode === undefined ? {} : { errorCode }),
      });
    }
    return payload;
  }

  return {
    currentSessionToken: () => sessionToken,

    restoreSessionToken(token: string | undefined): boolean {
      const changed = sessionToken !== token;
      sessionToken = token;
      tokenStore?.write(token);
      return changed;
    },

    async proveWalletControl(address: Address | string): Promise<WalletSessionProof> {
      const signer = requireSignerAddress(address);
      const challengeBody = await postJson(options.challengePath ?? DEFAULT_CHALLENGE_PATH, {
        address: signer,
        intent: options.intent ?? DEFAULT_INTENT,
      });
      const challenge = requireRecord(challengeBody.challenge, 'challenge');
      const nonce = requireString(challenge, 'nonce', 'challenge.nonce');
      const message = requireString(challenge, 'message', 'challenge.message');
      const signature = await signMessage(options.personalSign, signer, message);
      const verified = await postJson(options.verifyPath ?? DEFAULT_VERIFY_PATH, { nonce, signature });
      const token = requireString(verified, 'token', 'token');
      const session = verified.session === undefined
        ? {}
        : requireRecord(verified.session, 'session');
      const anchored = readString(session, 'anchoredAddress');
      const anchoredAddress = anchored === undefined ? signer : requireSignerAddress(anchored);
      sessionToken = token;
      tokenStore?.write(token);
      return { sessionToken: token, anchoredAddress };
    },
  };
}

async function readJson(response: Response, pathname: string): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new WalletSessionError({
      code: 'invalid_response',
      message: `wallet session endpoint ${pathname} returned a non-JSON body`,
      status: response.status,
      cause: error,
    });
  }
  return requireRecord(payload, pathname);
}

async function signMessage(
  personalSign: PersonalSigner,
  address: Address,
  message: string,
): Promise<string> {
  let signature: string;
  try {
    signature = await personalSign(address, message);
  } catch (error) {
    throw new WalletSessionError({
      code: 'signature_failed',
      message: `wallet personal_sign failed for ${address}: ${describe(error)}`,
      cause: error,
    });
  }
  if (typeof signature !== 'string' || !isHex(signature) || !/^0x[0-9a-fA-F]{130}$/u.test(signature)) {
    throw new WalletSessionError({
      code: 'signature_failed',
      message: `wallet returned a non-65-byte personal_sign signature for ${address}`,
    });
  }
  return signature;
}

function requireSignerAddress(value: Address | string): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    throw new WalletSessionError({
      code: 'invalid_address',
      message: `wallet session requires a valid EVM address, received ${String(value)}`,
    });
  }
  return getAddress(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WalletSessionError({
      code: 'invalid_response',
      message: `wallet session response is missing the ${label} object`,
    });
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string, label: string): string {
  const value = readString(record, field);
  if (value === undefined) {
    throw new WalletSessionError({
      code: 'invalid_response',
      message: `wallet session response is missing ${label}`,
    });
  }
  return value;
}

function readString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  return value;
}

function sessionErrorRetryable(code: WalletSessionErrorCode, status: number | undefined): boolean {
  switch (code) {
    case 'timeout':
    case 'transport':
      return true;
    case 'http':
      return status === 429 || (status !== undefined && status >= 500);
    default:
      return false;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
