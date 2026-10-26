// 参与者会话的纯读模型：walletAddress 是宿主已解析出的参与者身份，
// walletSource 只记录该值的来源；env/地址栏/localStorage 解析与钱包会话
// 建立（challenge/签名/verify）都在宿主，本模块不做任何浏览器或策略判断。

export interface ParticipantSession {
  readonly walletAddress?: string | undefined;
  readonly walletSource?: "env" | "override" | undefined;
}

export function shortWallet(walletAddress: string | undefined): string {
  if (!walletAddress) {
    return "未绑定钱包";
  }
  return `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
}
