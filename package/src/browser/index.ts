/**
 * Browser-host entry: injected EIP-1193 operation client (same operation set as
 * headless/CLI, direct or relay), wallet signing primitives, deadline/format
 * derivations, the D13 stage executor change
 * typed-data surface, and the D4b write-signature entrance. Used-car product
 * transports/kernels live in @used-car/product-client; this entry never reads
 * env/localStorage/private keys and never imports the compiler.
 */
export * from './client.js';
export * from './wallet/index.js';
export * from './write.js';
export * from './stage-executor-change.js';
export * from './tasks/deadline.js';
export * from './format/index.js';
