/**
 * Browser operation client: the same operation set as headless/CLI, signed by
 * the injected EIP-1193 wallet and delivered by either the wallet itself
 * (direct) or a relay (relay). No compiler, no private key, no flow per
 * operation: construction and signing come from core operations.
 */
import type { Address, Hex } from 'viem';
import {
  OperationError,
  createOperationClient,
  type OperationClient,
  type OperationResult,
} from '../core/operations.js';
import {
  createDirectTransport,
  createRelayTransport,
  type OperationFetcher,
  type OperationTransport,
} from '../core/transport.js';
import { normalizeAddressChecksummed, ValidationError } from '../core/validation.js';
import type { Eip1193Provider } from './wallet/provider.js';
import { sendProviderTransaction, signTypedDataWithProvider } from './write.js';

export type BrowserClient = OperationClient;

export interface BrowserClientOptions {
  readonly provider: Eip1193Provider;
  /** Wallet account that signs; direct delivery sends from it too. */
  readonly signer: Address | string;
  readonly mode?: 'direct' | 'relay' | undefined;
  /** Relay service base URL; required in relay mode. */
  readonly relayUrl?: string | undefined;
  readonly relayPath?: string | undefined;
  readonly fetcher?: OperationFetcher | undefined;
  readonly timeoutMs?: number | undefined;
}

export function createBrowserClient(options: BrowserClientOptions): BrowserClient {
  const signer = normalizeAddressChecksummed(options.signer, 'signer');
  const mode = options.mode ?? 'direct';
  const transport = browserTransport(options, signer, mode);
  const client = createOperationClient({
    signer: {
      address: signer,
      signTypedData: (typedData) => signTypedDataWithProvider(options.provider, typedData, signer),
    },
    mode,
    transport,
  });
  return {
    ...client,
    async execute(input) {
      if (input.operation === 'order.birth' && mode === 'relay' && input.role === 'birth-authorizer') {
        throw new OperationError({
          operation: 'order.birth',
          code: 'unsupported_delivery',
          message: 'browser relay mode signs the buyer intent only; the birth authorization is signed'
            + ' by the plan birthAuthorizer, not by the buyer wallet',
        });
      }
      if (input.operation === 'order.birth' && mode === 'direct' && input.role === 'buyer-intent') {
        throw new OperationError({
          operation: 'order.birth',
          code: 'unsupported_delivery',
          message: 'the buyer intent is relay-delivered: direct birth is signed and submitted by the'
            + ' plan birthAuthorizer, not by the buyer wallet',
        });
      }
      return client.execute(input);
    },
  };
}

function browserTransport(
  options: BrowserClientOptions,
  signer: Address,
  mode: 'direct' | 'relay',
): OperationTransport {
  if (mode === 'relay') {
    const relayUrl = options.relayUrl?.trim();
    if (!relayUrl) {
      throw new ValidationError('browser relay mode requires relayUrl');
    }
    return createRelayTransport({
      relayUrl,
      ...(options.relayPath !== undefined ? { relayPath: options.relayPath } : {}),
      ...(options.fetcher !== undefined ? { fetcher: options.fetcher } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }
  return createDirectTransport({
    submitter: {
      sendCall: async (call): Promise<Hex> => sendProviderTransaction(options.provider, {
        from: signer,
        to: call.to,
        data: call.data,
      }),
    },
  });
}
