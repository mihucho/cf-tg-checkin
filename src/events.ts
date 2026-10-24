/** 埋点的纯计算部分（便于单测） */

export interface RunSample {
  ok: boolean;
  at: number;
}

export interface DailyBucket {
  /** 本地日期，形如 10-24 */
  date: string;
  ok: number;
  fail: number;
}

/**
 * 把执行事件按「本地日」分桶，返回最近 days 天（含今天），没有数据的天补 0。
 * tzHours 与设置里的时区一致（Asia/Shanghai = 8）。
 */
export function bucketDaily(
  samples: RunSample[],
  options: { now: number; tzHours: number; days?: number },
): DailyBucket[] {
  const days = Math.max(1, Math.min(30, options.days ?? 7));
  const shift = options.tzHours * 3600 * 1000;
  const dayMs = 86400 * 1000;

  const keyOf = (at: number) => new Date(at + shift).toISOString().slice(0, 10);
  const todayStart = Math.floor((options.now + shift) / dayMs) * dayMs;

  const buckets = new Map<string, DailyBucket>();
  const ordered: DailyBucket[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(todayStart - i * dayMs).toISOString().slice(0, 10);
    const bucket: DailyBucket = { date: date.slice(5), ok: 0, fail: 0 };
    buckets.set(date, bucket);
    ordered.push(bucket);
  }

  for (const sample of samples) {
    const bucket = buckets.get(keyOf(sample.at));
    if (!bucket) continue;
    if (sample.ok) bucket.ok += 1;
    else bucket.fail += 1;
  }

  return ordered;
}
