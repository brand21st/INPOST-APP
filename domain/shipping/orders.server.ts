import { getSupabase, requireShopId } from "../../app/db.server";
import { enqueueJob } from "../tenancy/shops.server";
import { mapShopifyPayment } from "./payment";

export type OrderProjectionInput = {
  shopifyOrderGid: string;
  orderName: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  gatewayNames: string[];
  orderTotal: number;
  amountOutstanding: number;
  shippingName: string | null;
  shippingAddress: string | null;
  phone: string | null;
  pincode: string | null;
  cancelledAt: string | null;
  lines: {
    gid: string;
    title: string | null;
    sku: string | null;
    quantity: number;
    grams: number | null;
  }[];
};

export function projectionFromRestOrder(payload: Record<string, unknown>): OrderProjectionInput {
  const id = payload.id;
  const gid =
    (typeof payload.admin_graphql_api_id === "string" && payload.admin_graphql_api_id) ||
    `gid://shopify/Order/${id}`;
  const address = (payload.shipping_address ?? {}) as Record<string, unknown>;
  const gateways = Array.isArray(payload.payment_gateway_names)
    ? payload.payment_gateway_names.filter((name): name is string => typeof name === "string")
    : typeof payload.gateway === "string"
      ? [payload.gateway]
      : [];
  const lines = Array.isArray(payload.line_items) ? payload.line_items : [];
  return {
    shopifyOrderGid: gid,
    orderName: typeof payload.name === "string" ? payload.name : null,
    financialStatus: typeof payload.financial_status === "string" ? payload.financial_status : null,
    fulfillmentStatus:
      typeof payload.fulfillment_status === "string" ? payload.fulfillment_status : null,
    gatewayNames: gateways,
    orderTotal: Number(payload.total_price ?? 0),
    amountOutstanding: Number(payload.total_outstanding ?? payload.total_price ?? 0),
    shippingName: typeof address.name === "string" ? address.name : null,
    shippingAddress: [address.address1, address.address2, address.city, address.zip]
      .filter((part) => typeof part === "string" && part)
      .join(", "),
    phone:
      (typeof address.phone === "string" && address.phone) ||
      (typeof payload.phone === "string" ? payload.phone : null),
    pincode: typeof address.zip === "string" ? address.zip.replace(/\D/g, "").slice(0, 6) : null,
    cancelledAt: typeof payload.cancelled_at === "string" ? payload.cancelled_at : null,
    lines: lines.map((line) => {
      const item = line as Record<string, unknown>;
      return {
        gid:
          (typeof item.admin_graphql_api_id === "string" && item.admin_graphql_api_id) ||
          `gid://shopify/LineItem/${item.id}`,
        title: typeof item.title === "string" ? item.title : null,
        sku: typeof item.sku === "string" ? item.sku : null,
        quantity: Number(item.quantity ?? 1),
        grams: item.grams == null ? null : Number(item.grams),
      };
    }),
  };
}

export async function upsertOrderProjection(shopId: string, input: OrderProjectionInput) {
  requireShopId(shopId);
  const payment = mapShopifyPayment({
    financialStatus: input.financialStatus,
    gatewayNames: input.gatewayNames,
    orderTotal: input.orderTotal,
    amountOutstanding: input.amountOutstanding,
  });
  const status = input.cancelledAt ? "CANCELLED" : "READY";
  const { data, error } = await getSupabase()
    .from("orders")
    .upsert(
      {
        shop_id: shopId,
        shopify_order_gid: input.shopifyOrderGid,
        order_name: input.orderName,
        financial_status: input.financialStatus,
        fulfillment_status: input.fulfillmentStatus,
        payment_gateway_names: input.gatewayNames,
        total_amount: input.orderTotal,
        amount_outstanding: input.amountOutstanding,
        payment_mode: payment.paymentMode,
        cod_amount: payment.codAmount,
        shipping_name: input.shippingName,
        shipping_address: input.shippingAddress,
        phone: input.phone,
        pincode: input.pincode,
        cancelled_at: input.cancelledAt,
        status,
      },
      { onConflict: "shop_id,shopify_order_gid" },
    )
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const orderId = (data as { id: string }).id;

  for (const line of input.lines) {
    const { data: existing } = await getSupabase()
      .from("order_line_items")
      .select("id, grams")
      .eq("shop_id", shopId)
      .eq("shopify_line_item_gid", line.gid)
      .maybeSingle();
    const grams =
      existing && (existing as { grams: number | null }).grams != null
        ? (existing as { grams: number | null }).grams
        : line.grams;
    const { error: lineError } = await getSupabase().from("order_line_items").upsert(
      {
        shop_id: shopId,
        order_id: orderId,
        shopify_line_item_gid: line.gid,
        title: line.title,
        sku: line.sku,
        quantity: line.quantity,
        grams,
      },
      { onConflict: "shop_id,shopify_line_item_gid" },
    );
    if (lineError) throw new Error(lineError.message);
  }

  if (input.cancelledAt) {
    await getSupabase()
      .from("shipments")
      .update({ status: "CANCELLED" })
      .eq("shop_id", shopId)
      .eq("order_id", orderId)
      .in("status", ["DRAFT", "QUEUED", "FAILED"]);
  }
  return orderId;
}

export async function maybeAutoBook(shopId: string, orderId: string) {
  const { data: settings } = await getSupabase()
    .from("shop_settings")
    .select("auto_book, default_service, default_parcel_grams")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (!settings || !(settings as { auto_book: boolean }).auto_book) return;
  const row = settings as { default_service: string; default_parcel_grams: number };
  await createShipment(shopId, orderId, row.default_service, row.default_parcel_grams, true);
}

export async function createShipment(
  shopId: string,
  orderId: string,
  serviceCode: string,
  weightGrams: number,
  queue: boolean,
) {
  requireShopId(shopId);
  const { data: order, error } = await getSupabase()
    .from("orders")
    .select("id, payment_mode, cod_amount, status")
    .eq("shop_id", shopId)
    .eq("id", orderId)
    .single();
  if (error) throw new Error(error.message);
  const orderRow = order as {
    payment_mode: "COD" | "PREPAID";
    cod_amount: number;
    status: string;
  };
  if (orderRow.status === "CANCELLED") {
    throw new Error("Order is cancelled");
  }
  const { data: existing } = await getSupabase()
    .from("shipments")
    .select("id, status")
    .eq("shop_id", shopId)
    .eq("order_id", orderId)
    .neq("status", "CANCELLED")
    .maybeSingle();
  if (existing) {
    const shipment = existing as { id: string; status: string };
    if (queue && (shipment.status === "DRAFT" || shipment.status === "FAILED")) {
      await getSupabase()
        .from("shipments")
        .update({ status: "QUEUED" })
        .eq("shop_id", shopId)
        .eq("id", shipment.id);
      await enqueueJob(shopId, "shipment-booking", shipment.id, {});
    }
    return shipment.id;
  }
  const { data: created, error: insertError } = await getSupabase()
    .from("shipments")
    .insert({
      shop_id: shopId,
      order_id: orderId,
      service_code: serviceCode,
      payment_mode: orderRow.payment_mode ?? "PREPAID",
      cod_amount: orderRow.cod_amount ?? 0,
      weight_grams: weightGrams,
      status: queue ? "QUEUED" : "DRAFT",
    })
    .select("id")
    .single();
  if (insertError) throw new Error(insertError.message);
  const shipmentId = (created as { id: string }).id;
  if (queue) await enqueueJob(shopId, "shipment-booking", shipmentId, {});
  return shipmentId;
}
