// 钱包门禁的公有错误类型：code 保留失败分类供宿主映射文案，message 只承载
// 面向参与者的可读说明；底层钱包拒绝的机械识别由宿主适配层完成。

export class InjectedWalletError extends Error {
  override readonly name = "InjectedWalletError";

  constructor(
    readonly code:
      | "missing_wallet"
      | "wallet_rejected"
      | "wallet_signature_failed"
      | "typed_data_mismatch",
    message: string
  ) {
    super(message);
  }
}
