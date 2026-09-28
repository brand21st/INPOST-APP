import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getSupabase } from "../db.server";
import { getShopByDomain } from "../../domain/tenancy/shops.server";
import { createShipment } from "../../domain/shipping/orders.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);
  if (!shop || !params.id) throw new Response("Not found", { status: 404 });
  const { data: order, error } = await getSupabase()
    .from("orders")
    .select("id, order_name, payment_mode, cod_amount, status, shipping_name, pincode, phone")
    .eq("shop_id", shop.id)
    .eq("id", params.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!order) throw new Response("Not found", { status: 404 });
  const { data: shipment } = await getSupabase()
    .from("shipments")
    .select("id, status, tracking_number")
    .eq("shop_id", shop.id)
    .eq("order_id", params.id)
    .neq("status", "CANCELLED")
    .maybeSingle();
  const { data: settings } = await getSupabase()
    .from("shop_settings")
    .select("default_service, default_parcel_grams")
    .eq("shop_id", shop.id)
    .maybeSingle();
  return { order, shipment, settings };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);
  if (!shop || !params.id) throw new Response("Not found", { status: 404 });
  const { data: settings } = await getSupabase()
    .from("shop_settings")
    .select("default_service, default_parcel_grams")
    .eq("shop_id", shop.id)
    .single();
  const row = settings as { default_service: string; default_parcel_grams: number };
  const shipmentId = await createShipment(
    shop.id,
    params.id,
    row.default_service,
    row.default_parcel_grams,
    true,
  );
  return { shipmentId };
};

export default function OrderDetail() {
  const { order, shipment } = useLoaderData<typeof loader>();
  const row = order as {
    order_name: string | null;
    payment_mode: string | null;
    cod_amount: number;
    status: string;
    shipping_name: string | null;
    pincode: string | null;
  };
  const parcel = shipment as { id: string; status: string; tracking_number: string | null } | null;

  return (
    <s-page heading={row.order_name ?? "Order"}>
      <s-section heading="Shipment">
        <s-paragraph>
          {row.payment_mode} {Number(row.cod_amount) > 0 ? `· collect ${row.cod_amount}` : ""} ·{" "}
          {row.shipping_name} · {row.pincode} · {row.status}
        </s-paragraph>
        {parcel ? (
          <s-link href={`/app/shipments/${parcel.id}`}>
            Shipment {parcel.status}
            {parcel.tracking_number ? ` · ${parcel.tracking_number}` : ""}
          </s-link>
        ) : (
          <Form method="post">
            <s-button type="submit" variant="primary">
              Queue booking
            </s-button>
          </Form>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
