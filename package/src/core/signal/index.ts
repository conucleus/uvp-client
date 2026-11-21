/**
 * Signal surface: HookReady event decode, deterministic submitSignal call
 * building, and stage file reads. ABI and typed-data field tables are
 * single-sourced in @uvp-eth/protocol-bindings; Node transaction submission
 * lives in /headless.
 */
export * from './build.js';
export * from './decode.js';
export * from './files.js';