import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getSupabase } from "../db.server";
import { getShopByDomain } from "../../domain/tenancy/shops.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);
  if (!shop || !params.id) throw new Response("Not found", { status: 404 });
  const { data, error } = await getSupabase()
    .from("shipments")
    .select("id, status, operational_status, tracking_number, last_error, cod_amount, service_code")
    .eq("shop_id", shop.id)
    .eq("id", params.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Response("Not found", { status: 404 });
  const { data: label } = await getSupabase()
    .from("labels")
    .select("id, status")
    .eq("shop_id", shop.id)
    .eq("shipment_id", params.id)
    .eq("kind", "INDIA_POST")
    .maybeSingle();
  return { shipment: data, label };
};

export default function ShipmentDetail() {
  const { shipment, label } = useLoaderData<typeof loader>();
  const row = shipment as {
    status: string;
    operational_status: string | null;
    tracking_number: string | null;
    last_error: string | null;
    service_code: string;
    cod_amount: number;
  };
  const labelRow = label as { id: string; status: string } | null;

  return (
    <s-page heading="Shipment">
      <s-section heading={row.status}>
        <s-paragraph>
          {row.service_code}
          {row.tracking_number ? ` · ${row.tracking_number}` : ""} · {row.operational_status ?? "pending"}
          {Number(row.cod_amount) > 0 ? ` · COD ${row.cod_amount}` : ""}
        </s-paragraph>
        {row.last_error ? <s-banner tone="critical">{row.last_error}</s-banner> : null}
        {labelRow?.status === "READY" ? (
          <s-link href={`/app/labels/${labelRow.id}`} target="_blank">
            Download official label
          </s-link>
        ) : (
          <s-paragraph>The official India Post label appears here after booking.</s-paragraph>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
