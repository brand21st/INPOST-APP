import type { ActionFunctionArgs } from "react-router";
import { getSupabase } from "../db.server";
import { sha256 } from "../../lib/crypto.server";
import { enqueueJob } from "../../domain/tenancy/shops.server";

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const token = params.token;
  if (!token) return new Response(null, { status: 404 });
  const { data: connection } = await getSupabase()
    .from("india_post_connections")
    .select("shop_id")
    .eq("inbound_token_hash", sha256(token))
    .maybeSingle();
  const shopId = (connection as { shop_id: string } | null)?.shop_id;
  if (!shopId) return new Response(null, { status: 404 });

  const allowed = await getSupabase().rpc("consume_rate_limit", {
    p_shop_id: shopId,
    p_key: "india-post-inbound",
    p_limit: 60,
    p_window_seconds: 60,
  });
  if (allowed.error || allowed.data !== true) {
    return new Response(null, { status: 429 });
  }

  const payload = (await request.json()) as Record<string, unknown>;
  const barcode = String(payload.barcode ?? payload.article_number ?? payload.consignment_number ?? "");
  const { data: allocation } = await getSupabase()
    .from("barcode_allocations")
    .select("id")
    .eq("shop_id", shopId)
    .eq("s10", barcode)
    .maybeSingle();
  if (!allocation) return new Response(null, { status: 202 });

  const externalId = sha256(`${shopId}:${barcode}:${JSON.stringify(payload)}`);
  const { data: inbox, error } = await getSupabase()
    .from("webhook_inbox")
    .upsert(
      {
        source: "INDIA_POST",
        shop_id: shopId,
        topic: "india-post/events",
        external_id: externalId,
        payload,
        payload_hash: externalId,
        status: "RECEIVED",
      },
      { onConflict: "source,external_id", ignoreDuplicates: true },
    )
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  const inboxId = (inbox as { id: string } | null)?.id;
  if (inboxId) await enqueueJob(shopId, "india-post-events", inboxId, {});
  return new Response(null, { status: 200 });
};
