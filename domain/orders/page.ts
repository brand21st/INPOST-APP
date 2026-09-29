export const ORDER_PAGE_SIZE = 25;

export class ShopifyThrottleError extends Error {
  constructor() {
    super("Shopify rate limit");
    this.name = "ShopifyThrottleError";
  }
}

export type OrdersPageInfo = {
  hasNextPage: boolean;
  endCursor: string | null;
};

type ThrottleBody = {
  errors?: Array<{ extensions?: { code?: string } } | string>;
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      throttleStatus?: { currentlyAvailable?: number };
    };
  };
  data?: {
    orders?: {
      pageInfo?: OrdersPageInfo;
    };
  };
};

export function isShopifyThrottled(body: ThrottleBody): boolean {
  const throttledError = (body.errors ?? []).some(
    (error) => typeof error !== "string" && error.extensions?.code === "THROTTLED",
  );
  if (throttledError) return true;
  const cost = body.extensions?.cost;
  const available = cost?.throttleStatus?.currentlyAvailable;
  const requested = cost?.requestedQueryCost;
  // A successful page still reports remaining budget below the cost already spent.
  // Only a response with no order page is treated as not yet written.
  return available != null && requested != null && available < requested && !body.data?.orders;
}

export function nextCursorAfterPage(pageInfo: OrdersPageInfo | undefined): string | null {
  if (!pageInfo?.hasNextPage || !pageInfo.endCursor) return null;
  return pageInfo.endCursor;
}

export function cursorIfPageAccepted(body: ThrottleBody): string | null {
  if (isShopifyThrottled(body)) return null;
  return nextCursorAfterPage(body.data?.orders?.pageInfo);
}

export function pageWindow(page: number, size = ORDER_PAGE_SIZE) {
  const safe = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const from = (safe - 1) * size;
  return { page: safe, from, to: from + size - 1 };
}

export function pageCount(total: number, size = ORDER_PAGE_SIZE) {
  if (total <= 0) return 0;
  return Math.ceil(total / size);
}

export function ordersForShop(sessionShopId: string, browserShopId?: string | null) {
  void browserShopId;
  return sessionShopId;
}

export function searchTerm(value: string | null) {
  return (value ?? "").trim().replace(/[%_,.()]/g, "");
}

export type OrderDateFilter = "all" | "today" | "yesterday" | "custom";

export type OrderListQuery = {
  search?: string;
  date?: OrderDateFilter;
  from?: string;
  to?: string;
  status?: string;
  payment?: string;
  source?: string;
};

export function orderQueryFromParams(params: URLSearchParams): OrderListQuery {
  const date = params.get("date");
  const status = params.get("status");
  const source = params.get("source");
  return {
    search: params.get("q") ?? "",
    date: date === "today" || date === "yesterday" || date === "custom" ? date : "all",
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    status: status === "READY" || status === "CANCELLED" ? status : "",
    payment: params.get("payment") ?? "",
    source: source === "shopify" ? "shopify" : "",
  };
}

export type DateBounds = { start: string; end: string };

function zonedParts(date: Date, timeZone: string) {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const parts: Record<string, string> = {};
  for (const part of formatted) parts[part.type] = part.value;
  return parts;
}

function offsetMs(date: Date, timeZone: string) {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

function startOfZonedDay(year: number, month: number, day: number, timeZone: string) {
  const guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  return new Date(guess.getTime() - offsetMs(guess, timeZone));
}

export function dayBounds(timeZone: string, day: "today" | "yesterday", now = new Date()): DateBounds {
  const zone = timeZone || "UTC";
  const parts = zonedParts(now, zone);
  let year = Number(parts.year);
  let month = Number(parts.month);
  let date = Number(parts.day);
  if (day === "yesterday") {
    const previous = new Date(Date.UTC(year, month - 1, date) - 86_400_000);
    year = previous.getUTCFullYear();
    month = previous.getUTCMonth() + 1;
    date = previous.getUTCDate();
  }
  const start = startOfZonedDay(year, month, date, zone);
  const end = startOfZonedDay(year, month, date + 1, zone);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function customBounds(timeZone: string, from: string, to: string): DateBounds | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return null;
  const zone = timeZone || "UTC";
  const [fromYear, fromMonth, fromDay] = from.split("-").map(Number);
  const [toYear, toMonth, toDay] = to.split("-").map(Number);
  const start = startOfZonedDay(fromYear, fromMonth, fromDay, zone);
  const end = startOfZonedDay(toYear, toMonth, toDay + 1, zone);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function paymentLabel(financialStatus: string | null, paymentMode: string | null) {
  if (paymentMode === "COD") return "COD";
  const status = (financialStatus ?? "").toUpperCase();
  if (status === "PAID") return "Paid";
  if (status === "PENDING" || status === "AUTHORIZED") return "Pending";
  if (status === "PARTIALLY_PAID") return "Partially paid";
  if (!status) return "—";
  const words = status.toLowerCase().replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function serviceMark(serviceCode: string | null | undefined) {
  if (serviceCode === "BUSINESS_PARCEL" || serviceCode === "BP") return "BP";
  if (serviceCode === "SP_INLAND_PARCEL" || serviceCode === "SP") return "SP";
  return null;
}

export function formatMoney(amount: number | null, currency: string | null) {
  const code = currency && /^[A-Z]{3}$/.test(currency) ? currency : "INR";
  const value = Number(amount ?? 0);
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: code }).format(value);
  } catch {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(value);
  }
}

export function formatCreated(value: string | null, timeZone: string | null) {
  if (!value) return { date: "—", time: "" };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { date: "—", time: "" };
  const zone = timeZone || "UTC";
  return {
    date: new Intl.DateTimeFormat("en-IN", {
      timeZone: zone,
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(date),
    time: new Intl.DateTimeFormat("en-IN", {
      timeZone: zone,
      hour: "numeric",
      minute: "2-digit",
    }).format(date),
  };
}
