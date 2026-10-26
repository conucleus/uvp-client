/**
 * Operation delivery: one transport interface for signed operations, two
 * implementations — direct (broadcast the authorized calls through the signer's
 * own RPC/provider seam) and relay (POST the signed envelope to a relay that
 * forwards it). Nonce/broadcast mechanics belong to the injected submitter or
 * the relay; this module owns only the envelope, receipt parsing and the
 * operation/ code/ retryable error model.
 */
import type { Address, Hex } from 'viem';
import {
  OperationError,
  type OperationCall,
  type OperationResult,
  type SignedOperation,
  type SubmitMode,
} from './operations.js';

export type OperationFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const DEFAULT_OPERATION_TIMEOUT_MS = 15_000;

export interface OperationTransport {
  readonly mode: SubmitMode;
  submit(signed: SignedOperation): Promise<OperationResult>;
}

export interface DirectCall {
  readonly from: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly chainId: number;
}

export interface DirectCallSubmitter {
  sendCall(call: DirectCall): Promise<Hex>;
}

export interface DirectTransportConfig {
  readonly submitter: DirectCallSubmitter;
}

export function createDirectTransport(config: DirectTransportConfig): OperationTransport {
  return {
    mode: 'direct',
    async submit(signed) {
      if (signed.calls.length === 0) {
        throw new OperationError({
          operation: signed.operation,
          code: 'unsupported_delivery',
          message: `${signed.operation} has no chain call in this role; direct delivery is chain-only`,
        });
      }
      const txHashes: Hex[] = [];
      for (const [index, call] of signed.calls.entries()) {
        try {
          txHashes.push(await sendCall(config.submitter, signed, call));
        } catch (error) {
          if (error instanceof OperationError) {
            throw error;
          }
          throw new OperationError({
            operation: signed.operation,
            code: 'broadcast_failed',
            message: `direct broadcast of ${signed.operation} failed at call ${index + 1}/${signed.calls.length}`
              + ` (already broadcast: ${txHashes.length === 0 ? 'none' : txHashes.join(', ')}): ${errorMessage(error)}`,
            cause: error,
          });
        }
      }
      return {
        operation: signed.operation,
        mode: 'direct',
        chainId: signed.chainId,
        signer: signed.signer,
        status: 'submitted',
        txHashes,
      };
    },
  };
}

export interface RelayTransportConfig {
  /** Relay service base URL; relayPath is appended unless it is an absolute URL. */
  readonly relayUrl: string;
  /** Endpoint path, normally `/relay`; app-owned relays pass their own route. */
  readonly relayPath?: string | undefined;
  readonly fetcher?: OperationFetcher | undefined;
  readonly timeoutMs?: number | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export const DEFAULT_RELAY_PATH = '/relay';

export function createRelayTransport(config: RelayTransportConfig): OperationTransport {
  const endpoint = joinUrl(config.relayUrl.trim(), config.relayPath ?? DEFAULT_RELAY_PATH);
  const fetcher = config.fetcher ?? defaultFetcher();
  const timeoutMs = config.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  return {
    mode: 'relay',
    async submit(signed) {
      const signal = AbortSignal.timeout(timeoutMs);
      let response: Response;
      try {
        response = await fetcher(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...config.headers },
          body: stringifyOperation(signed),
          redirect: 'manual',
          signal,
        });
      } catch (error) {
        throw new OperationError({
          operation: signed.operation,
          code: 'relay_unreachable',
          message: `relay ${endpoint} did not answer for ${signed.operation}: ${errorMessage(error)}`,
          cause: error,
        });
      }
      if (!response.ok) {
        throw await relayRejection(signed, response, endpoint);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw new OperationError({
          operation: signed.operation,
          code: 'invalid_relay_response',
          message: `relay ${endpoint} returned a non-JSON 2xx body: ${errorMessage(error)}`,
          cause: error,
        });
      }
      return relayResult(signed, body, endpoint);
    },
  };
}

/** POST body shape: the signed envelope verbatim, bigint message values serialized as base-10 strings. */
export function stringifyOperation(signed: SignedOperation): string {
  return JSON.stringify(signed, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString(10) : value));
}

function relayResult(signed: SignedOperation, body: unknown, endpoint: string): OperationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidRelayResponse(signed, endpoint, '2xx body is not a JSON object');
  }
  const record = body as Record<string, unknown>;
  const status = record.status;
  if (status !== 'submitted' && status !== 'accepted') {
    throw invalidRelayResponse(signed, endpoint, '2xx body has no submitted/accepted status');
  }
  if (record.operation !== undefined && record.operation !== signed.operation) {
    throw invalidRelayResponse(
      signed,
      endpoint,
      `relay answered for ${String(record.operation)}, not ${signed.operation}`,
    );
  }
  const txHashes = record.txHashes === undefined ? [] : requireTxHashes(signed, record.txHashes, endpoint);
  if (status === 'submitted' && txHashes.length === 0) {
    throw invalidRelayResponse(signed, endpoint, 'relay reported submitted without any transaction hash');
  }
  const relayRef = record.relayRef;
  if (relayRef !== undefined && (typeof relayRef !== 'string' || relayRef.length === 0)) {
    throw invalidRelayResponse(signed, endpoint, 'relayRef must be a non-empty string');
  }
  return {
    operation: signed.operation,
    mode: 'relay',
    chainId: signed.chainId,
    signer: signed.signer,
    status,
    txHashes,
    ...(relayRef === undefined ? {} : { relayRef }),
  };
}

async function relayRejection(
  signed: SignedOperation,
  response: Response,
  endpoint: string,
): Promise<OperationError> {
  const text = await response.text();
  let code: string | undefined;
  let message = text.length > 0 ? text : `${response.status} ${response.statusText}`;
  let retryable = response.status === 429 || response.status >= 500;
  try {
    const parsed = JSON.parse(text) as { readonly error?: unknown; readonly message?: unknown; readonly retryable?: unknown };
    if (typeof parsed.error === 'string') {
      code = parsed.error;
    }
    if (typeof parsed.message === 'string' && parsed.message.length > 0) {
      message = parsed.message;
    }
    if (typeof parsed.retryable === 'boolean') {
      retryable = parsed.retryable;
    }
  } catch {
  }
  return new OperationError({
    operation: signed.operation,
    code: 'relay_rejected',
    message: `relay ${endpoint} rejected ${signed.operation} (${response.status}`
      + `${code === undefined ? '' : ` ${code}`}): ${message}`,
    retryable,
  });
}

function requireTxHashes(signed: SignedOperation, value: unknown, endpoint: string): readonly Hex[] {
  if (!Array.isArray(value) || value.some((hash) => typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash))) {
    throw invalidRelayResponse(signed, endpoint, 'txHashes must be an array of 32-byte hex hashes');
  }
  return value as readonly Hex[];
}

function invalidRelayResponse(signed: SignedOperation, endpoint: string, detail: string): OperationError {
  return new OperationError({
    operation: signed.operation,
    code: 'invalid_relay_response',
    message: `relay ${endpoint} response for ${signed.operation}: ${detail}`,
  });
}

async function sendCall(
  submitter: DirectCallSubmitter,
  signed: SignedOperation,
  call: OperationCall,
): Promise<Hex> {
  const txHash = await submitter.sendCall({
    from: signed.signer,
    to: call.to,
    data: call.data,
    chainId: signed.chainId,
  });
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new OperationError({
      operation: signed.operation,
      code: 'broadcast_failed',
      message: `direct submitter returned an invalid transaction hash for ${call.functionName}`,
    });
  }
  return txHash;
}

function defaultFetcher(): OperationFetcher {
  return globalThis.fetch.bind(globalThis) as OperationFetcher;
}

function joinUrl(baseUrl: string, relayPath: string): string {
  if (/^https?:\/\//i.test(relayPath)) {
    return relayPath;
  }
  return `${baseUrl.replace(/\/+$/u, '')}${relayPath.startsWith('/') ? relayPath : `/${relayPath}`}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
