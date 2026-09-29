import { getSupabase, requireShopId } from "../../app/db.server";
import {
  customBounds,
  dayBounds,
  pageWindow,
  searchTerm,
  serviceMark,
  type DateBounds,
  type OrderDateFilter,
} from "../orders/page";

const LABEL_STATUSES = ["PENDING", "READY", "FAILED"];

export type LabelListQuery = {
  search?: string;
  date?: OrderDateFilter;
  from?: string;
  to?: string;
  status?: string;
  service?: string;
};

export function labelQueryFromParams(params: URLSearchParams): LabelListQuery {
  const date = params.get("date");
  const status = params.get("status") ?? "";
  const service = params.get("service") ?? "";
  return {
    search: params.get("q") ?? "",
    date: date === "today" || date === "yesterday" || date === "custom" ? date : "all",
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    status: LABEL_STATUSES.includes(status) ? status : "",
    service: service === "SP_INLAND_PARCEL" || service === "BUSINESS_PARCEL" ? service : "",
  };
}

export type ListedLabel = {
  id: string;
  shipmentId: string;
  orderId: string;
  orderName: string;
  customer: string;
  service: "SP" | "BP" | null;
  trackingNumber: string | null;
  status: string;
  createdAt: string | null;
  lastError: string | null;
};

function boundsFor(filters: LabelListQuery, timeZone: string): DateBounds | null {
  if (filters.date === "today" || filters.date === "yesterday") return dayBounds(timeZone, filters.date);
  if (filters.date === "custom" && filters.from && filters.to) return customBounds(timeZone, filters.from, filters.to);
  return null;
}

async function candidateLabelIds(shopId: string, term: string) {
  if (!term) return null;
  const { data: orders, error: orderError } = await getSupabase()
    .from("orders")
    .select("id")
    .eq("shop_id", shopId)
    .or(`order_name.ilike."%${term}%",shipping_name.ilike."%${term}%"`);
  if (orderError) throw new Error("Labels could not be loaded");
  const orderIds = (orders ?? []).map((row) => String(row.id));
  const { data: byOrder, error: byOrderError } = orderIds.length
    ? await getSupabase().from("shipments").select("id").eq("shop_id", shopId).in("order_id", orderIds)
    : { data: [], error: null };
  if (byOrderError) throw new Error("Labels could not be loaded");
  const { data: byTrack, error: trackError } = await getSupabase()
    .from("shipments")
    .select("id")
    .eq("shop_id", shopId)
    .ilike("tracking_number", `%${term}%`);
  if (trackError) throw new Error("Labels could not be loaded");
  const shipmentIds = new Set([
    ...(byOrder ?? []).map((row) => String(row.id)),
    ...(byTrack ?? []).map((row) => String(row.id)),
  ]);
  if (/^[0-9a-f-]{8,}$/i.test(term)) {
    const { data: byShipmentId } = await getSupabase().from("shipments").select("id").eq("shop_id", shopId).eq("id", term);
    for (const row of byShipmentId ?? []) shipmentIds.add(String(row.id));
    const { data: byLabelId } = await getSupabase().from("labels").select("id").eq("shop_id", shopId).eq("id", term);
    return [...new Set([...(byLabelId ?? []).map((row) => String(row.id)), ...(await labelsForShipments(shopId, [...shipmentIds]))])];
  }
  return labelsForShipments(shopId, [...shipmentIds]);
}

async function labelsForShipments(shopId: string, shipmentIds: string[]) {
  if (shipmentIds.length === 0) return [];
  const { data, error } = await getSupabase().from("labels").select("id").eq("shop_id", shopId).in("shipment_id", shipmentIds);
  if (error) throw new Error("Labels could not be loaded");
  return (data ?? []).map((row) => String(row.id));
}

export async function listLabels(shopId: string, page: number, filters: LabelListQuery = {}) {
  requireShopId(shopId);
  const window = pageWindow(page);
  const shop = await getSupabase().from("shops").select("timezone").eq("id", shopId).maybeSingle();
  if (shop.error) throw new Error("Labels could not be loaded");
  const timeZone = (shop.data?.timezone as string | null) || "UTC";
  const bounds = boundsFor(filters, timeZone);
  const term = searchTerm(filters.search ?? "");
  const ids = await candidateLabelIds(shopId, term);
  if (term && (!ids || ids.length === 0)) {
    return { labels: [] as ListedLabel[], count: 0, page: window.page, hasPrevious: false, hasNext: false, timeZone };
  }
  let query = getSupabase()
    .from("labels")
    .select("id, shipment_id, status, created_at, last_error", { count: "exact" })
    .eq("shop_id", shopId)
    .eq("kind", "INDIA_POST");
  if (ids) query = query.in("id", ids);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.service) {
    const { data: serviceRows, error: serviceError } = await getSupabase()
      .from("shipments")
      .select("id")
      .eq("shop_id", shopId)
      .eq("service_code", filters.service);
    if (serviceError) throw new Error("Labels could not be loaded");
    const serviceIds = (serviceRows ?? []).map((row) => String(row.id));
    if (serviceIds.length === 0) {
      return { labels: [] as ListedLabel[], count: 0, page: window.page, hasPrevious: false, hasNext: false, timeZone };
    }
    query = query.in("shipment_id", serviceIds);
  }
  if (bounds) query = query.gte("created_at", bounds.start).lt("created_at", bounds.end);
  const { data, error, count } = await query.order("created_at", { ascending: false }).range(window.from, window.to);
  if (error) throw new Error("Labels could not be loaded");
  const rows = data ?? [];
  const shipmentIds = rows.map((row) => String(row.shipment_id));
  const { data: shipments, error: shipmentError } = shipmentIds.length
    ? await getSupabase()
        .from("shipments")
        .select("id, order_id, service_code, tracking_number")
        .eq("shop_id", shopId)
        .in("id", shipmentIds)
    : { data: [], error: null };
  if (shipmentError) throw new Error("Labels could not be loaded");
  const shipmentById = new Map((shipments ?? []).map((row) => [String(row.id), row]));
  const orderIds = [...new Set(rows.map((row) => String(shipmentById.get(String(row.shipment_id))?.order_id ?? "")))].filter(Boolean);
  const { data: orders, error: orderError } = orderIds.length
    ? await getSupabase()
        .from("orders")
        .select("id, order_name, shipping_name")
        .eq("shop_id", shopId)
        .in("id", orderIds)
    : { data: [], error: null };
  if (orderError) throw new Error("Labels could not be loaded");
  const orderById = new Map((orders ?? []).map((row) => [String(row.id), row]));
  const total = count ?? 0;
  return {
    labels: rows.map((row) => toListed(row, shipmentById.get(String(row.shipment_id)), orderById)),
    count: total,
    page: window.page,
    hasPrevious: window.page > 1,
    hasNext: total > window.to + 1,
    timeZone,
  };
}

function toListed(
  row: { id: unknown; shipment_id: unknown; status: unknown; created_at: unknown; last_error?: unknown },
  shipment: { id: unknown; order_id: unknown; service_code: unknown; tracking_number: unknown } | undefined,
  orderById: Map<string, { id: unknown; order_name: unknown; shipping_name: unknown }>,
): ListedLabel {
  const order = shipment ? orderById.get(String(shipment.order_id)) : undefined;
  return {
    id: String(row.id),
    shipmentId: String(row.shipment_id),
    orderId: shipment ? String(shipment.order_id) : "",
    orderName: String(order?.order_name ?? "Order"),
    customer: String(order?.shipping_name ?? "—"),
    service: serviceMark(shipment ? String(shipment.service_code ?? "") : null),
    trackingNumber: shipment ? ((shipment.tracking_number as string | null) ?? null) : null,
    status: String(row.status ?? "PENDING"),
    createdAt: (row.created_at as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
  };
}
