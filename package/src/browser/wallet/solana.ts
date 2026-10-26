/**
 * Solana participant signing reservation: the target is part of the shared
 * chain-target vocabulary but no Solana signer is implemented.
 */
import { UnsupportedChainTargetError } from '../../core/chain-target.js';

export interface SolanaParticipantSigner {
  readonly target: 'solana';
  readonly publicKey?: string;
}

export function requestSolanaProductSubmitSignature(): never {
  throw new UnsupportedChainTargetError('solana', 'solana participant signing is reserved but not implemented');
}
