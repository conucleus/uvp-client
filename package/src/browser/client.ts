/**
 * Browser operation client: the same operation set as headless/CLI, signed by
 * the injected EIP-1193 wallet and delivered by either the wallet itself
 * (direct) or a relay (relay). Direct signal submissions carry an empty
 * signature (the wallet is the submitter), so they need no typed-data prompt.
 */
import type { Address, Hex } from 'viem';
import {
  createOperationClient,
  type OperationClient,
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
  /** Relay endpoint path or absolute URL; required in relay mode. */
  readonly relayPath?: string | undefined;
  readonly fetcher?: OperationFetcher | undefined;
  readonly timeoutMs?: number | undefined;
}

export function createBrowserClient(options: BrowserClientOptions): BrowserClient {
  const signer = normalizeAddressChecksummed(options.signer, 'signer');
  const mode = options.mode ?? 'direct';
  return createOperationClient({
    signer: {
      address: signer,
      signTypedData: (typedData) => signTypedDataWithProvider(options.provider, typedData, signer),
    },
    transport: browserTransport(options, signer, mode),
  });
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
    const relayPath = options.relayPath?.trim();
    if (!relayPath) {
      throw new ValidationError('browser relay mode requires relayPath');
    }
    return createRelayTransport({
      relayUrl,
      relayPath,
      ...(options.fetcher !== undefined ? { fetcher: options.fetcher } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }
  return createDirectTransport({
    submitter: {
      readChainId: () => readProviderChainId(options.provider),
      sendCall: async (call): Promise<Hex> => sendProviderTransaction(options.provider, {
        from: signer,
        to: call.to,
        data: call.data,
      }),
    },
  });
}

async function readProviderChainId(provider: Eip1193Provider): Promise<number> {
  const raw = await provider.request({ method: 'eth_chainId' });
  if (typeof raw !== 'string' || !/^0x[0-9a-f]+$/i.test(raw)) {
    throw new ValidationError('wallet returned an invalid chain id');
  }
  return Number(BigInt(raw));
}
