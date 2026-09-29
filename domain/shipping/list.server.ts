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
import { enqueueJob } from "../tenancy/shops.server";

const SHIPMENT_STATUSES = [
  "DRAFT",
  "QUEUED",
  "BOOKING",
  "BOOKED",
  "LABEL_READY",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "NDR",
  "RTO",
  "FAILED",
  "CANCELLED",
];

export type ShipmentListQuery = {
  search?: string;
  date?: OrderDateFilter;
  from?: string;
  to?: string;
  status?: string;
  service?: string;
};

export function shipmentQueryFromParams(params: URLSearchParams): ShipmentListQuery {
  const date = params.get("date");
  const status = params.get("status") ?? "";
  const service = params.get("service") ?? "";
  return {
    search: params.get("q") ?? "",
    date: date === "today" || date === "yesterday" || date === "custom" ? date : "all",
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    status: SHIPMENT_STATUSES.includes(status) ? status : "",
    service: service === "SP_INLAND_PARCEL" || service === "BUSINESS_PARCEL" ? service : "",
  };
}

export type ListedShipment = {
  id: string;
  orderId: string;
  orderName: string;
  customer: string;
  destination: string;
  pincode: string;
  service: "SP" | "BP" | null;
  trackingNumber: string | null;
  status: string;
  createdAt: string | null;
  labelId: string | null;
  labelStatus: string | null;
  lastTrackingSyncedAt: string | null;
  lastTrackingLocation: string | null;
};

function boundsFor(filters: ShipmentListQuery, timeZone: string): DateBounds | null {
  if (filters.date === "today" || filters.date === "yesterday") return dayBounds(timeZone, filters.date);
  if (filters.date === "custom" && filters.from && filters.to) return customBounds(timeZone, filters.from, filters.to);
  return null;
}

async function candidateShipmentIds(shopId: string, term: string) {
  if (!term) return null;
  const { data: orders, error: orderError } = await getSupabase()
    .from("orders")
    .select("id")
    .eq("shop_id", shopId)
    .or(`order_name.ilike."%${term}%",shipping_name.ilike."%${term}%",pincode.ilike."%${term}%"`);
  if (orderError) throw new Error("Shipments could not be loaded");
  const fromOrders = (orders ?? []).map((row) => String(row.id));
  const { data: byOrder, error: byOrderError } = fromOrders.length
    ? await getSupabase().from("shipments").select("id").eq("shop_id", shopId).in("order_id", fromOrders)
    : { data: [], error: null };
  if (byOrderError) throw new Error("Shipments could not be loaded");
  const { data: byTrack, error: trackError } = await getSupabase()
    .from("shipments")
    .select("id")
    .eq("shop_id", shopId)
    .ilike("tracking_number", `%${term}%`);
  if (trackError) throw new Error("Shipments could not be loaded");
  const ids = new Set([
    ...(byOrder ?? []).map((row) => String(row.id)),
    ...(byTrack ?? []).map((row) => String(row.id)),
  ]);
  if (/^[0-9a-f-]{8,}$/i.test(term)) {
    const { data: byId } = await getSupabase().from("shipments").select("id").eq("shop_id", shopId).eq("id", term);
    for (const row of byId ?? []) ids.add(String(row.id));
  }
  return [...ids];
}

export async function listShipments(shopId: string, page: number, filters: ShipmentListQuery = {}) {
  requireShopId(shopId);
  const window = pageWindow(page);
  const shop = await getSupabase().from("shops").select("timezone").eq("id", shopId).maybeSingle();
  if (shop.error) throw new Error("Shipments could not be loaded");
  const timeZone = (shop.data?.timezone as string | null) || "UTC";
  const bounds = boundsFor(filters, timeZone);
  const term = searchTerm(filters.search ?? "");
  const ids = await candidateShipmentIds(shopId, term);
  if (term && (!ids || ids.length === 0)) {
    return { shipments: [] as ListedShipment[], count: 0, page: window.page, hasPrevious: false, hasNext: false, timeZone };
  }
  let query = getSupabase()
    .from("shipments")
    .select(
      "id, order_id, service_code, tracking_number, status, created_at, weight_grams, last_error, last_tracking_synced_at, last_tracking_location",
      { count: "exact" },
    )
    .eq("shop_id", shopId);
  if (ids) query = query.in("id", ids);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.service) query = query.eq("service_code", filters.service);
  if (bounds) query = query.gte("created_at", bounds.start).lt("created_at", bounds.end);
  const { data, error, count } = await query.order("created_at", { ascending: false }).range(window.from, window.to);
  if (error) throw new Error("Shipments could not be loaded");
  const rows = data ?? [];
  const orderIds = [...new Set(rows.map((row) => String(row.order_id)))];
  const shipmentIds = rows.map((row) => String(row.id));
  const [orders, labels] = await Promise.all([
    orderIds.length
      ? getSupabase()
          .from("orders")
          .select("id, order_name, shipping_name, shipping_address, pincode")
          .eq("shop_id", shopId)
          .in("id", orderIds)
      : Promise.resolve({ data: [], error: null }),
    shipmentIds.length
      ? getSupabase()
          .from("labels")
          .select("id, shipment_id, status")
          .eq("shop_id", shopId)
          .in("shipment_id", shipmentIds)
          .eq("kind", "INDIA_POST")
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (orders.error || labels.error) throw new Error("Shipments could not be loaded");
  const orderById = new Map((orders.data ?? []).map((row) => [String(row.id), row]));
  const labelByShipment = new Map((labels.data ?? []).map((row) => [String(row.shipment_id), row]));
  const shipments: ListedShipment[] = rows.map((row) => {
    const order = orderById.get(String(row.order_id));
    const label = labelByShipment.get(String(row.id));
    return {
      id: String(row.id),
      orderId: String(row.order_id),
      orderName: String(order?.order_name ?? "Order"),
      customer: String(order?.shipping_name ?? "—"),
      destination: String(order?.shipping_address ?? order?.pincode ?? "—"),
      pincode: String(order?.pincode ?? ""),
      service: serviceMark(String(row.service_code ?? "")),
      trackingNumber: (row.tracking_number as string | null) ?? null,
      status: String(row.status ?? "DRAFT"),
      createdAt: (row.created_at as string | null) ?? null,
      labelId: label ? String(label.id) : null,
      labelStatus: label ? String(label.status) : null,
      lastTrackingSyncedAt: (row.last_tracking_synced_at as string | null) ?? null,
      lastTrackingLocation: (row.last_tracking_location as string | null) ?? null,
    };
  });
  const total = count ?? 0;
  return {
    shipments,
    count: total,
    page: window.page,
    hasPrevious: window.page > 1,
    hasNext: total > window.to + 1,
    timeZone,
  };
}

export async function queueShipmentBooking(shopId: string, shipmentId: string) {
  requireShopId(shopId);
  const { data, error } = await getSupabase()
    .from("shipments")
    .select("id, status")
    .eq("shop_id", shopId)
    .eq("id", shipmentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const status = (data as { status: string } | null)?.status;
  if (status !== "FAILED" && status !== "QUEUED" && status !== "DRAFT") return false;
  await enqueueJob(shopId, "shipment-booking", shipmentId, {});
  return true;
}
