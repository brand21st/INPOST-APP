import { getSupabase, requireShopId } from "../../app/db.server";

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

export async function applyTrackingEvent(input: {
  shopId: string;
  barcode: string;
  eventKey: string;
  occurredAt: string;
  summary: string;
}) {
  requireShopId(input.shopId);
  const { data: allocation } = await getSupabase()
    .from("barcode_allocations")
    .select("shipment_id, s10")
    .eq("shop_id", input.shopId)
    .eq("s10", input.barcode)
    .maybeSingle();
  const shipmentId = (allocation as { shipment_id: string | null } | null)?.shipment_id;
  if (!shipmentId) return false;

  const { error } = await getSupabase().from("tracking_events").upsert(
    {
      shop_id: input.shopId,
      shipment_id: shipmentId,
      event_key: input.eventKey,
      occurred_at: input.occurredAt,
      summary: input.summary.slice(0, 300),
      raw_payload: input.summary.slice(0, 500),
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
  if (!canAdvance(current.operational_status, operational)) return true;
  await getSupabase()
    .from("shipments")
    .update({
      operational_status: operational,
      status: shipmentStatusForOperational(operational, current.status),
    })
    .eq("shop_id", input.shopId)
    .eq("id", shipmentId);
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
    .select("occurred_at, summary, status")
    .eq("shop_id", shopId)
    .eq("shipment_id", row.id)
    .order("occurred_at", { ascending: true });
  return {
    consignment,
    status: row.operational_status ?? row.status,
    events: (events ?? []).map((event) => {
      const item = event as { occurred_at: string; summary: string | null };
      return { at: item.occurred_at, summary: item.summary };
    }),
  };
}
