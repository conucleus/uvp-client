// EIP-1193 提供方的最小形状与浏览器注入查找：kernel 只依赖 request 方法，
// 不合并全局 Window 类型；宿主可注入自己的提供方，浏览器宿主也可直接用本
// 查找器取 window.ethereum。

export interface Eip1193Provider {
  request(args: { readonly method: string; readonly params?: readonly unknown[] }): Promise<unknown>;
}

export function getBrowserEthereumProvider(): Eip1193Provider | undefined {
  const browserWindow = (globalThis as { readonly window?: { readonly ethereum?: unknown } }).window;
  if (!browserWindow) {
    return undefined;
  }
  const injected = browserWindow.ethereum;
  if (!injected || typeof injected !== "object") {
    return undefined;
  }
  const candidate = injected as Partial<Eip1193Provider>;
  return typeof candidate.request === "function" ? (candidate as Eip1193Provider) : undefined;
}
