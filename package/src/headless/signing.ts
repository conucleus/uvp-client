/**
 * Headless private-key loading: the only entry that reads process.env or handles
 * a local private key; /core stays runtime-agnostic.
 */
import type { Hex } from 'viem';
import { DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV } from '../core/signal/build.js';
import { ValidationError } from '../core/validation.js';

export const DEFAULT_SIGNING_KEY_ENV = DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV;

export function loadPrivateKeyFromEnv(envName = DEFAULT_SIGNING_KEY_ENV): Hex | undefined {
  const value = process.env[envName];
  if (!value) {
    return undefined;
  }

  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new ValidationError(`${envName} must contain a 32-byte private key hex string`);
  }

  return value as Hex;
}
