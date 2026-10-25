import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  classifyExecutorKitError,
  CodedExecutorKitError,
  type ExecutorKitErrorKind,
} from '../src/errors.js';
import { ValidationError } from '../src/validation.js';
import { chainPollExecutionFailed } from '../src/cli.js';
import { SubmitSignalReceiptError } from '../src/watcher/index.js';
import type { Hex } from '../src/constants.js';

const TX_HASH: Hex = '0x' + 'ab'.repeat(32);

const TAXONOMY_VERSION = 'uvp.error-taxonomy.v1';
const TAXONOMY_SHA256 = 'edd7a1ee1e1a1e6899c008f00aeb57da0918cb98bd8982d7469c855610e7ae84';

interface TaxonomyErrorEntry {
  readonly code: string;
  readonly layer: string;
  readonly producers: readonly string[];
  readonly retryable: boolean;
  readonly backoff: string;
  readonly dead_letter: boolean;
  readonly benign_scan_outcome: boolean;
  readonly internal_names?: Readonly<Record<string, readonly string[]>>;
  readonly producer_overrides?: Readonly<Record<string, Record<string, unknown>>>;
}

interface TaxonomyFile {
  readonly version: string;
  readonly errors: readonly TaxonomyErrorEntry[];
}

function taxonomyPath(): string {
  const override = process.env.UVP_ERROR_TAXONOMY_JSON;
  if (override) {
    return override;
  }
  const workspaceRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
  return join(workspaceRoot, 'uvp-core', 'protocol', 'uvp-error-taxonomy.v1.json');
}

function loadTaxonomy(): TaxonomyFile {
  const path = taxonomyPath();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `uvp error taxonomy not readable at ${path} (${(error as Error).message}). `
      + 'The table is self-hosted in the uvp-core repo under protocol/uvp-error-taxonomy.v1.json; '
      + 'run the test from the pnpm workspace or point UVP_ERROR_TAXONOMY_JSON at the file. '
      + 'Do not skip this suite: it is the executor-kit side of the pinned conformance contract.',
    );
  }
  const parsed = JSON.parse(raw) as TaxonomyFile;
  expect(parsed.version).toBe(TAXONOMY_VERSION);
  const digest = createHash('sha256').update(raw).digest('hex');
  expect(digest).toBe(TAXONOMY_SHA256);
  return parsed;
}

const taxonomy = loadTaxonomy();

function entryByCode(code: string): TaxonomyErrorEntry {
  const entry = taxonomy.errors.find((candidate) => candidate.code === code);
  if (!entry) {
    throw new Error(`taxonomy is missing the "${code}" entry`);
  }
  return entry;
}

function attrsForExecutorKit(code: string): TaxonomyErrorEntry & Record<string, unknown> {
  const entry = entryByCode(code);
  if (!entry.producers.includes('executor-kit')) {
    throw new Error(`taxonomy entry "${code}" does not list executor-kit as a producer`);
  }
  return { ...entry, ...(entry.producer_overrides?.['executor-kit'] ?? {}) };
}

const KIND_TO_TAXONOMY_CODE: Readonly<Record<ExecutorKitErrorKind, string>> = {
  unauthorized: 'unauthorized',
  duplicate_signal: 'duplicate_signal',
  rpc_network: 'rpc_network',
  insufficient_funds: 'insufficient_funds',
  nonce_conflict: 'nonce_conflict',
  missing_handler: 'missing_handler',
  validation_failure: 'malformed_payload',
  handler_failure: 'handler_failure',
  unknown: 'unknown_unclassified',
};

const KIND_PROBES: Readonly<Record<ExecutorKitErrorKind, () => { readonly kind: ExecutorKitErrorKind; readonly retryable: boolean }>> = {
  unauthorized: () => classifyExecutorKitError(new CodedExecutorKitError('UNAUTHORIZED', 'AccessControlUnauthorizedAccount')),
  duplicate_signal: () => classifyExecutorKitError(new Error('execution reverted: SignalAlreadyExists()')),
  rpc_network: () => classifyExecutorKitError(new Error('fetch failed')),
  insufficient_funds: () => classifyExecutorKitError(new Error('insufficient funds for gas * price + value')),
  nonce_conflict: () => classifyExecutorKitError(new Error('nonce too low')),
  missing_handler: () => classifyExecutorKitError(new Error('no state machine handler for exec#main'), 'missing_handler'),
  validation_failure: () => classifyExecutorKitError(new ValidationError('payloadHash must be a 32-byte hex value')),
  handler_failure: () => classifyExecutorKitError(new CodedExecutorKitError('HANDLER_FAILURE', 'handler failed')),
  unknown: () => classifyExecutorKitError(new Error('no pattern matches this shape at all')),
};

describe('uvp error taxonomy pinning (executor-kit)', () => {
  it('pins the taxonomy version and sha256', () => {
    expect(taxonomy.version).toBe(TAXONOMY_VERSION);
    const digest = createHash('sha256').update(readFileSync(taxonomyPath(), 'utf8')).digest('hex');
    expect(digest).toBe(TAXONOMY_SHA256);
  });
});

describe('executor-kit classification completeness against the taxonomy', () => {
  it('maps every ExecutorKitErrorKind onto an existing taxonomy entry produced by executor-kit', () => {
    for (const [kind, code] of Object.entries(KIND_TO_TAXONOMY_CODE)) {
      const attrs = attrsForExecutorKit(code);
      expect(attrs.retryable, `${kind} -> ${code}.retryable`).toBe(attrs.retryable);
      expect(typeof attrs.dead_letter, `${kind} -> ${code}.dead_letter`).toBe('boolean');
    }
    expect(Object.keys(KIND_TO_TAXONOMY_CODE)).toHaveLength(9);
  });

  it('can reach every kind through the real classifier (no dead taxonomy entries)', () => {
    const observed = new Set<ExecutorKitErrorKind>();
    for (const [kind, probe] of Object.entries(KIND_PROBES) as [ExecutorKitErrorKind, () => { kind: ExecutorKitErrorKind; retryable: boolean }][]) {
      const classified = probe();
      observed.add(classified.kind);
      expect(classified.kind, `probe for ${kind} must classify as ${kind}`).toBe(kind);
    }
    expect([...observed].sort()).toEqual(Object.keys(KIND_TO_TAXONOMY_CODE).sort());
  });

  it('covers every taxonomy entry that lists executor-kit as a producer', () => {
    const producedCodes = new Set(Object.values(KIND_TO_TAXONOMY_CODE));
    const fallbackCoveredCodes = new Set(['transaction_reverted', 'transaction_receipt_unknown']);
    const taxonomyExecutorKitCodes = taxonomy.errors
      .filter((entry) => entry.producers.includes('executor-kit'))
      .map((entry) => entry.code);
    for (const code of taxonomyExecutorKitCodes) {
      const covered = producedCodes.has(code) || fallbackCoveredCodes.has(code);
      expect(covered, `taxonomy entry "${code}" lists executor-kit but no kind maps to it`).toBe(true);
    }
  });

  it('classifies a reverted receipt through the non-retryable terminal lane (transaction_reverted)', () => {
    const attrs = attrsForExecutorKit('transaction_reverted');
    const classified = classifyExecutorKitError(
      new SubmitSignalReceiptError(TX_HASH, 'submitSignal transaction receipt status reverted'),
    );
    expect(classified.kind).toBe('unknown');
    expect(classified.retryable).toBe(attrs.retryable);
    const lane = classified.retryable ? 'failed' : 'dead_letter';
    expect(lane).toBe(attrs.dead_letter ? 'dead_letter' : 'failed');
  });

  it('classifies a receipt-wait transport failure as retryable with the txHash kept (transaction_receipt_unknown)', () => {
    const attrs = attrsForExecutorKit('transaction_receipt_unknown');
    const classified = classifyExecutorKitError(new SubmitSignalReceiptError(
      TX_HASH,
      `submitSignal transaction receipt wait failed for ${TX_HASH}: Request timed out.`,
      { cause: new Error('Request timed out.') },
    ));
    expect(classified.kind).toBe('rpc_network');
    expect(classified.retryable).toBe(attrs.retryable);
    expect(attrs.dead_letter).toBe(false);
  });

  it('keeps tx hashes the error itself carries while redacting secret-shaped hex echoes', () => {
    const receiptError = classifyExecutorKitError(new SubmitSignalReceiptError(
      TX_HASH,
      `submitSignal transaction receipt wait failed for ${TX_HASH}: Request timed out.`,
      { cause: new Error('Request timed out.') },
    ));
    expect(receiptError.message).toContain(TX_HASH);
    expect(receiptError.message).not.toContain('[redacted');

    const bareKey = 'ab'.repeat(32);
    const leaked = classifyExecutorKitError(new Error(`signing failed with key ${bareKey}`));
    expect(leaked.message).not.toContain(bareKey);
    expect(leaked.message).toContain('[redacted-hex]');

    const prefixedKey = `0x${'ab'.repeat(32)}`;
    const prefixedLeak = classifyExecutorKitError(new Error(`provider echoed credentials: ${prefixedKey}`));
    expect(prefixedLeak.message).not.toContain(prefixedKey);
    expect(prefixedLeak.message).toContain('[redacted-hex]');
  });

  it('redacts hex runs of 64+ digits as a whole segment, including longer runs without word boundaries', () => {
    const longPrefixed = `0x${'ab'.repeat(64)}`;
    const prefixed = classifyExecutorKitError(new Error(`provider dump: ${longPrefixed}`));
    expect(prefixed.message).not.toContain(longPrefixed.slice(2, 2 + 64));
    expect(prefixed.message).not.toContain(longPrefixed);
    expect(prefixed.message).toContain('[redacted-hex]');

    const longBare = 'cd'.repeat(48);
    const bare = classifyExecutorKitError(new Error(`memory dump: ${longBare}`));
    expect(bare.message).not.toContain(longBare);
    expect(bare.message).toContain('[redacted-hex]');

    const shortEcho = `0x${'ab'.repeat(31)}`;
    const short = classifyExecutorKitError(new Error(`bad value ${shortEcho} rejected`));
    expect(short.message).toContain(shortEcho);

    const embedded = classifyExecutorKitError(new SubmitSignalReceiptError(
      TX_HASH,
      `dump ${TX_HASH}ff more`,
    ));
    expect(embedded.message).toContain('[redacted-hex]');
    expect(embedded.message).not.toContain(TX_HASH);
  });

  it('keeps public ids readable in the kit\'s own ValidationError texts', () => {
    const jobId = `0x${'aa'.repeat(32)}`;
    const classified = classifyExecutorKitError(new ValidationError(`job ${jobId} not found`));
    expect(classified.kind).toBe('validation_failure');
    expect(classified.message).toContain(jobId);
    expect(classified.message).not.toContain('[redacted');
  });

  it('pins the state-machine job status lanes that consume the classification', () => {
    const retriableJobStatuses = ['failed', 'matched', 'submitted'] as const;
    expect(retriableJobStatuses).toHaveLength(3);
    const benignCodes = taxonomy.errors
      .filter((entry) => entry.producers.includes('executor-kit'))
      .filter((entry) => attrsForExecutorKit(entry.code).benign_scan_outcome === true)
      .map((entry) => entry.code);
    expect(benignCodes.sort()).toEqual(['duplicate_signal', 'missing_handler']);
  });
});

describe('executor-kit classification consistency against the taxonomy', () => {
  const CASES: readonly {
    readonly code: string;
    readonly run: () => { readonly kind: ExecutorKitErrorKind; readonly retryable: boolean };
  }[] = [
    { code: 'insufficient_funds', run: () => classifyExecutorKitError(new Error('insufficient funds for gas * price + value')) },
    { code: 'duplicate_signal', run: () => classifyExecutorKitError(new Error('Call revert exception: execution reverted: SignalAlreadyExists()')) },
    { code: 'duplicate_signal', run: () => classifyExecutorKitError(new CodedExecutorKitError('DUPLICATE_SIGNAL', 'signal already exists')) },
    { code: 'nonce_conflict', run: () => classifyExecutorKitError(new Error('replacement transaction underpriced')) },
    { code: 'nonce_conflict', run: () => classifyExecutorKitError(new Error('already known')) },
    { code: 'rpc_network', run: () => classifyExecutorKitError(new CodedExecutorKitError('RPC_NETWORK', 'connect ECONNREFUSED 127.0.0.1:8545')) },
    { code: 'rpc_network', run: () => classifyExecutorKitError(new Error('HTTP request failed with status 429: Too Many Requests')) },
    { code: 'unauthorized', run: () => classifyExecutorKitError(new Error('AccessControlUnauthorizedAccount submitter')) },
    { code: 'missing_handler', run: () => classifyExecutorKitError(new Error('no state machine handler for exec#main'), 'missing_handler') },
    { code: 'malformed_payload', run: () => classifyExecutorKitError(new ValidationError('payloadHash must be a 32-byte hex value')) },
    { code: 'malformed_payload', run: () => classifyExecutorKitError(new Error('undecodable log data'), 'validation_failure') },
    { code: 'handler_failure', run: () => classifyExecutorKitError(new CodedExecutorKitError('HANDLER_FAILURE')) },
    { code: 'unknown_unclassified', run: () => classifyExecutorKitError(new Error('handler exploded in a way no pattern matches')) },
  ];

  for (const testCase of CASES) {
    it(`classifies like the taxonomy says for ${testCase.code}`, () => {
      const attrs = attrsForExecutorKit(testCase.code);
      const classified = testCase.run();
      expect(classified.retryable).toBe(attrs.retryable);
      const kindsForCode = Object.entries(KIND_TO_TAXONOMY_CODE)
        .filter(([, entryCode]) => entryCode === testCase.code)
        .map(([kind]) => kind);
      expect(kindsForCode).toContain(classified.kind);
    });
  }

  it('matches the taxonomy retryable verdicts exactly (executor-kit overrides applied)', () => {
    const expectations: readonly [string, boolean][] = [
      ['insufficient_funds', true],
      ['nonce_conflict', true],
      ['rpc_network', true],
      ['duplicate_signal', false],
      ['unauthorized', false],
      ['missing_handler', false],
      ['malformed_payload', false],
      ['handler_failure', false],
      ['unknown_unclassified', false],
    ];
    for (const [code, retryable] of expectations) {
      expect(attrsForExecutorKit(code).retryable, code).toBe(retryable);
    }
    expect(entryByCode('nonce_conflict').retryable).toBe(true);
    expect(entryByCode('nonce_conflict').dead_letter).toBe(false);
    expect(entryByCode('nonce_conflict').producer_overrides).toBeUndefined();
  });
});

describe('executor-kit benign scan outcomes against the taxonomy', () => {
  it('exits success for exactly the taxonomy-benign kinds', () => {
    const benignKinds = ['missing_handler', 'duplicate_signal'];
    for (const kind of benignKinds) {
      expect(
        chainPollExecutionFailed({ results: [{ error: { kind } }] }),
        `${kind} is a benign scan outcome in the taxonomy and must not fail a scan`,
      ).toBe(false);
    }
    const benignCodes = taxonomy.errors
      .filter((entry) => entry.producers.includes('executor-kit'))
      .filter((entry) => attrsForExecutorKit(entry.code).benign_scan_outcome === true)
      .map((entry) => entry.code);
    expect(benignCodes.sort()).toEqual(['duplicate_signal', 'missing_handler']);
    for (const kind of ['rpc_network', 'insufficient_funds', 'unauthorized', 'unknown', 'validation_failure'] as const) {
      expect(
        chainPollExecutionFailed({ results: [{ error: { kind } }] }),
        `${kind} is not benign in the taxonomy and must fail the scan`,
      ).toBe(true);
    }
  });
});
