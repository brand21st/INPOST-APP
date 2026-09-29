export function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

export function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

export function deliverySummary(hours: Array<number | null | undefined>) {
  const samples = hours.filter((value): value is number => Number.isFinite(value) && (value as number) >= 0) as number[];
  if (samples.length < 2) {
    return { enough: false as const, sampleCount: samples.length, avgHours: null, fastestHours: null, longestHours: null };
  }
  const sum = samples.reduce((total, value) => total + value, 0);
  return {
    enough: true as const,
    sampleCount: samples.length,
    avgHours: sum / samples.length,
    fastestHours: Math.min(...samples),
    longestHours: Math.max(...samples),
  };
}

export type CountPair = { current: number; previous: number };

export function withDelta(pair: CountPair) {
  return {
    current: pair.current,
    previous: pair.previous,
    change: percentChange(pair.current, pair.previous),
  };
}

export function csvCell(value: string | number | null | undefined) {
  const text = value == null ? "" : String(value);
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}
