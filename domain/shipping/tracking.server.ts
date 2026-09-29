import { getSupabase, requireShopId } from "../../app/db.server";
import { sha256 } from "../../lib/crypto.server";
import { trackBulk, type ConnectionRow, CeptError } from "../india-post/client.server";
import { serviceMark } from "../orders/page";

let trackBulkClient = trackBulk;

export function setTrackBulkForTests(client: typeof trackBulk | undefined) {
  trackBulkClient = client ?? trackBulk;
}

export function isTrackable(trackingNumber: string | null | undefined, labelStatus: string | null | undefined) {
  return Boolean(trackingNumber?.trim() && labelStatus === "READY");
}

export function trackingUnavailableCopy(trackingNumber: string | null | undefined) {
  return trackingNumber?.trim()
    ? "Label not generated"
    : "Tracking ID pending";
}

const RANK: Record<string, number> = {
  BOOKED: 1,
  DISPATCHED: 2,
  IN_TRANSIT: 3,
  OUT_FOR_DELIVERY: 4,
  NDR: 4,
  DELIVERED: 5,
  RTO: 6,
  RTO_IN_TRANSIT: 6,
  RTO_DELIVERED: 7,
};

export function mapEventText(text: string): string {
  const value = text.toLowerCase();
  if (value.includes("rto") && value.includes("deliver")) return "RTO_DELIVERED";
  if (value.includes("rto")) return "RTO";
  if (value.includes("undeliver") || value.includes("non delivery") || value.includes("ndr")) {
    return "NDR";
  }
  if (value.includes("out for delivery")) return "OUT_FOR_DELIVERY";
  if (value.includes("deliver")) return "DELIVERED";
  if (value.includes("dispatch")) return "DISPATCHED";
  if (value.includes("transit") || value.includes("bagged") || value.includes("received")) {
    return "IN_TRANSIT";
  }
  return "IN_TRANSIT";
}

export function shipmentStatusForOperational(operational: string, current: string): string {
  if (operational === "NDR") return "NDR";
  if (operational.startsWith("RTO")) return "RTO";
  if (operational === "DELIVERED" || operational === "RTO_DELIVERED") return "DELIVERED";
  if (operational === "OUT_FOR_DELIVERY") return "OUT_FOR_DELIVERY";
  if (["BOOKED", "LABEL_READY", "IN_TRANSIT", "DISPATCHED"].includes(operational)) {
    if (["DRAFT", "QUEUED", "BOOKING", "FAILED", "CANCELLED"].includes(current)) return current;
    return "IN_TRANSIT";
  }
  return current;
}

export function canAdvance(current: string | null, next: string): boolean {
  if (!current) return true;
  if (current === "NDR" && (next === "IN_TRANSIT" || next === "RTO" || next === "OUT_FOR_DELIVERY")) {
    return true;
  }
  return (RANK[next] ?? 0) >= (RANK[current] ?? 0);
}

export function normalizeTrackingQuery(value: string | null | undefined) {
  return (value ?? "").trim().replace(/\s+/g, "").toUpperCase();
}

async function findShipmentIdForBarcode(shopId: string, barcode: string) {
  const { data: allocation } = await getSupabase()
    .from("barcode_allocations")
    .select("shipment_id")
    .eq("shop_id", shopId)
    .eq("s10", barcode)
    .maybeSingle();
  const fromAllocation = (allocation as { shipment_id: string | null } | null)?.shipment_id;
  if (fromAllocation) return fromAllocation;
  for (const column of ["tracking_number", "barcode", "submitted_s10"] as const) {
    const { data } = await getSupabase()
      .from("shipments")
      .select("id")
      .eq("shop_id", shopId)
      .eq(column, barcode)
      .maybeSingle();
    if (data) return String((data as { id: string }).id);
  }
  return null;
}

export async function applyTrackingEvent(input: {
  shopId: string;
  barcode: string;
  eventKey: string;
  occurredAt: string;
  summary: string;
  location?: string | null;
  raw?: string | null;
  status?: string | null;
}) {
  requireShopId(input.shopId);
  const shipmentId = await findShipmentIdForBarcode(input.shopId, input.barcode);
  if (!shipmentId) return false;

  const { error } = await getSupabase().from("tracking_events").upsert(
    {
      shop_id: input.shopId,
      shipment_id: shipmentId,
      event_key: input.eventKey,
      occurred_at: input.occurredAt,
      status: input.status ?? null,
      summary: input.summary.slice(0, 300),
      location: input.location?.slice(0, 200) ?? null,
      raw_payload: (input.raw ?? input.summary).slice(0, 500),
    },
    { onConflict: "shop_id,shipment_id,event_key,occurred_at" },
  );
  if (error) throw new Error(error.message);

  const operational = mapEventText(input.summary);
  const { data: shipment } = await getSupabase()
    .from("shipments")
    .select("status, operational_status")
    .eq("shop_id", input.shopId)
    .eq("id", shipmentId)
    .single();
  const current = shipment as { status: string; operational_status: string | null };
  const patch: Record<string, unknown> = {};
  if (input.location) patch.last_tracking_location = input.location.slice(0, 200);
  if (canAdvance(current.operational_status, operational)) {
    patch.operational_status = operational;
    patch.status = shipmentStatusForOperational(operational, current.status);
  }
  if (Object.keys(patch).length > 0) {
    await getSupabase().from("shipments").update(patch).eq("shop_id", input.shopId).eq("id", shipmentId);
  }
  return true;
}

export async function publicTimeline(shopId: string, consignment: string) {
  requireShopId(shopId);
  if (!/^[A-Za-z0-9]{8,20}$/.test(consignment)) return null;
  let shipment: { id: string; status: string; operational_status: string | null } | null = null;
  for (const column of ["tracking_number", "barcode", "submitted_s10"] as const) {
    const { data } = await getSupabase()
      .from("shipments")
      .select("id, status, operational_status")
      .eq("shop_id", shopId)
      .eq(column, consignment)
      .maybeSingle();
    if (data) {
      shipment = data as { id: string; status: string; operational_status: string | null };
      break;
    }
  }
  if (!shipment) return null;
  const row = shipment;
  const { data: events } = await getSupabase()
    .from("tracking_events")
    .select("occurred_at, summary, status, location")
    .eq("shop_id", shopId)
    .eq("shipment_id", row.id)
    .order("occurred_at", { ascending: true });
  return {
    consignment,
    status: row.operational_status ?? row.status,
    events: (events ?? []).map((event) => {
      const item = event as { occurred_at: string; summary: string | null; location?: string | null };
      return { at: item.occurred_at, summary: item.summary, location: item.location ?? null };
    }),
  };
}

type ShipmentTrackRow = {
  id: string;
  order_id: string;
  tracking_number: string | null;
  service_code: string;
  status: string;
  operational_status: string | null;
  last_tracking_synced_at: string | null;
  last_tracking_location: string | null;
};

export type MerchantTrackingEvent = {
  at: string;
  summary: string | null;
  location: string | null;
  status: string | null;
};

export type MerchantTrackingView = {
  shipmentId: string;
  trackingNumber: string;
  service: "SP" | "BP" | null;
  status: string;
  operationalStatus: string | null;
  location: string | null;
  lastSyncedAt: string | null;
  customer: string;
  pincode: string;
  orderId: string;
  orderName: string;
  timeZone: string;
  events: MerchantTrackingEvent[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringField(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function parseTrackingBulkItem(item: unknown, fallbackBarcode: string) {
  const row = asRecord(item) ?? {};
  const nested = asRecord(row.data) ?? asRecord(row.event) ?? row;
  const barcode = stringField(nested, ["barcode", "article_number", "consignment_number", "barcode_no"]) || fallbackBarcode;
  const summary =
    stringField(nested, ["event", "remarks", "status", "event_description", "summary", "message"]) || "Update";
  const occurred =
    stringField(nested, ["occurred_at", "event_time", "event_date", "datetime", "date_time", "timestamp"]) ||
    new Date().toISOString();
  const location = stringField(nested, ["location", "office", "office_name", "current_office", "place"]) || null;
  const status = stringField(nested, ["status", "event_code"]) || null;
  const eventId = stringField(nested, ["event_key", "event_id", "id"]);
  const eventKey = eventId || sha256(`${barcode}:${occurred}:${summary}:${location ?? ""}`);
  return {
    barcode,
    summary,
    occurredAt: occurred,
    location,
    status,
    eventKey,
    raw: JSON.stringify(item).slice(0, 500),
  };
}

async function labelIsReady(shopId: string, shipmentId: string) {
  const { data } = await getSupabase()
    .from("labels")
    .select("status")
    .eq("shop_id", shopId)
    .eq("shipment_id", shipmentId)
    .eq("kind", "INDIA_POST")
    .maybeSingle();
  return (data as { status: string } | null)?.status === "READY";
}

export async function findTrackableShipment(shopId: string, trackingQuery: string) {
  requireShopId(shopId);
  const tracking = normalizeTrackingQuery(trackingQuery);
  if (!/^[A-Z0-9]{8,20}$/.test(tracking)) {
    return { ok: false as const, reason: "invalid" as const, message: "Invalid tracking ID" };
  }
  let shipment: ShipmentTrackRow | null = null;
  for (const column of ["tracking_number", "barcode", "submitted_s10"] as const) {
    const { data } = await getSupabase()
      .from("shipments")
      .select("id, order_id, tracking_number, service_code, status, operational_status, last_tracking_synced_at, last_tracking_location")
      .eq("shop_id", shopId)
      .eq(column, tracking)
      .maybeSingle();
    if (data) {
      shipment = data as ShipmentTrackRow;
      break;
    }
  }
  if (!shipment || !shipment.tracking_number) {
    return { ok: false as const, reason: "not_found" as const, message: "Tracking ID not found in your shipments." };
  }
  if (!(await labelIsReady(shopId, shipment.id))) {
    return {
      ok: false as const,
      reason: "not_ready" as const,
      message: "Tracking is not available because the India Post label has not been generated yet.",
    };
  }
  return { ok: true as const, shipment };
}

async function trackingView(shopId: string, shipment: ShipmentTrackRow): Promise<MerchantTrackingView> {
  const [{ data: order }, { data: events }, shop] = await Promise.all([
    getSupabase()
      .from("orders")
      .select("id, order_name, shipping_name, pincode")
      .eq("shop_id", shopId)
      .eq("id", shipment.order_id)
      .maybeSingle(),
    getSupabase()
      .from("tracking_events")
      .select("occurred_at, summary, status, location")
      .eq("shop_id", shopId)
      .eq("shipment_id", shipment.id)
      .order("occurred_at", { ascending: true }),
    getSupabase().from("shops").select("timezone").eq("id", shopId).maybeSingle(),
  ]);
  const orderRow = order as { id: string; order_name: string | null; shipping_name: string | null; pincode: string | null } | null;
  return {
    shipmentId: shipment.id,
    trackingNumber: shipment.tracking_number ?? "",
    service: serviceMark(shipment.service_code),
    status: shipment.status,
    operationalStatus: shipment.operational_status,
    location: shipment.last_tracking_location,
    lastSyncedAt: shipment.last_tracking_synced_at,
    customer: orderRow?.shipping_name ?? "—",
    pincode: orderRow?.pincode ?? "",
    orderId: shipment.order_id,
    orderName: orderRow?.order_name ?? "Order",
    timeZone: (shop.data?.timezone as string | null) || "UTC",
    events: (events ?? []).map((event) => {
      const item = event as { occurred_at: string; summary: string | null; status: string | null; location: string | null };
      return { at: item.occurred_at, summary: item.summary, location: item.location, status: item.status };
    }),
  };
}

export async function loadMerchantTracking(shopId: string, trackingQuery: string) {
  const found = await findTrackableShipment(shopId, trackingQuery);
  if (!found.ok) return found;
  return { ok: true as const, view: await trackingView(shopId, found.shipment) };
}

export async function refreshMerchantTracking(shopId: string, trackingQuery: string) {
  requireShopId(shopId);
  const found = await findTrackableShipment(shopId, trackingQuery);
  if (!found.ok) return found;
  const allowed = await getSupabase().rpc("consume_rate_limit", {
    p_shop_id: shopId,
    p_key: "admin-track",
    p_limit: 30,
    p_window_seconds: 60,
  });
  if (allowed.error || allowed.data !== true) {
    return { ok: false as const, reason: "rate_limited" as const, message: "Too many tracking requests. Try again shortly." };
  }
  const { data: connection, error: connectionError } = await getSupabase()
    .from("india_post_connections")
    .select(
      "shop_id, encrypted_username, encrypted_password, encrypted_access_token, token_expires_at, bulk_customer_id, environment, office_id, status",
    )
    .eq("shop_id", shopId)
    .maybeSingle();
  if (connectionError || !connection) {
    return { ok: false as const, reason: "auth" as const, message: "India Post is not connected." };
  }
  try {
    const items = await trackBulkClient(connection as ConnectionRow, [found.shipment.tracking_number ?? ""]);
    const fallback = found.shipment.tracking_number ?? "";
    for (const item of items) {
      const row = asRecord(item);
      const nested = row && Array.isArray(row.events) ? row.events : null;
      const pieces = nested && nested.length > 0 ? nested : [item];
      const parentBarcode = row ? stringField(row, ["barcode", "article_number", "consignment_number"]) : "";
      for (const piece of pieces) {
        const parsed = parseTrackingBulkItem(piece, parentBarcode || fallback);
        await applyTrackingEvent({
          shopId,
          barcode: parsed.barcode || fallback,
          eventKey: parsed.eventKey,
          occurredAt: parsed.occurredAt,
          summary: parsed.summary,
          location: parsed.location,
          raw: parsed.raw,
          status: parsed.status,
        });
      }
    }
    await getSupabase()
      .from("shipments")
      .update({ last_tracking_synced_at: new Date().toISOString() })
      .eq("shop_id", shopId)
      .eq("id", found.shipment.id);
  } catch (error) {
    const message =
      error instanceof CeptError && error.errorClass === "PERMANENT_AUTH_ERROR"
        ? "India Post authentication failed."
        : "India Post tracking is unavailable.";
    return { ok: false as const, reason: "india_post" as const, message };
  }
  const { data: updated } = await getSupabase()
    .from("shipments")
    .select("id, order_id, tracking_number, service_code, status, operational_status, last_tracking_synced_at, last_tracking_location")
    .eq("shop_id", shopId)
    .eq("id", found.shipment.id)
    .single();
  return { ok: true as const, view: await trackingView(shopId, updated as ShipmentTrackRow) };
}
