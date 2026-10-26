// 任务 deadline 的 UTC 解析与展示：服务端下发的朴素字符串不带时区符，
// 按浏览器本地时区解析会让排序/逾期分桶随时区漂移；本模块统一补 Z 按 UTC
// 解析，解析不了返回 undefined 或原串，不臆造时刻。

const HAS_ZONE_DESIGNATOR = /[Zz]$|[+-]\d{2}:?\d{2}$/;

export function parseDeadlineUtcMs(value: string): number | undefined {
  const normalized = value.trim().replace(" ", "T");
  if (!normalized) {
    return undefined;
  }
  const withZone = HAS_ZONE_DESIGNATOR.test(normalized) ? normalized : `${normalized}Z`;
  const parsed = Date.parse(withZone);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 排序用 deadline 毫秒：解析不了排最后。 */
export function deadlineSortMs(deadline: string): number {
  return parseDeadlineUtcMs(deadline) ?? Number.MAX_SAFE_INTEGER;
}

/** deadline 展示：表必须带 UTC 标注；解析不了原样返回。 */
export function formatDeadlineUtc(deadline: string): string {
  const ms = parseDeadlineUtcMs(deadline);
  if (ms === undefined) {
    return deadline;
  }
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
