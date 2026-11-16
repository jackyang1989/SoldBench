// Offline time-window exploration; no observed date is replaced by the scrape date.
const DAY = 86_400_000;
export type SaleTime = { precision: 'instant'; value: string } |
  { precision: 'day'; value: string; timeZone: string | null } |
  { precision: 'unknown' };

export function instant(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw new Error('invalid_utc_instant');
  const t = Date.parse(value);
  if (!Number.isFinite(t) || new Date(t).toISOString().replace('.000Z', 'Z') !== value.replace('.000Z', 'Z')) {
    throw new Error('invalid_utc_instant');
  }
  return t;
}

export function localDay(value: string, timeZone: string): [number, number] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('invalid_source_day');
  const anchor = instant(value + 'T00:00:00Z');
  const format = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dateAt = (ms: number) => {
    const parts = format.formatToParts(ms);
    const get = (type: string) => parts.find(p => p.type === type)!.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  };
  // Binary search UTC bounds, so DST days may be 23/25 hours, or absent entirely.
  const boundary = (strict: boolean) => {
    let lo = anchor - 2 * DAY, hi = anchor + 2 * DAY;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2), date = dateAt(mid);
      if (date > value || (!strict && date === value)) hi = mid; else lo = mid + 1;
    }
    return lo;
  };
  const start = boundary(false), end = boundary(true);
  if (start >= end || dateAt(start) !== value) throw new Error('nonexistent_source_day');
  return [start, end];
}

export function inWindow(time: SaleTime, asOf: string, days: number): boolean {
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new Error('invalid_window');
  const end = instant(asOf), start = end - days * DAY;
  if (time.precision === 'unknown') return false;
  try {
    if (time.precision === 'instant') { const t = instant(time.value); return t > start && t <= end; }
    if (!time.timeZone) return false;
    const [dayStart, dayEnd] = localDay(time.value, time.timeZone);
    // A half-open day ending at the query upper bound is wholly inside it.
    return dayStart > start && dayEnd <= end;
  } catch { return false; }
}
