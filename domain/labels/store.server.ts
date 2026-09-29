import { createHash } from "node:crypto";
import { getSupabase, requireShopId } from "../../app/db.server";
import { fetchOfficialLabel, type ConnectionRow } from "../india-post/client.server";
import { buildBookingArticle } from "../india-post/article";
import { enqueueJob } from "../tenancy/shops.server";
import { readLabelFile, writeLabelPdf } from "./disk.server";

async function markLabelFailed(shopId: string, shipmentId: string, message: string) {
  await getSupabase().from("labels").upsert(
    {
      shop_id: shopId,
      shipment_id: shipmentId,
      kind: "INDIA_POST",
      status: "FAILED",
      last_error: message.slice(0, 500),
    },
    { onConflict: "shipment_id,kind" },
  );
}

export async function queueLabelGeneration(shopId: string, shipmentId: string) {
  requireShopId(shopId);
  const { data, error } = await getSupabase()
    .from("labels")
    .select("id, status")
    .eq("shop_id", shopId)
    .eq("shipment_id", shipmentId)
    .eq("kind", "INDIA_POST")
    .maybeSingle();
  if (error) throw new Error(error.message);
  const status = (data as { status: string } | null)?.status;
  if (status === "READY") return false;
  await enqueueJob(shopId, "label-generation", shipmentId, {});
  return true;
}

export async function generateOfficialLabel(shopId: string, shipmentId: string) {
  requireShopId(shopId);
  try {
    const { data: shipment, error } = await getSupabase()
      .from("shipments")
      .select("id, order_id, service_code, cod_amount, weight_grams, barcode, status")
      .eq("shop_id", shopId)
      .eq("id", shipmentId)
      .single();
    if (error) throw new Error(error.message);
    const row = shipment as {
      order_id: string;
      service_code: string;
      cod_amount: number;
      weight_grams: number;
      barcode: string | null;
      status: string;
    };
    if (!row.barcode || !["BOOKED", "LABEL_READY"].includes(row.status)) return;
    const { data: existing } = await getSupabase()
      .from("labels")
      .select("id, status")
      .eq("shop_id", shopId)
      .eq("shipment_id", shipmentId)
      .eq("kind", "INDIA_POST")
      .maybeSingle();
    if ((existing as { status: string } | null)?.status === "READY") return;

    await getSupabase().from("labels").upsert(
      {
        shop_id: shopId,
        shipment_id: shipmentId,
        kind: "INDIA_POST",
        status: "PENDING",
        last_error: null,
      },
      { onConflict: "shipment_id,kind" },
    );

    const { data: connection } = await getSupabase()
      .from("india_post_connections")
      .select(
        "shop_id, encrypted_username, encrypted_password, encrypted_access_token, token_expires_at, bulk_customer_id, environment, office_id, status",
      )
      .eq("shop_id", shopId)
      .single();
    const { data: order } = await getSupabase()
      .from("orders")
      .select("shipping_name, shipping_address, phone, pincode")
      .eq("shop_id", shopId)
      .eq("id", row.order_id)
      .single();
    const { data: settings } = await getSupabase()
      .from("shop_settings")
      .select("sender_name, sender_mobile, sender_pincode, sender_address")
      .eq("shop_id", shopId)
      .maybeSingle();
    const { data: contract } = await getSupabase()
      .from("india_post_contracts")
      .select("contract_id")
      .eq("shop_id", shopId)
      .eq("service_code", row.service_code)
      .maybeSingle();
    const orderRow = order as {
      shipping_name: string | null;
      shipping_address: string | null;
      phone: string | null;
      pincode: string | null;
    };
    const settingsRow = settings as {
      sender_name: string | null;
      sender_mobile: string | null;
      sender_pincode: string | null;
      sender_address: string | null;
    } | null;
    const receiverMobile = (orderRow.phone ?? "").replace(/\D/g, "").slice(-10);
    const article = buildBookingArticle({
      serviceCode: row.service_code,
      barcode: row.barcode,
      grams: row.weight_grams,
      contractId: (contract as { contract_id: string } | null)?.contract_id ?? "",
      officeId: (connection as ConnectionRow).office_id ?? "",
      senderName: settingsRow?.sender_name ?? "Merchant",
      senderMobile: (settingsRow?.sender_mobile ?? "").replace(/\D/g, "").slice(-10),
      senderPincode: settingsRow?.sender_pincode ?? "",
      senderAddress: settingsRow?.sender_address ?? "Drop off",
      receiverName: orderRow.shipping_name ?? "Receiver",
      receiverMobile,
      receiverPincode: orderRow.pincode ?? "",
      receiverAddress: orderRow.shipping_address ?? "",
      codAmount: Number(row.cod_amount),
    });
    if (Number(row.cod_amount) > 0) {
      article.cod_text = "COD";
    }
    const pdf = await fetchOfficialLabel(connection as ConnectionRow, article);
    const storageKey = await writeLabelPdf(shopId, shipmentId, pdf);
    const digest = createHash("sha256").update(pdf).digest("hex");
    await getSupabase().from("labels").upsert(
      {
        shop_id: shopId,
        shipment_id: shipmentId,
        kind: "INDIA_POST",
        storage_key: storageKey,
        sha256: digest,
        status: "READY",
        last_error: null,
      },
      { onConflict: "shipment_id,kind" },
    );
    await getSupabase()
      .from("shipments")
      .update({ status: "LABEL_READY" })
      .eq("shop_id", shopId)
      .eq("id", shipmentId)
      .eq("status", "BOOKED");
    await getSupabase().from("audit_logs").insert({
      shop_id: shopId,
      action: "label_generated",
      entity_type: "shipment",
      entity_id: shipmentId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Label generation failed";
    await markLabelFailed(shopId, shipmentId, message);
    throw error;
  }
}

export async function readLabelPdf(shopId: string, labelId: string): Promise<Uint8Array> {
  requireShopId(shopId);
  const { data, error } = await getSupabase()
    .from("labels")
    .select("storage_key, status")
    .eq("shop_id", shopId)
    .eq("id", labelId)
    .single();
  if (error) throw new Error(error.message);
  const row = data as { storage_key: string | null; status: string };
  if (row.status !== "READY" || !row.storage_key) {
    throw new Error("Label is not ready");
  }
  return readLabelFile(shopId, row.storage_key);
}
