/**
 * Headless operation client: the same operation set as browser/CLI, signed by a
 * local private key and delivered by RPC (direct) or a relay (relay). Compiler
 * and watcher stay separate headless extras, never operations.
 */
import { createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createOperationClient,
  type OperationClient,
} from '../core/operations.js';
import {
  createDirectTransport,
  createRelayTransport,
  type OperationFetcher,
} from '../core/transport.js';
import { ValidationError } from '../core/validation.js';

export type HeadlessClient = OperationClient;

export interface HeadlessClientOptions {
  readonly privateKey: Hex;
  readonly mode?: 'direct' | 'relay' | undefined;
  /** RPC URL used by direct delivery. */
  readonly rpcUrl?: string | undefined;
  /** Relay service base URL; required in relay mode. */
  readonly relayUrl?: string | undefined;
  readonly relayPath?: string | undefined;
  readonly fetcher?: OperationFetcher | undefined;
  readonly timeoutMs?: number | undefined;
}

export function createHeadlessClient(options: HeadlessClientOptions): HeadlessClient {
  const account = privateKeyToAccount(options.privateKey);
  const mode = options.mode ?? 'direct';
  if (mode === 'direct') {
    const rpcUrl = options.rpcUrl?.trim();
    if (!rpcUrl) {
      throw new ValidationError('headless direct mode requires rpcUrl');
    }
    const wallet = createWalletClient({ account, transport: http(rpcUrl) });
    return createOperationClient({
      signer: {
        address: account.address,
        signTypedData: (typedData) => account.signTypedData(typedData),
      },
      mode,
      transport: createDirectTransport({
        submitter: {
          sendCall: async (call): Promise<Hex> => wallet.sendTransaction({
            account,
            to: call.to,
            data: call.data,
            chain: null,
          }),
        },
      }),
    });
  }
  const relayUrl = options.relayUrl?.trim();
  if (!relayUrl) {
    throw new ValidationError('headless relay mode requires relayUrl');
  }
  return createOperationClient({
    signer: {
      address: account.address,
      signTypedData: (typedData) => account.signTypedData(typedData),
    },
    mode,
    transport: createRelayTransport({
      relayUrl,
      ...(options.relayPath !== undefined ? { relayPath: options.relayPath } : {}),
      ...(options.fetcher !== undefined ? { fetcher: options.fetcher } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    }),
  });
}
