// 金额展示：base units 十进制字符串 → 分组小数文本；只做显示派生，不参与裁决。

export function formatBaseUnits(raw: string, decimals: number): string {
  const value = raw.trim();
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(decimals) || decimals < 0) {
    return raw;
  }
  const padded = value.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals);
  return decimals === 0
    ? groupThousands(whole)
    : `${groupThousands(whole)}.${fraction}`;
}

function groupThousands(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}
