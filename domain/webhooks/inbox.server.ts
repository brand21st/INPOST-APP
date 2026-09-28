import { getSupabase } from "../../app/db.server";
import { sha256 } from "../../lib/crypto.server";
import { enqueueJob, getShopByDomain } from "../tenancy/shops.server";
import { logInfo } from "../../lib/logger.server";

export async function acceptShopifyWebhook(input: {
  shop: string;
  topic: string;
  webhookId: string;
  payload: Record<string, unknown>;
}) {
  const shop = await getShopByDomain(input.shop);
  const shopId = shop?.id ?? null;
  if (!shopId && input.topic !== "shop/redact" && !input.topic.startsWith("customers/")) {
    logInfo("webhook for unknown shop", { shop: input.shop, topic: input.topic, webhook_id: input.webhookId });
    return;
  }
  const { data, error } = await getSupabase()
    .from("webhook_inbox")
    .upsert(
      {
        source: "SHOPIFY",
        shop_id: shopId,
        topic: input.topic,
        external_id: input.webhookId,
        payload: input.payload,
        payload_hash: sha256(JSON.stringify(input.payload)),
        status: "RECEIVED",
      },
      { onConflict: "source,external_id", ignoreDuplicates: true },
    )
    .select("id, status")
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as { id: string; status: string } | null;
  if (!row || row.status === "PROCESSED") return;
  if (shopId) {
    await enqueueJob(shopId, "webhook-process", row.id, { topic: input.topic });
  }
  logInfo("webhook received", { shop: input.shop, topic: input.topic, webhook_id: input.webhookId });
}

export async function recordCompliance(input: {
  shop: string;
  topic: string;
  webhookId: string;
  payload: Record<string, unknown>;
}) {
  const shop = await getShopByDomain(input.shop);
  await getSupabase().from("compliance_requests").insert({
    shop_id: shop?.id ?? null,
    topic: input.topic,
    shop_domain: input.shop,
    payload: input.payload,
    status: "RECEIVED",
  });
  if (shop?.id) {
    await enqueueJob(shop.id, "compliance-process", null, {
      topic: input.topic,
      shop_domain: input.shop,
      orders_to_redact: input.payload.orders_to_redact ?? [],
    });
  } else if (input.topic === "shop/redact") {
    await getSupabase().from("shops").delete().eq("shop_domain", input.shop);
  }
  logInfo("compliance webhook", { shop: input.shop, topic: input.topic, webhook_id: input.webhookId });
}
