import type { LoaderFunctionArgs } from "react-router";
import { getSupabase } from "../db.server";
import { getShopByDomain } from "../../domain/tenancy/shops.server";
import { publicTimeline } from "../../domain/shipping/tracking.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const context = await authenticate.public.appProxy(request);
  if (!context.session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const shop = await getShopByDomain(context.session.shop);
  if (!shop) return Response.json({ error: "not_found" }, { status: 404 });

  const consignment = new URL(request.url).searchParams.get("consignment") ?? "";
  const allowed = await getSupabase().rpc("consume_rate_limit", {
    p_shop_id: shop.id,
    p_key: "public-track",
    p_limit: 30,
    p_window_seconds: 60,
  });
  if (allowed.error || allowed.data !== true) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const timeline = await publicTimeline(shop.id, consignment.trim());
  return Response.json(
    timeline ?? { consignment, status: "NOT_FOUND", events: [] },
    { headers: { "cache-control": "private, no-store" } },
  );
};
