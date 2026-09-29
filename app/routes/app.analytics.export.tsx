import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getSupabase } from "../db.server";
import { requireInstalledShop } from "../../domain/tenancy/request.server";
import { analyticsCsv, loadAnalytics } from "../../domain/analytics/query.server";
import { analyticsBounds, analyticsQueryFromParams } from "../../domain/analytics/range";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireInstalledShop(request);
  const shopRow = await getSupabase().from("shops").select("timezone").eq("id", shop.id).maybeSingle();
  const query = analyticsQueryFromParams(new URL(request.url).searchParams);
  const range = analyticsBounds((shopRow.data?.timezone as string | null) || "UTC", query);
  if (!range) throw new Response("Invalid date range", { status: 400 });
  const snapshot = await loadAnalytics(shop.id, range, query.service);
  return new Response(analyticsCsv(snapshot, query), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="analytics.csv"',
    },
  });
};

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
