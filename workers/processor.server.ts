import { getSupabase } from "../app/db.server";
import { bookShipment } from "../domain/shipping/booking.server";
import { generateOfficialLabel } from "../domain/labels/store.server";
import { projectionFromRestOrder, upsertOrderProjection, maybeAutoBook } from "../domain/shipping/orders.server";
import { applyTrackingEvent } from "../domain/shipping/tracking.server";
import { isPermanent, retryDelaySeconds } from "../domain/india-post/errors";
import { CeptError } from "../domain/india-post/client.server";
import { writeShopifyFulfillment } from "../shopify/fulfillments.server";
import { UNFULFILLED_ORDERS } from "../shopify/graphql";
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

async function processOrderSync(job: JobRow, adminForShop: (shop: string) => Promise<AdminGraphql>) {
  const { data: shop } = await getSupabase()
    .from("shops")
    .select("shop_domain")
    .eq("id", job.shop_id)
    .single();
  const domain = (shop as { shop_domain: string }).shop_domain;
  const admin = await adminForShop(domain);
  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const cursor = typeof job.payload.cursor === "string" ? job.payload.cursor : null;
  const response = await admin.graphql(UNFULFILLED_ORDERS, {
    variables: {
      cursor,
      query: `fulfillment_status:unfulfilled created_at:>=${since}`,
    },
  });
  const body = (await response.json()) as {
    data?: {
      orders?: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<Record<string, unknown>>;
      };
    };
  };
  const connection = body.data?.orders;
  for (const node of connection?.nodes ?? []) {
    const address = (node.shippingAddress ?? {}) as Record<string, unknown>;
    const total = (node.currentTotalPriceSet as { shopMoney?: { amount?: string } } | null)?.shopMoney?.amount;
    const outstanding = (node.totalOutstandingSet as { shopMoney?: { amount?: string } } | null)?.shopMoney?.amount;
    const lines = ((node.lineItems as { nodes?: Record<string, unknown>[] } | null)?.nodes ?? []).map((line) => ({
      gid: String(line.id),
      title: typeof line.title === "string" ? line.title : null,
      sku: typeof line.sku === "string" ? line.sku : null,
      quantity: Number(line.quantity ?? 1),
      grams: null,
    }));
    const orderId = await upsertOrderProjection(job.shop_id, {
      shopifyOrderGid: String(node.id),
      orderName: typeof node.name === "string" ? node.name : null,
      financialStatus: typeof node.displayFinancialStatus === "string" ? node.displayFinancialStatus : null,
      fulfillmentStatus:
        typeof node.displayFulfillmentStatus === "string" ? node.displayFulfillmentStatus : null,
      gatewayNames: Array.isArray(node.paymentGatewayNames)
        ? node.paymentGatewayNames.filter((name): name is string => typeof name === "string")
        : [],
      orderTotal: Number(total ?? 0),
      amountOutstanding: Number(outstanding ?? 0),
      shippingName: typeof address.name === "string" ? address.name : null,
      shippingAddress: [address.address1, address.address2, address.city, address.zip]
        .filter((part) => typeof part === "string")
        .join(", "),
      phone: typeof address.phone === "string" ? address.phone : null,
      pincode: typeof address.zip === "string" ? address.zip : null,
      cancelledAt: typeof node.cancelledAt === "string" ? node.cancelledAt : null,
      lines,
    });
    await maybeAutoBook(job.shop_id, orderId);
  }
  if (connection?.pageInfo.hasNextPage && connection.pageInfo.endCursor) {
    const { enqueueJob } = await import("../domain/tenancy/shops.server");
    await enqueueJob(job.shop_id, "order-sync", null, { cursor: connection.pageInfo.endCursor });
  }
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
  try {
    if (job.type === "shipment-booking" && job.entity_id) {
      await bookShipment(job.shop_id, job.entity_id);
    } else if (job.type === "label-generation" && job.entity_id) {
      await generateOfficialLabel(job.shop_id, job.entity_id);
    } else if (job.type === "shopify-fulfillment" && job.entity_id) {
      await processFulfillment(job, adminForShop);
    } else if (job.type === "order-sync") {
      await processOrderSync(job, adminForShop);
    } else if (job.type === "webhook-process" || job.type === "india-post-events") {
      await processInbox(job);
    } else if (job.type === "compliance-process") {
      await processCompliance(job);
    }
    await finishJob(job);
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

export async function drainJobs(adminForShop: (shop: string) => Promise<AdminGraphql>, limit = 10) {
  const { data, error } = await getSupabase().rpc("claim_background_jobs", { p_limit: limit });
  if (error) throw new Error(error.message);
  const jobs = (data ?? []) as JobRow[];
  for (const job of jobs) {
    await processJob(job, adminForShop);
  }
  return jobs.length;
}
