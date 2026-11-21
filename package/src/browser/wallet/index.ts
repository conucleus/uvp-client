/**
 * Browser wallet surface: EIP-1193 provider lookup, connector types, injected
 * EIP-712 signing, transport failure/receipt diagnostics, and the shared
 * chain-target vocabulary. No env/localStorage/private-key access.
 */
export * from "./provider.js";
export * from "./types.js";
export * from "./errors.js";
export * from "./signing.js";
export * from "./solana.js";
export * from "./transport.js";

export {
  UnsupportedChainTargetError,
  type ChainTarget,
} from "../../core/chain-target.js";
