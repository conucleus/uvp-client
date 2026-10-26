/**
 * SDK public surface: watcher/scan/reorg, signal build/decode/submit,
 * chain-target, signing, validation, evidence hashing, participant wallet, and
 * the executor doctor. The CLI entry point lives in cli.ts; both are built on
 * the same protocol-bindings ABI/typed-data source.
 */
export * from './chain-target.js';
export * from './constants.js';
export * from './doctor.js';
export * from './evidence.js';
export * from './errors.js';
export * from './signing.js';
export * from './transport.js';
export * from './validation.js';
export * from './watcher/index.js';
export * from './wallet.js';
