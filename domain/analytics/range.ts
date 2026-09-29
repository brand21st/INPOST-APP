import { customBounds, dayBounds, type DateBounds } from "../orders/page";

export type AnalyticsPreset =
  | "today"
  | "yesterday"
  | "last_7"
  | "last_30"
  | "this_month"
  | "last_month"
  | "custom";

export type AnalyticsQuery = {
  preset: AnalyticsPreset;
  from?: string;
  to?: string;
  service?: string;
};

const PRESETS: AnalyticsPreset[] = [
  "today",
  "yesterday",
  "last_7",
  "last_30",
  "this_month",
  "last_month",
  "custom",
];

function zonedYmd(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function shiftYmd(ymd: string, days: number) {
  const [year, month, day] = ymd.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

export function analyticsQueryFromParams(params: URLSearchParams): AnalyticsQuery {
  const preset = params.get("preset");
  const service = params.get("service") ?? "";
  return {
    preset: PRESETS.includes(preset as AnalyticsPreset) ? (preset as AnalyticsPreset) : "last_7",
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    service: service === "SP_INLAND_PARCEL" || service === "BUSINESS_PARCEL" ? service : "",
  };
}

export function analyticsBounds(
  timeZone: string,
  query: AnalyticsQuery,
  now = new Date(),
): DateBounds | null {
  const zone = timeZone || "UTC";
  if (query.preset === "today") return dayBounds(zone, "today", now);
  if (query.preset === "yesterday") return dayBounds(zone, "yesterday", now);
  if (query.preset === "custom") return customBounds(zone, query.from ?? "", query.to ?? "");
  const todayYmd = zonedYmd(now, zone);
  if (query.preset === "last_7") return customBounds(zone, shiftYmd(todayYmd, -6), todayYmd);
  if (query.preset === "last_30") return customBounds(zone, shiftYmd(todayYmd, -29), todayYmd);
  const [year, month] = todayYmd.split("-").map(Number);
  if (query.preset === "this_month") {
    const start = `${year}-${String(month).padStart(2, "0")}-01`;
    return customBounds(zone, start, todayYmd);
  }
  const lastMonthDate = new Date(Date.UTC(year, month - 2, 1));
  const lastYear = lastMonthDate.getUTCFullYear();
  const lastMonth = lastMonthDate.getUTCMonth() + 1;
  const lastStart = `${lastYear}-${String(lastMonth).padStart(2, "0")}-01`;
  const lastEndDay = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();
  const lastEnd = `${lastYear}-${String(lastMonth).padStart(2, "0")}-${String(lastEndDay).padStart(2, "0")}`;
  return customBounds(zone, lastStart, lastEnd);
}

export function previousBounds(range: DateBounds): DateBounds {
  const start = new Date(range.start).getTime();
  const end = new Date(range.end).getTime();
  const span = end - start;
  return { start: new Date(start - span).toISOString(), end: range.start };
}

export function rangeLabel(range: DateBounds, timeZone: string) {
  const zone = timeZone || "UTC";
  const start = new Intl.DateTimeFormat("en-IN", { timeZone: zone, dateStyle: "medium" }).format(new Date(range.start));
  const endInclusive = new Date(new Date(range.end).getTime() - 1000);
  const end = new Intl.DateTimeFormat("en-IN", { timeZone: zone, dateStyle: "medium" }).format(endInclusive);
  return `${start} – ${end}`;
}
