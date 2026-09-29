import { getSupabase } from "../app/db.server";
import { bookShipment } from "../domain/shipping/booking.server";
import { generateOfficialLabel } from "../domain/labels/store.server";
import { projectionFromRestOrder, upsertOrderProjection, maybeAutoBook } from "../domain/shipping/orders.server";
import { applyTrackingEvent } from "../domain/shipping/tracking.server";
import { enqueueJob } from "../domain/tenancy/shops.server";
import { projectionFromGraphqlOrder } from "../domain/orders/graphql-order";
import { cursorIfPageAccepted, isShopifyThrottled, ShopifyThrottleError } from "../domain/orders/page";
import { isPermanent, retryDelaySeconds } from "../domain/india-post/errors";
import { CeptError } from "../domain/india-post/client.server";
import { writeShopifyFulfillment } from "../shopify/fulfillments.server";
import { ORDERS_PAGE } from "../shopify/graphql";
import { logError, logInfo } from "../lib/logger.server";
import type { AdminGraphql } from "../shopify/admin-graphql";

type JobRow = {
  id: string;
  shop_id: string;
  type: string;
  entity_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
};

async function finishJob(job: JobRow, error?: unknown) {
  if (!error) {
    await getSupabase()
      .from("background_jobs")
      .update({ status: "SUCCEEDED", last_error: null, locked_until: null })
      .eq("id", job.id);
    return;
  }
  const errorClass = error instanceof CeptError ? error.errorClass : "RETRYABLE";
  const message = error instanceof Error ? error.message : "Job failed";
  const delay = isPermanent(errorClass) ? null : retryDelaySeconds(job.attempts);
  if (delay == null) {
    await getSupabase()
      .from("background_jobs")
      .update({ status: "DEAD", last_error: message.slice(0, 500), locked_until: null })
      .eq("id", job.id);
    if (job.type === "order-sync") {
      const finished = new Date().toISOString();
      await getSupabase().from("order_sync_states").upsert(
        {
          shop_id: job.shop_id,
          status: "FAILED",
          last_error: message.slice(0, 500),
          finished_at: finished,
          updated_at: finished,
        },
        { onConflict: "shop_id" },
      );
    }
    return;
  }
  const runAfter = new Date(Date.now() + delay * 1000).toISOString();
  await getSupabase()
    .from("background_jobs")
    .update({
      status: "QUEUED",
      run_after: runAfter,
      last_error: message.slice(0, 500),
      locked_until: null,
    })
    .eq("id", job.id);
}

async function shopIsInstalled(shopId: string): Promise<boolean> {
  const { data } = await getSupabase().from("shops").select("status, shop_domain").eq("id", shopId).single();
  return (data as { status: string } | null)?.status === "INSTALLED";
}

async function processOrderSync(
  job: JobRow,
  adminForShop: (shop: string) => Promise<AdminGraphql>,
): Promise<string | null> {
  const cursor = typeof job.payload.cursor === "string" ? job.payload.cursor : null;
  const now = new Date().toISOString();
  await getSupabase()
    .from("order_sync_states")
    .upsert(
      {
        shop_id: job.shop_id,
        status: "RUNNING",
        last_error: null,
        updated_at: now,
        ...(cursor ? {} : { started_at: now, finished_at: null, processed_count: 0, cursor: null }),
      },
      { onConflict: "shop_id" },
    );
  const { data: shop } = await getSupabase()
    .from("shops")
    .select("shop_domain")
    .eq("id", job.shop_id)
    .single();
  const domain = (shop as { shop_domain: string }).shop_domain;
  const admin = await adminForShop(domain);
  const response = await admin.graphql(ORDERS_PAGE, { variables: { cursor } });
  const body = (await response.json()) as Parameters<typeof isShopifyThrottled>[0];
  if (isShopifyThrottled(body)) throw new ShopifyThrottleError();
  const connection = body.data?.orders;
  if (!connection) throw new Error("Shopify orders query failed");
  const nodes = (connection as { nodes?: Array<Record<string, unknown>> }).nodes ?? [];
  for (const node of nodes) {
    await upsertOrderProjection(job.shop_id, projectionFromGraphqlOrder(node));
  }
  const { data: state } = await getSupabase()
    .from("order_sync_states")
    .select("processed_count")
    .eq("shop_id", job.shop_id)
    .maybeSingle();
  const processed = Number((state as { processed_count?: number } | null)?.processed_count ?? 0) + nodes.length;
  const next = cursorIfPageAccepted(body);
  const updated = new Date().toISOString();
  if (next) {
    await getSupabase()
      .from("order_sync_states")
      .update({ status: "RUNNING", cursor: next, processed_count: processed, updated_at: updated })
      .eq("shop_id", job.shop_id);
    logInfo("order sync page", { shop_id: job.shop_id, event: "sync_page", processed: nodes.length, result: "ok" });
    return next;
  }
  await getSupabase()
    .from("order_sync_states")
    .update({
      status: "COMPLETED",
      cursor: null,
      processed_count: processed,
      finished_at: updated,
      updated_at: updated,
      last_error: null,
    })
    .eq("shop_id", job.shop_id);
  logInfo("order sync completed", { shop_id: job.shop_id, event: "sync_completed", processed, result: "ok" });
  return null;
}

async function processFulfillment(job: JobRow, adminForShop: (shop: string) => Promise<AdminGraphql>) {
  const { data: shipment } = await getSupabase()
    .from("shipments")
    .select("id, order_id, tracking_number, shopify_fulfillment_gid, status")
    .eq("shop_id", job.shop_id)
    .eq("id", job.entity_id)
    .single();
  const row = shipment as {
    order_id: string;
    tracking_number: string | null;
    shopify_fulfillment_gid: string | null;
    status: string;
  };
  if (!row.tracking_number) return;
  const { data: order } = await getSupabase()
    .from("orders")
    .select("shopify_order_gid")
    .eq("shop_id", job.shop_id)
    .eq("id", row.order_id)
    .single();
  const { data: shop } = await getSupabase()
    .from("shops")
    .select("shop_domain")
    .eq("id", job.shop_id)
    .single();
  const admin = await adminForShop((shop as { shop_domain: string }).shop_domain);
  const fulfillmentId = await writeShopifyFulfillment(admin, {
    orderGid: (order as { shopify_order_gid: string }).shopify_order_gid,
    existingFulfillmentGid: row.shopify_fulfillment_gid,
    trackingNumber: row.tracking_number,
  });
  await getSupabase()
    .from("shipments")
    .update({ shopify_fulfillment_gid: fulfillmentId })
    .eq("shop_id", job.shop_id)
    .eq("id", job.entity_id);
}

async function processInbox(job: JobRow) {
  const { data } = await getSupabase()
    .from("webhook_inbox")
    .select("id, topic, payload, status, shop_id")
    .eq("id", job.entity_id)
    .single();
  const inbox = data as {
    id: string;
    topic: string;
    payload: Record<string, unknown>;
    status: string;
    shop_id: string;
  };
  if (inbox.status === "PROCESSED") return;
  if (inbox.topic.startsWith("orders/")) {
    const orderId = await upsertOrderProjection(inbox.shop_id, projectionFromRestOrder(inbox.payload));
    if (inbox.topic !== "orders/cancelled") await maybeAutoBook(inbox.shop_id, orderId);
  }
  if (inbox.topic === "india-post/events") {
    const barcode = String(inbox.payload.barcode ?? inbox.payload.article_number ?? "");
    const summary = String(inbox.payload.event ?? inbox.payload.remarks ?? inbox.payload.status ?? "");
    const when = String(inbox.payload.occurred_at ?? new Date().toISOString());
    await applyTrackingEvent({
      shopId: inbox.shop_id,
      barcode,
      eventKey: String(inbox.payload.event_key ?? `${barcode}:${when}:${summary}`),
      occurredAt: when,
      summary,
    });
  }
  await getSupabase().from("webhook_inbox").update({ status: "PROCESSED" }).eq("id", inbox.id);
}

export async function processJob(job: JobRow, adminForShop: (shop: string) => Promise<AdminGraphql>) {
  if (!(await shopIsInstalled(job.shop_id)) && job.type !== "compliance-process") {
    await getSupabase().from("background_jobs").update({ status: "CANCELLED" }).eq("id", job.id);
    return;
  }
  let nextCursor: string | null = null;
  try {
    if (job.type === "shipment-booking" && job.entity_id) {
      await bookShipment(job.shop_id, job.entity_id);
    } else if (job.type === "label-generation" && job.entity_id) {
      await generateOfficialLabel(job.shop_id, job.entity_id);
    } else if (job.type === "shopify-fulfillment" && job.entity_id) {
      await processFulfillment(job, adminForShop);
    } else if (job.type === "order-sync") {
      nextCursor = await processOrderSync(job, adminForShop);
    } else if (job.type === "webhook-process" || job.type === "india-post-events") {
      await processInbox(job);
    } else if (job.type === "compliance-process") {
      await processCompliance(job);
    }
    await finishJob(job);
    if (nextCursor) {
      await enqueueJob(job.shop_id, "order-sync", null, { cursor: nextCursor });
    }
    logInfo("job succeeded", { job_id: job.id, shop_id: job.shop_id, type: job.type });
  } catch (error) {
    logError("job failed", {
      job_id: job.id,
      shop_id: job.shop_id,
      type: job.type,
      error: error instanceof Error ? error.message.slice(0, 200) : "error",
    });
    await finishJob(job, error);
  }
}

async function processCompliance(job: JobRow) {
  const topic = String(job.payload.topic ?? "");
  const domain = String(job.payload.shop_domain ?? "");
  if (topic === "shop/redact") {
    await getSupabase().from("shops").delete().eq("shop_domain", domain);
    return;
  }
  if (topic === "customers/redact") {
    const ids = Array.isArray(job.payload.orders_to_redact) ? job.payload.orders_to_redact : [];
    for (const id of ids) {
      const gid = `gid://shopify/Order/${id}`;
      await getSupabase()
        .from("orders")
        .update({
          shipping_name: null,
          shipping_address: null,
          phone: null,
        })
        .eq("shop_id", job.shop_id)
        .eq("shopify_order_gid", gid);
    }
  }
}

export async function drainShopOrderSync(
  shopId: string,
  adminForShop: (shop: string) => Promise<AdminGraphql>,
  maxPages = 8,
) {
  const now = new Date().toISOString();
  await getSupabase()
    .from("background_jobs")
    .update({ status: "QUEUED", locked_until: null })
    .eq("shop_id", shopId)
    .eq("type", "order-sync")
    .eq("status", "RUNNING")
    .lt("locked_until", now);

  const deadline = Date.now() + 15000;
  let processed = 0;
  while (processed < maxPages && Date.now() < deadline) {
    const { data } = await getSupabase()
      .from("background_jobs")
      .select("id, shop_id, type, entity_id, payload, attempts")
      .eq("shop_id", shopId)
      .eq("type", "order-sync")
      .eq("status", "QUEUED")
      .lte("run_after", new Date().toISOString())
      .order("run_after", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!data) break;
    const row = data as JobRow;
    const { data: claimed } = await getSupabase()
      .from("background_jobs")
      .update({
        status: "RUNNING",
        attempts: Number(row.attempts ?? 0) + 1,
        locked_until: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      })
      .eq("id", row.id)
      .eq("status", "QUEUED")
      .select("id, shop_id, type, entity_id, payload, attempts")
      .maybeSingle();
    if (!claimed) break;
    await processJob(claimed as JobRow, adminForShop);
    processed += 1;
  }
  return processed;
}

export async function drainShopShipping(
  shopId: string,
  adminForShop: (shop: string) => Promise<AdminGraphql>,
  maxJobs = 8,
) {
  const types = ["shipment-booking", "label-generation", "shopify-fulfillment"];
  const deadline = Date.now() + 20000;
  let processed = 0;
  while (processed < maxJobs && Date.now() < deadline) {
    const { data } = await getSupabase()
      .from("background_jobs")
      .select("id, shop_id, type, entity_id, payload, attempts")
      .eq("shop_id", shopId)
      .in("type", types)
      .eq("status", "QUEUED")
      .lte("run_after", new Date().toISOString())
      .order("run_after", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!data) break;
    const row = data as JobRow;
    const { data: claimed } = await getSupabase()
      .from("background_jobs")
      .update({
        status: "RUNNING",
        attempts: Number(row.attempts ?? 0) + 1,
        locked_until: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      })
      .eq("id", row.id)
      .eq("status", "QUEUED")
      .select("id, shop_id, type, entity_id, payload, attempts")
      .maybeSingle();
    if (!claimed) break;
    await processJob(claimed as JobRow, adminForShop);
    processed += 1;
  }
  return processed;
}

export async function drainJobs(adminForShop: (shop: string) => Promise<AdminGraphql>, limit = 10) {
  const { data, error } = await getSupabase().rpc("claim_background_jobs", { p_limit: limit });
  if (error) throw new Error(error.message);
  const jobs = (data ?? []) as JobRow[];
  for (const job of jobs) {
    await processJob(job, adminForShop);
  }
  return jobs.length;
}
