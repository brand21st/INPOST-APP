import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getSupabase } from "../db.server";
import { getShopByDomain } from "../../domain/tenancy/shops.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);
  if (!shop) return { orders: [] };
  const { data, error } = await getSupabase()
    .from("orders")
    .select("id, order_name, financial_status, payment_mode, cod_amount, status, pincode")
    .eq("shop_id", shop.id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return { orders: data ?? [] };
};

export default function OrdersIndex() {
  const { orders } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Orders">
      <s-section heading="Shipping projections">
        {orders.length === 0 ? (
          <s-paragraph>No orders yet. New orders arrive from Shopify webhooks after install.</s-paragraph>
        ) : (
          <s-unordered-list>
            {orders.map((order) => {
              const row = order as {
                id: string;
                order_name: string | null;
                payment_mode: string | null;
                status: string;
                cod_amount: number;
              };
              return (
                <s-list-item key={row.id}>
                  <s-link href={`/app/orders/${row.id}`}>
                    {row.order_name ?? row.id} · {row.payment_mode} · {row.status}
                    {Number(row.cod_amount) > 0 ? ` · COD ${row.cod_amount}` : ""}
                  </s-link>
                </s-list-item>
              );
            })}
          </s-unordered-list>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
