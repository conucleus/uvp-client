import { ValidationError } from './validation.js';

export type ExecutorKitErrorKind =
  | 'unauthorized'
  | 'duplicate_signal'
  | 'rpc_network'
  | 'insufficient_funds'
  | 'nonce_conflict'
  | 'missing_handler'
  | 'validation_failure'
  | 'handler_failure'
  | 'unknown';

export type ExecutorKitErrorCode =
  | 'UNAUTHORIZED'
  | 'DUPLICATE_SIGNAL'
  | 'RPC_NETWORK'
  | 'MISSING_HANDLER'
  | 'VALIDATION_FAILURE'
  | 'HANDLER_FAILURE';

export interface ClassifiedExecutorKitError {
  readonly kind: ExecutorKitErrorKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly code?: ExecutorKitErrorCode;
}

const ERROR_CODE_TABLE: Readonly<
  Record<ExecutorKitErrorCode, { readonly kind: ExecutorKitErrorKind; readonly retryable: boolean }>
> = {
  UNAUTHORIZED: { kind: 'unauthorized', retryable: false },
  DUPLICATE_SIGNAL: { kind: 'duplicate_signal', retryable: false },
  RPC_NETWORK: { kind: 'rpc_network', retryable: true },
  MISSING_HANDLER: { kind: 'missing_handler', retryable: false },
  VALIDATION_FAILURE: { kind: 'validation_failure', retryable: false },
  HANDLER_FAILURE: { kind: 'handler_failure', retryable: false },
};

const KNOWN_ERROR_CODES = new Set<string>(Object.keys(ERROR_CODE_TABLE));

interface ErrorMessagePattern {
  readonly pattern: RegExp;
  readonly kind: ExecutorKitErrorKind;
  readonly retryable: boolean;
}

const MESSAGE_PATTERNS: readonly ErrorMessagePattern[] = [
  {
    pattern: /SignalAlreadyExists|signal already exists|0xa2e92828/i,
    kind: 'duplicate_signal',
    retryable: false,
  },
  {
    pattern: /AccessControlUnauthorizedAccount|OwnableUnauthorizedAccount|\bunauthorized\b/i,
    kind: 'unauthorized',
    retryable: false,
  },
  {
    pattern: /insufficient funds|insufficient balance/i,
    kind: 'insufficient_funds',
    retryable: true,
  },
  {
    pattern: /nonce too low|nonce has already been used|replacement transaction underpriced|already known|same hash was already imported/i,
    kind: 'nonce_conflict',
    retryable: true,
  },
  {
    pattern: /\b429\b|too many requests|rate limit|timeout|timed out|\b502\b|\b503\b|\b504\b|bad gateway|service unavailable|gateway timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ECONNABORTED|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network error|HTTP request failed/i,
    kind: 'rpc_network',
    retryable: true,
  },
];

export class CodedExecutorKitError extends Error {
  readonly code: ExecutorKitErrorCode;

  constructor(code: ExecutorKitErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'CodedExecutorKitError';
    this.code = code;
  }
}

export function classifyExecutorKitError(
  error: unknown,
  fallbackKind: ExecutorKitErrorKind = 'unknown',
): ClassifiedExecutorKitError {
  const rawMessage = errorToMessage(error);
  const keepHexes = publicHashesOf(error);

  const matchedCode = matchExplicitCode(error);
  if (matchedCode) {
    const entry = ERROR_CODE_TABLE[matchedCode];
    return {
      kind: entry.kind,
      message: redactSecretLikeHex(rawMessage || matchedCode, keepHexes),
      retryable: entry.retryable,
      code: matchedCode,
    };
  }

  if (error instanceof ValidationError) {
    return {
      kind: 'validation_failure',
      message: rawMessage || 'validation_failure',
      retryable: false,
    };
  }

  const matchedPattern = matchMessagePattern(error);
  if (matchedPattern) {
    return {
      kind: matchedPattern.kind,
      message: redactSecretLikeHex(rawMessage || matchedPattern.kind, keepHexes),
      retryable: matchedPattern.retryable,
    };
  }

  return {
    kind: fallbackKind,
    message: redactSecretLikeHex(rawMessage || fallbackKind, keepHexes),
    retryable: false,
  };
}

function matchExplicitCode(error: unknown): ExecutorKitErrorCode | undefined {
  for (const current of walkErrorChain(error)) {
    const code = (current as { readonly code?: unknown }).code;
    if (typeof code === 'string' && KNOWN_ERROR_CODES.has(code)) {
      return code as ExecutorKitErrorCode;
    }
  }
  return undefined;
}

function matchMessagePattern(error: unknown): ErrorMessagePattern | undefined {
  const messages = [...walkErrorChain(error)]
    .map((current) => (current instanceof Error ? current.message : undefined))
    .filter((message): message is string => typeof message === 'string' && message.length > 0);
  for (const entry of MESSAGE_PATTERNS) {
    if (messages.some((message) => entry.pattern.test(message))) {
      return entry;
    }
  }
  return undefined;
}

function* walkErrorChain(error: unknown): Generator<Error> {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    yield current;
    current = current.cause;
  }
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function redactSecretLikeHex(value: string, keepHexes: ReadonlySet<string>): string {
  return value
    .replace(/0[xX][a-fA-F0-9]{64,}/g, (match) => (keepHexes.has(match.toLowerCase()) ? match : '[redacted-hex]'))
    .replace(/(?<![0-9a-fA-FxX])[a-fA-F0-9]{64,}/g, '[redacted-hex]');
}

function publicHashesOf(error: unknown): ReadonlySet<string> {
  const keepHexes = new Set<string>();
  for (const current of walkErrorChain(error)) {
    const txHash = (current as { readonly txHash?: unknown }).txHash;
    if (typeof txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      keepHexes.add(txHash.toLowerCase());
    }
  }
  return keepHexes;
}
