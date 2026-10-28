/**
 * Browser-host entry: injected EIP-1193 operation client (same operation set as
 * headless/CLI, direct or relay), wallet signing primitives, Product V3
 * transport client, participant session read model, deadline/format
 * derivations, product typed-data verification, the D13 stage executor
 * change typed-data surface, and the D4b write-signature entrance. Host injects the provider and session token; this
 * entry never reads env/localStorage/private keys and never imports the
 * compiler.
 */
export * from './client.js';
export * from './product/kernel/index.js';
export * from './wallet/index.js';
export * from './write.js';
export * from './session/index.js';
export * from './stage-executor-change.js';
export * from './app-write.js';
export * from './tasks/deadline.js';
export * from './format/index.js';
