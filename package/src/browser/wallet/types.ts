/**
 * Wallet签名公有类型面：以 core 的 ChainTarget 为唯一目标词表，定义 EIP-712
 * 信封、域预期与连接器接口；具体注入钱包与私钥处理分别留在宿主适配层和
 * headless 入口，browser 不读取 env/localStorage/私钥。
 */
import type { ProductSubmitTypedData, ProductSubmitTypedDataField } from "@uvp-eth/protocol-bindings";
import { UnsupportedChainTargetError, type ChainTarget } from "../../core/chain-target.js";
import type { Eip1193Provider } from "./provider.js";

export type WalletTarget = ChainTarget;

export type GenericTypedData = Readonly<{
  readonly domain: Readonly<Record<string, unknown>>;
  readonly types: Readonly<Record<string, readonly ProductSubmitTypedDataField[]>>;
  readonly primaryType: string;
  readonly message: Readonly<Record<string, unknown>>;
}>;

export interface TypedDataDomainExpectation {
  readonly chainId?: number | undefined;
  readonly verifyingContract?: string | undefined;
}

export interface WalletConnector {
  readonly target: WalletTarget;
  signProductSubmit(input: {
    readonly typedData: ProductSubmitTypedData;
    readonly walletAddress: string;
    readonly provider?: Eip1193Provider;
    readonly expected?: TypedDataDomainExpectation | undefined;
    readonly preparedSubmitters?: readonly (string | undefined)[] | undefined;
  }): Promise<`0x${string}`>;
  signTypedData(input: {
    readonly typedData: GenericTypedData;
    readonly walletAddress: string;
    readonly provider?: Eip1193Provider;
    readonly expected?: TypedDataDomainExpectation | undefined;
    readonly preparedSubmitters?: readonly (string | undefined)[] | undefined;
  }): Promise<`0x${string}`>;
}

export function walletConnectorFor<C>(target: WalletTarget, evmConnector: C): C {
  if (target === "evm") {
    return evmConnector;
  }
  throw new UnsupportedChainTargetError(target, "solana wallet connector is reserved but not implemented");
}
