import { getSupabase, requireShopId } from "../../app/db.server";
import { formatMoney, type DateBounds } from "../orders/page";
import { csvCell, ratio, withDelta } from "./metrics";
import { previousBounds, rangeLabel, type AnalyticsQuery } from "./range";
import { type AnalyticsSnapshot, type ServiceSlice } from "./types";

const cache = new Map<string, { expires: number; value: AnalyticsSnapshot }>();

export function clearAnalyticsCache() {
  cache.clear();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function num(value: unknown) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function pair(value: unknown) {
  const row = asRecord(value);
  return { current: num(row.current), previous: num(row.previous) };
}

function slice(value: unknown): ServiceSlice {
  const row = asRecord(value);
  return {
    orders: num(row.orders),
    shipments: num(row.shipments),
    labelsGenerated: num(row.labelsGenerated),
    inTransit: num(row.inTransit),
    delivered: num(row.delivered),
    returned: num(row.returned),
    codOrders: num(row.codOrders),
  };
}

export function decorateAnalytics(raw: unknown, range: DateBounds, fetchedAt = new Date().toISOString()): AnalyticsSnapshot {
  const data = asRecord(raw);
  const kpis = asRecord(data.kpis);
  const orders = asRecord(data.orders);
  const shipping = asRecord(data.shipping);
  const services = asRecord(data.services);
  const delivery = asRecord(data.delivery);
  const cod = asRecord(data.cod);
  const returns = asRecord(data.returns);
  const timezone = String(data.timezone || "UTC");
  const sampleCount = num(delivery.sampleCount);
  const enough = sampleCount >= 2 && delivery.avgHours != null;
  const delivered = num(delivery.delivered);
  const failed = num(asRecord(data.shipping).failedDelivery);
  const rto = num(shipping.returned);
  const booked = num(returns.booked);
  return {
    shopOrderCount: num(data.shopOrderCount),
    currency: String(data.currency || "INR"),
    timezone,
    rangeLabel: rangeLabel(range, timezone),
    fetchedAt,
    kpis: {
      ordersReceived: withDelta(pair(kpis.ordersReceived)),
      ordersShipped: withDelta(pair(kpis.ordersShipped)),
      inTransit: withDelta(pair(kpis.inTransit)),
      delivered: withDelta(pair(kpis.delivered)),
      returned: withDelta(pair(kpis.returned)),
      codOrders: withDelta(pair(kpis.codOrders)),
    },
    orders: {
      total: num(orders.total),
      new: num(orders.new),
      shipped: num(orders.shipped),
      pendingShipment: num(orders.pendingShipment),
      cancelled: num(orders.cancelled),
      returned: num(orders.returned),
    },
    shipping: {
      total: num(shipping.total),
      created: num(shipping.created),
      labelsGenerated: num(shipping.labelsGenerated),
      labelsPrinted: null,
      inTransit: num(shipping.inTransit),
      delivered: num(shipping.delivered),
      failedDelivery: failed,
      returned: rto,
    },
    services: {
      SP_INLAND_PARCEL: slice(services.SP_INLAND_PARCEL),
      BUSINESS_PARCEL: slice(services.BUSINESS_PARCEL),
    },
    delivery: {
      delivered,
      inTransit: num(delivery.inTransit),
      enough,
      sampleCount,
      avgHours: enough ? num(delivery.avgHours) : null,
      fastestHours: enough ? num(delivery.fastestHours) : null,
      longestHours: enough ? num(delivery.longestHours) : null,
      successRate: ratio(delivered, delivered + failed + rto),
      returnRate: ratio(rto, delivered + failed + rto),
    },
    cod: {
      orders: num(cod.orders),
      orderValue: num(cod.orderValue),
      delivered: num(cod.delivered),
      returned: num(cod.returned),
      pending: num(cod.pending),
      collected: num(cod.collected),
      pendingValue: num(cod.pendingValue),
      returnedValue: num(cod.returnedValue),
      deliveryRate: ratio(num(cod.delivered), num(cod.orders)),
      returnRate: ratio(num(cod.returned), num(cod.orders)),
    },
    returns: {
      orders: num(returns.orders),
      shipments: num(returns.shipments),
      rate: ratio(num(returns.shipments), booked),
      cod: num(returns.cod),
      speedPost: num(returns.speedPost),
      businessParcel: num(returns.businessParcel),
    },
    pincodes: Array.isArray(data.pincodes)
      ? data.pincodes.map((row) => {
          const item = asRecord(row);
          return { pincode: String(item.pincode ?? "Unknown"), shipments: num(item.shipments) };
        })
      : [],
    trends: Array.isArray(data.trends)
      ? data.trends.map((row) => {
          const item = asRecord(row);
          return {
            day: String(item.day ?? ""),
            orders: num(item.orders),
            shipments: num(item.shipments),
            delivered: num(item.delivered),
            returns: num(item.returns),
          };
        })
      : [],
    status: {
      shopifyOrder: asRecord(asRecord(data.status).shopifyOrder) as Record<string, number>,
      shopifyFulfillment: asRecord(asRecord(data.status).shopifyFulfillment) as Record<string, number>,
      inpost: asRecord(asRecord(data.status).inpost) as Record<string, number>,
      tracking: asRecord(asRecord(data.status).tracking) as Record<string, number>,
    },
    activity: Array.isArray(data.activity)
      ? data.activity.map((row) => {
          const item = asRecord(row);
          return {
            event: String(item.event ?? ""),
            reference: String(item.reference ?? ""),
            at: String(item.at ?? ""),
            status: String(item.status ?? ""),
          };
        })
      : [],
  };
}

export async function loadAnalytics(shopId: string, range: DateBounds, service = "") {
  requireShopId(shopId);
  const key = `${shopId}:${range.start}:${range.end}:${service}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const shop = await getSupabase().from("shops").select("currency, timezone").eq("id", shopId).maybeSingle();
  if (shop.error) throw new Error("Analytics could not be loaded");
  const timezone = (shop.data?.timezone as string | null) || "UTC";
  const previous = previousBounds(range);
  const { data, error } = await getSupabase().rpc("shop_analytics", {
    p_shop_id: shopId,
    p_from: range.start,
    p_to: range.end,
    p_prev_from: previous.start,
    p_prev_to: previous.end,
    p_service: service,
    p_tz: timezone,
  });
  if (error) throw new Error("Analytics could not be loaded");
  const snapshot = decorateAnalytics(data, range);
  cache.set(key, { expires: Date.now() + 10_000, value: snapshot });
  return snapshot;
}

export function analyticsCsv(snapshot: AnalyticsSnapshot, query: AnalyticsQuery) {
  const money = (value: number) => formatMoney(value, snapshot.currency);
  const lines = [
    ["Metric", "Value"].map(csvCell).join(","),
    ["Range", snapshot.rangeLabel],
    ["Service", query.service || "All"],
    ["Orders received", snapshot.kpis.ordersReceived.current],
    ["Orders shipped", snapshot.kpis.ordersShipped.current],
    ["In transit", snapshot.kpis.inTransit.current],
    ["Delivered", snapshot.kpis.delivered.current],
    ["Returned", snapshot.kpis.returned.current],
    ["COD orders", snapshot.cod.orders],
    ["COD order value", money(snapshot.cod.orderValue)],
    ["COD collected", money(snapshot.cod.collected)],
    ["Labels generated", snapshot.shipping.labelsGenerated],
    ["Labels printed", "Not available"],
    ["Speed Post orders", snapshot.services.SP_INLAND_PARCEL.orders],
    ["Business Parcel orders", snapshot.services.BUSINESS_PARCEL.orders],
  ].map((row) => (Array.isArray(row) ? row.map(csvCell).join(",") : row));
  lines.push(["Pincode", "Shipments"].map(csvCell).join(","));
  for (const row of snapshot.pincodes) lines.push([row.pincode, row.shipments].map(csvCell).join(","));
  return `${lines.join("\n")}\n`;
}
