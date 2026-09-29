import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getSupabase } from "../db.server";
import { requireInstalledShop } from "../../domain/tenancy/request.server";
import { loadAnalytics } from "../../domain/analytics/query.server";
import { analyticsBounds, analyticsQueryFromParams } from "../../domain/analytics/range";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireInstalledShop(request);
  const allowed = await getSupabase().rpc("consume_rate_limit", {
    p_shop_id: shop.id,
    p_key: "admin-analytics",
    p_limit: 20,
    p_window_seconds: 60,
  });
  if (allowed.error || allowed.data !== true) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }
  const query = analyticsQueryFromParams(new URL(request.url).searchParams);
  const shopRow = await getSupabase().from("shops").select("timezone").eq("id", shop.id).maybeSingle();
  const range = analyticsBounds((shopRow.data?.timezone as string | null) || "UTC", query);
  if (!range) return Response.json({ error: "invalid_range" }, { status: 400 });
  try {
    const snapshot = await loadAnalytics(shop.id, range, query.service);
    return Response.json(snapshot);
  } catch {
    return Response.json({ error: "unavailable" }, { status: 500 });
  }
};

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
