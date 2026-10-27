/**
 * Wallet proof transport：challenge → 钱包 personal_sign（宿主）→ verify → 短时效 token；
 * session/refresh/revoke 用 session header。没有账户/登录/地址锚定；token 存储与签名由宿主注入。
 */

import { getAddress, isAddress } from 'viem';
import {
  WALLET_PROOF_SESSION_HEADER,
  type WalletProofChallengeView,
  type WalletProofVerifyResult,
  type WalletSessionView,
} from '@uvp-eth/product-dto';

export type WalletProofFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface WalletProofTokenStore {
  read(): string | undefined;
  write(token: string | undefined): void;
}

export interface WalletProofTransportOptions {
  readonly baseUrl: string;
  readonly tokenStore?: WalletProofTokenStore | undefined;
  readonly fetcher?: WalletProofFetcher | undefined;
  readonly timeoutMs?: number | undefined;
}

const ROOT = '/product/v3/wallet-proof';
const DEFAULT_TIMEOUT_MS = 6_000;

export interface WalletProofTransport {
  currentSessionToken(): string | undefined;
  restoreSessionToken(token: string | undefined): boolean;
  challenge(wallet: string): Promise<WalletProofChallengeView>;
  verify(nonce: string, signature: string): Promise<WalletProofVerifyResult>;
  session(): Promise<WalletSessionView>;
  refresh(): Promise<WalletSessionView>;
  revoke(): Promise<boolean>;
}

export type WalletProofErrorCode =
  | 'invalid_config'
  | 'invalid_address'
  | 'timeout'
  | 'transport'
  | 'redirect_refused'
  | 'http'
  | 'invalid_response'
  | 'session_required';

export interface WalletProofErrorInput {
  readonly code: WalletProofErrorCode;
  readonly message: string;
  readonly status?: number | undefined;
  readonly errorCode?: string | undefined;
  readonly cause?: unknown;
}

export class WalletProofTransportError extends Error {
  override readonly name = 'WalletProofTransportError';
  readonly code: WalletProofErrorCode;
  readonly status: number | undefined;
  readonly errorCode: string | undefined;
  readonly retryable: boolean;

  constructor(input: WalletProofErrorInput) {
    super(input.message);
    if (input.cause !== undefined) {
      this.cause = input.cause;
    }
    this.code = input.code;
    this.status = input.status;
    this.errorCode = input.errorCode;
    this.retryable =
      input.code === 'timeout' ||
      input.code === 'transport' ||
      (input.code === 'http' && (input.status === 429 || (input.status ?? 0) >= 500));
  }
}

export function createWalletProofTransport(
  options: WalletProofTransportOptions,
): WalletProofTransport {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/u, '');
  if (baseUrl.length === 0) {
    throw new WalletProofTransportError({
      code: 'invalid_config',
      message: 'wallet proof transport requires a non-empty baseUrl',
    });
  }
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tokenStore = options.tokenStore;
  let sessionToken = tokenStore?.read();

  async function request(
    method: 'GET' | 'POST',
    pathname: string,
    body: unknown,
    withSession: boolean,
  ): Promise<Record<string, unknown>> {
    const signal = AbortSignal.timeout(timeoutMs);
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (withSession) {
      if (sessionToken === undefined) {
        throw new WalletProofTransportError({
          code: 'session_required',
          message: `${pathname} requires a wallet proof token`,
        });
      }
      headers[WALLET_PROOF_SESSION_HEADER] = sessionToken;
    }
    let response: Response;
    try {
      response = await fetcher(`${baseUrl}${pathname}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === 'TimeoutError')) {
        throw new WalletProofTransportError({
          code: 'timeout',
          message: `wallet proof request ${pathname} timed out after ${timeoutMs}ms; the result is unknown`,
          cause: error,
        });
      }
      throw new WalletProofTransportError({
        code: 'transport',
        message: `wallet proof request ${pathname} did not reach the service: ${describe(error)}`,
        cause: error,
      });
    }
    if (response.status === 0 || (response.status >= 300 && response.status < 400)) {
      throw new WalletProofTransportError({
        code: 'redirect_refused',
        message: `wallet proof endpoint ${pathname} answered with a redirect (${response.status}); credentials are not replayed`,
        status: response.status,
      });
    }
    const payload = await readJson(response, pathname);
    if (!response.ok) {
      throw new WalletProofTransportError({
        code: 'http',
        message: readString(payload, 'message') ?? `wallet proof endpoint ${pathname} failed with HTTP ${response.status}`,
        status: response.status,
        ...(readString(payload, 'error') === undefined ? {} : { errorCode: readString(payload, 'error') }),
      });
    }
    return payload;
  }

  function storeSession(token: string | undefined): void {
    sessionToken = token;
    tokenStore?.write(token);
  }

  return {
    currentSessionToken: () => sessionToken,

    restoreSessionToken(token: string | undefined): boolean {
      const changed = sessionToken !== token;
      storeSession(token);
      return changed;
    },

    async challenge(wallet) {
      if (typeof wallet !== 'string' || !isAddress(wallet, { strict: false })) {
        throw new WalletProofTransportError({
          code: 'invalid_address',
          message: `wallet proof challenge requires a valid EVM address, received ${String(wallet)}`,
        });
      }
      const payload = await request('POST', `${ROOT}/challenge`, { wallet: getAddress(wallet) }, false);
      return challengeFrom(payload.challenge);
    },

    async verify(nonce, signature) {
      requireNonEmpty(nonce, 'nonce');
      requireNonEmpty(signature, 'signature');
      const payload = await request('POST', `${ROOT}/verify`, { nonce, signature }, false);
      const token = requireString(payload, 'token', 'verify.token');
      const session = sessionFrom(payload.session);
      storeSession(token);
      return { token, session };
    },

    async session() {
      const payload = await request('GET', `${ROOT}/session`, undefined, true);
      return sessionFrom(payload.session);
    },

    async refresh() {
      const payload = await request('POST', `${ROOT}/refresh`, undefined, true);
      return sessionFrom(payload.session);
    },

    async revoke() {
      const payload = await request('POST', `${ROOT}/revoke`, undefined, true);
      const revoked = payload.revoked;
      if (typeof revoked !== 'boolean') {
        throw invalidShape('revoke.revoked');
      }
      if (revoked) {
        storeSession(undefined);
      }
      return revoked;
    },
  };
}

function challengeFrom(value: unknown): WalletProofChallengeView {
  const record = requireRecord(value, 'challenge');
  return {
    nonce: requireString(record, 'nonce', 'challenge.nonce'),
    wallet: requireString(record, 'wallet', 'challenge.wallet'),
    message: requireString(record, 'message', 'challenge.message'),
    issuedAt: requireString(record, 'issuedAt', 'challenge.issuedAt'),
    expiresAt: requireString(record, 'expiresAt', 'challenge.expiresAt'),
  };
}

function sessionFrom(value: unknown): WalletSessionView {
  const record = requireRecord(value, 'session');
  return {
    wallet: requireString(record, 'wallet', 'session.wallet'),
    expiresAt: requireString(record, 'expiresAt', 'session.expiresAt'),
  };
}

async function readJson(response: Response, pathname: string): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new WalletProofTransportError({
      code: 'invalid_response',
      message: `wallet proof endpoint ${pathname} returned a non-JSON body`,
      status: response.status,
      cause: error,
    });
  }
  return requireRecord(payload, pathname);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidShape(label);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string, label: string): string {
  const value = readString(record, field);
  if (value === undefined) {
    throw invalidShape(label);
  }
  return value;
}

function readString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WalletProofTransportError({
      code: 'invalid_config',
      message: `${field} must be a non-empty string`,
    });
  }
}

function invalidShape(label: string): WalletProofTransportError {
  return new WalletProofTransportError({
    code: 'invalid_response',
    message: `wallet proof response is missing or has an invalid ${label}`,
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
