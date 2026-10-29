/**
 * Chain-read entry: typed HTTP client for chain-services' generic `/chain/*`
 * projection reads and the revived bigint projection decoders. The wire DTOs
 * and structural decoders are single-sourced in @uvp-eth/chain-read-contract;
 * this entry adds fetch/error classification and the bigint view.
 */
export * from "./client.js";
export * from "./projection.js";
