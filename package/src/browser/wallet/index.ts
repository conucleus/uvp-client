/**
 * Browser wallet surface: minimal EIP-1193 provider lookup, wallet connector
 * types, typed-data domain expectations, injected-wallet EIP-712 signing, and
 * the shared chain-target vocabulary. No env/localStorage/private-key access.
 */
export * from "./provider.js";
export * from "./types.js";
export * from "./errors.js";
export * from "./signing.js";
export * from "./solana.js";

export {
  UnsupportedChainTargetError,
  type ChainTarget,
} from "../../core/chain-target.js";
