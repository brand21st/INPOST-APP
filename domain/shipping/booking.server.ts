import { createHash } from "node:crypto";
import { getSupabase, requireShopId } from "../../app/db.server";
import { sha256 } from "../../lib/crypto.server";
import {
  acceptedArticleNumber,
  CeptError,
  processArticles,
  tariffFromBooking,
  type ConnectionRow,
} from "../india-post/client.server";
import { assertBookingRules, buildBookingArticle } from "../india-post/article";
import { isPermanent } from "../india-post/errors";
import { enqueueJob } from "../tenancy/shops.server";

const OPEN_FOR_BOOKING = new Set(["DRAFT", "QUEUED", "FAILED", "BOOKING"]);

type ShipmentRow = {
  id: string;
  shop_id: string;
  order_id: string;
  service_code: string;
  payment_mode: "COD" | "PREPAID";
  cod_amount: number;
  weight_grams: number;
  submitted_s10: string | null;
  status: string;
};

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function loadConnection(shopId: string): Promise<ConnectionRow> {
  const { data, error } = await getSupabase()
    .from("india_post_connections")
    .select(
      "shop_id, encrypted_username, encrypted_password, encrypted_access_token, token_expires_at, bulk_customer_id, environment, office_id, status",
    )
    .eq("shop_id", shopId)
    .single();
  if (error) throw new CeptError("PERMANENT_AUTH_ERROR", error.message);
  return data as ConnectionRow;
}

async function reservedS10(shopId: string, shipmentId: string, submitted: string | null) {
  if (submitted) return submitted;
  const { data } = await getSupabase()
    .from("barcode_allocations")
    .select("s10")
    .eq("shop_id", shopId)
    .eq("shipment_id", shipmentId)
    .eq("status", "RESERVED")
    .maybeSingle();
  return (data as { s10: string } | null)?.s10 ?? null;
}

async function allocateS10(shopId: string, shipmentId: string, serviceCode: string) {
  const { data, error } = await getSupabase().rpc("allocate_barcode", {
    p_shop_id: shopId,
    p_service_code: serviceCode,
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as {
    allocation_id: string;
    s10: string;
    status: string;
  } | null;
  if (!row || row.status === "NO_RANGE" || row.status === "EXHAUSTED") {
    throw new CeptError("BARCODE_RANGE_EXHAUSTED", "Barcode range is exhausted");
  }
  if (row.status === "REJECTED_UAT") {
    throw new CeptError("INVALID_BARCODE", "UAT serials cannot be used in production");
  }
  await getSupabase()
    .from("barcode_allocations")
    .update({ shipment_id: shipmentId })
    .eq("shop_id", shopId)
    .eq("id", row.allocation_id);
  await getSupabase()
    .from("shipments")
    .update({ submitted_s10: row.s10 })
    .eq("shop_id", shopId)
    .eq("id", shipmentId);
  await getSupabase().from("audit_logs").insert({
    shop_id: shopId,
    action: "barcode_allocate",
    entity_type: "shipment",
    entity_id: shipmentId,
    detail: { s10: row.s10 },
  });
  return row.s10;
}

async function persistBooked(input: {
  shopId: string;
  shipmentId: string;
  s10: string;
  accepted: string;
  tariff: number | null;
  idempotencyKey: string;
}) {
  const now = new Date().toISOString();
  const { error } = await getSupabase()
    .from("shipments")
    .update({
      status: "BOOKED",
      submitted_s10: input.s10,
      accepted_article_number: input.accepted,
      barcode: input.accepted,
      tracking_number: input.accepted,
      tariff: input.tariff,
      booked_at: now,
      last_error: null,
      operational_status: "BOOKED",
    })
    .eq("shop_id", input.shopId)
    .eq("id", input.shipmentId);
  if (error) throw new Error(error.message);
  await getSupabase()
    .from("barcode_allocations")
    .update({ status: "COMMITTED" })
    .eq("shop_id", input.shopId)
    .eq("shipment_id", input.shipmentId)
    .eq("s10", input.s10);
  const { error: idemError } = await getSupabase().from("idempotency_keys").insert({
    shop_id: input.shopId,
    scope: "booking",
    key: input.idempotencyKey,
    result: { accepted: input.accepted },
  });
  if (idemError && idemError.code !== "23505") throw new Error(idemError.message);
  await enqueueJob(input.shopId, "label-generation", input.shipmentId, {});
  await enqueueJob(input.shopId, "shopify-fulfillment", input.shipmentId, {});
}

export async function bookShipment(shopId: string, shipmentId: string) {
  requireShopId(shopId);
  const { data: shop } = await getSupabase()
    .from("shops")
    .select("status")
    .eq("id", shopId)
    .single();
  if ((shop as { status: string } | null)?.status !== "INSTALLED") return;

  const { data: shipmentData, error } = await getSupabase()
    .from("shipments")
    .select(
      "id, shop_id, order_id, service_code, payment_mode, cod_amount, weight_grams, submitted_s10, status",
    )
    .eq("shop_id", shopId)
    .eq("id", shipmentId)
    .single();
  if (error) throw new Error(error.message);
  const shipment = shipmentData as ShipmentRow;
  if (!OPEN_FOR_BOOKING.has(shipment.status)) return;

  const idempotencyKey = `book:${shopId}:${shipmentId}`;
  const { data: prior } = await getSupabase()
    .from("idempotency_keys")
    .select("result")
    .eq("shop_id", shopId)
    .eq("scope", "booking")
    .eq("key", idempotencyKey)
    .maybeSingle();
  if (prior) return;

  await getSupabase()
    .from("shipments")
    .update({ status: "BOOKING" })
    .eq("shop_id", shopId)
    .eq("id", shipmentId);

  const s10 = (await reservedS10(shopId, shipmentId, shipment.submitted_s10)) ??
    (await allocateS10(shopId, shipmentId, shipment.service_code));

  const connection = await loadConnection(shopId);
  const { data: order } = await getSupabase()
    .from("orders")
    .select("shipping_name, shipping_address, phone, pincode")
    .eq("shop_id", shopId)
    .eq("id", shipment.order_id)
    .single();
  const { data: settings } = await getSupabase()
    .from("shop_settings")
    .select("drop_off_office_id, sender_name, sender_mobile, sender_pincode, sender_address")
    .eq("shop_id", shopId)
    .single();
  const { data: contract } = await getSupabase()
    .from("india_post_contracts")
    .select("contract_id")
    .eq("shop_id", shopId)
    .eq("service_code", shipment.service_code)
    .maybeSingle();
  const orderRow = order as {
    shipping_name: string | null;
    shipping_address: string | null;
    phone: string | null;
    pincode: string | null;
  };
  const settingsRow = settings as {
    drop_off_office_id: string | null;
    sender_name: string | null;
    sender_mobile: string | null;
    sender_pincode: string | null;
    sender_address: string | null;
  };
  const receiverMobile = (orderRow.phone ?? "").replace(/\D/g, "").slice(-10);
  const senderMobile = (settingsRow.sender_mobile ?? "").replace(/\D/g, "").slice(-10);
  const officeId = connection.office_id || settingsRow.drop_off_office_id || "";
  const contractId = (contract as { contract_id: string } | null)?.contract_id ?? "";
  assertBookingRules({
    mobile: receiverMobile,
    pincode: orderRow.pincode ?? "",
    officeId,
    contractId,
  });
  assertBookingRules({
    mobile: senderMobile,
    pincode: settingsRow.sender_pincode ?? "",
    officeId,
    contractId,
  });
  const article = buildBookingArticle({
    serviceCode: shipment.service_code,
    barcode: s10,
    grams: shipment.weight_grams,
    contractId,
    officeId,
    senderName: settingsRow.sender_name ?? "Merchant",
    senderMobile,
    senderPincode: settingsRow.sender_pincode ?? "",
    senderAddress: settingsRow.sender_address ?? "Drop off",
    receiverName: orderRow.shipping_name ?? "Receiver",
    receiverMobile,
    receiverPincode: orderRow.pincode ?? "",
    receiverAddress: orderRow.shipping_address ?? "",
    codAmount: Number(shipment.cod_amount),
  });

  await getSupabase().from("booking_attempts").insert({
    shop_id: shopId,
    shipment_id: shipmentId,
    idempotency_key: idempotencyKey,
    s10_submitted: s10,
    request_hash: hashJson(article),
    status: "IN_FLIGHT",
  });

  try {
    const body = await processArticles(connection, [article]);
    const accepted = acceptedArticleNumber(body, s10);
    await persistBooked({
      shopId,
      shipmentId,
      s10,
      accepted,
      tariff: tariffFromBooking(body),
      idempotencyKey,
    });
    await getSupabase()
      .from("booking_attempts")
      .update({ status: "SUCCEEDED", response_hash: sha256(JSON.stringify(body)) })
      .eq("shop_id", shopId)
      .eq("shipment_id", shipmentId)
      .eq("status", "IN_FLIGHT");
  } catch (error) {
    const errorClass = error instanceof CeptError ? error.errorClass : "RETRYABLE";
    const message = error instanceof Error ? error.message : "Booking failed";
    if (/already|duplicate/i.test(message)) {
      await persistBooked({
        shopId,
        shipmentId,
        s10,
        accepted: s10,
        tariff: null,
        idempotencyKey,
      });
      return;
    }
    await getSupabase()
      .from("booking_attempts")
      .update({ status: "FAILED", error_class: errorClass })
      .eq("shop_id", shopId)
      .eq("shipment_id", shipmentId)
      .eq("status", "IN_FLIGHT");
    if (errorClass === "INVALID_BARCODE") {
      await getSupabase()
        .from("barcode_allocations")
        .update({ status: "ABANDONED", abandon_reason: "CEPT rejected barcode" })
        .eq("shop_id", shopId)
        .eq("shipment_id", shipmentId)
        .eq("s10", s10);
      await getSupabase()
        .from("shipments")
        .update({ submitted_s10: null })
        .eq("shop_id", shopId)
        .eq("id", shipmentId);
    }
    await getSupabase()
      .from("shipments")
      .update({
        status: isPermanent(errorClass) ? "FAILED" : "QUEUED",
        last_error: message.slice(0, 500),
      })
      .eq("shop_id", shopId)
      .eq("id", shipmentId);
    throw error;
  }
}
