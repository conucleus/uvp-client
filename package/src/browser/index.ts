/**
 * Browser-host entry: injected EIP-1193 wallet/signing, Product V3 transport
 * client, participant session read model, deadline/format derivations, and
 * product typed-data verification. Host injects the provider and session
 * token; this entry never reads env/localStorage/private keys.
 */
export * from './product/kernel/index.js';
export * from './wallet/index.js';
export * from './write.js';
export * from './session/index.js';
export * from './tasks/deadline.js';
export * from './format/index.js';
