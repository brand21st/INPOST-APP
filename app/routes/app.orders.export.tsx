import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { requireInstalledShop } from "../../domain/tenancy/request.server";
import { exportOrdersCsv } from "../../domain/orders/list.server";
import { orderQueryFromParams } from "../../domain/orders/page";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireInstalledShop(request);
  const filters = orderQueryFromParams(new URL(request.url).searchParams);
  const csv = await exportOrdersCsv(shop.id, filters);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="orders.csv"',
    },
  });
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
