import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  DescriptionList,
  InlineStack,
  Layout,
  Link,
  Page,
  Spinner,
  Text,
} from "@shopify/polaris";
import { getSupabase } from "../db.server";
import { requireInstalledShop } from "../../domain/tenancy/request.server";
import { createShipment } from "../../domain/shipping/orders.server";
import { getOrderSyncState } from "../../domain/orders/list.server";
import { isTrackable, trackingUnavailableCopy } from "../../domain/shipping/tracking.server";
import { drainShopShipping } from "../../workers/processor.server";
import type { AdminGraphql } from "../../shopify/admin-graphql";

function formatWhen(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireInstalledShop(request);
  if (!params.id) throw new Response("Not found", { status: 404 });
  const { data: order, error } = await getSupabase()
    .from("orders")
    .select(
      "id, order_name, shopify_order_gid, shopify_created_at, financial_status, fulfillment_status, payment_mode, cod_amount, total_amount, status, shipping_name, shipping_address, pincode, phone",
    )
    .eq("shop_id", shop.id)
    .eq("id", params.id)
    .maybeSingle();
  if (error) throw new Response("Orders could not be loaded", { status: 500 });
  if (!order) throw new Response("Not found", { status: 404 });
  const { data: lines, error: lineError } = await getSupabase()
    .from("order_line_items")
    .select("id, title, sku, quantity, unit_price")
    .eq("shop_id", shop.id)
    .eq("order_id", params.id);
  if (lineError) throw new Response("Orders could not be loaded", { status: 500 });
  const { data: shipment } = await getSupabase()
    .from("shipments")
    .select("id, status, tracking_number")
    .eq("shop_id", shop.id)
    .eq("order_id", params.id)
    .neq("status", "CANCELLED")
    .maybeSingle();
  const { data: label } = shipment
    ? await getSupabase()
        .from("labels")
        .select("status")
        .eq("shop_id", shop.id)
        .eq("shipment_id", (shipment as { id: string }).id)
        .eq("kind", "INDIA_POST")
        .maybeSingle()
    : { data: null };
  const { data: settings } = await getSupabase()
    .from("shop_settings")
    .select("default_service, default_parcel_grams")
    .eq("shop_id", shop.id)
    .maybeSingle();
  let sync = null;
  try {
    sync = await getOrderSyncState(shop.id);
  } catch {
    sync = null;
  }
  return {
    order,
    lines: lines ?? [],
    shipment,
    labelStatus: (label as { status: string } | null)?.status ?? null,
    settings,
    sync,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, shop } = await requireInstalledShop(request);
  if (!params.id) throw new Response("Not found", { status: 404 });
  const { data: settings } = await getSupabase()
    .from("shop_settings")
    .select("default_service, default_parcel_grams")
    .eq("shop_id", shop.id)
    .single();
  const row = settings as { default_service: string; default_parcel_grams: number };
  const { data: existing } = await getSupabase()
    .from("shipments")
    .select("service_code")
    .eq("shop_id", shop.id)
    .eq("order_id", params.id)
    .neq("status", "CANCELLED")
    .maybeSingle();
  const shipmentId = await createShipment(
    shop.id,
    params.id,
    String((existing as { service_code?: string } | null)?.service_code ?? row.default_service),
    row.default_parcel_grams,
    true,
  );
  await drainShopShipping(shop.id, async () => admin as AdminGraphql);
  return { shipmentId };
};

export default function OrderDetail() {
  const { order, lines, shipment, labelStatus, sync } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const row = order as {
    order_name: string | null;
    shopify_order_gid: string;
    shopify_created_at: string | null;
    financial_status: string | null;
    fulfillment_status: string | null;
    payment_mode: string | null;
    cod_amount: number;
    total_amount: number | null;
    status: string;
    shipping_name: string | null;
    shipping_address: string | null;
    pincode: string | null;
    phone: string | null;
  };
  const parcel = shipment as { id: string; status: string; tracking_number: string | null } | null;
  const syncState = sync as { finished_at: string | null; updated_at: string | null } | null;
  const lineRows = lines as Array<{
    id: string;
    title: string | null;
    sku: string | null;
    quantity: number;
    unit_price: number | null;
  }>;

  return (
    <Page
      title={row.order_name ?? "Order"}
      backAction={{ content: "Orders", url: "/app/orders" }}
    >
      <Layout>
        {navigation.state !== "idle" ? (
          <Layout.Section>
            <Banner tone="info">
              <InlineStack gap="200" blockAlign="center">
                <Spinner accessibilityLabel="Loading order" size="small" />
                <Text as="p">Loading order…</Text>
              </InlineStack>
            </Banner>
          </Layout.Section>
        ) : null}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Order</Text>
              <DescriptionList
                items={[
                  { term: "Order", description: row.order_name ?? "—" },
                  { term: "Created", description: formatWhen(row.shopify_created_at) },
                  { term: "Financial status", description: row.financial_status ?? "—" },
                  { term: "Fulfillment status", description: row.fulfillment_status ?? "—" },
                  { term: "Total", description: Number(row.total_amount ?? 0).toFixed(2) },
                  { term: "Status", description: row.status },
                  { term: "Shopify ID", description: row.shopify_order_gid },
                  {
                    term: "Last sync",
                    description: formatWhen(syncState?.finished_at ?? syncState?.updated_at),
                  },
                ]}
              />
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Customer</Text>
              <DescriptionList
                items={[
                  { term: "Name", description: row.shipping_name ?? "—" },
                  { term: "Address", description: row.shipping_address ?? "—" },
                  { term: "Pincode", description: row.pincode ?? "—" },
                  { term: "Phone", description: row.phone ?? "—" },
                ]}
              />
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Line items</Text>
              {lineRows.length === 0 ? (
                <Text as="p" tone="subdued">No line items.</Text>
              ) : (
                <DescriptionList
                  items={lineRows.map((line) => ({
                    term: line.title ?? "Item",
                    description: `SKU ${line.sku ?? "—"} · Quantity ${line.quantity} · ${
                      line.unit_price == null ? "—" : Number(line.unit_price).toFixed(2)
                    }`,
                  }))}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Payment</Text>
              <Text as="p">
                {row.payment_mode ?? "—"}
                {row.payment_mode === "COD" ? ` · COD ${Number(row.cod_amount).toFixed(2)}` : ""}
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Shipment</Text>
              <Text as="p">
                {row.payment_mode} {Number(row.cod_amount) > 0 ? `· collect ${row.cod_amount}` : ""}{" "}
                · {row.shipping_name} · {row.pincode} · {row.status}
              </Text>
              {parcel ? (
                <InlineStack gap="300">
                  <Link url={`/app/shipments/${parcel.id}`}>
                    Shipment {parcel.status}
                    {parcel.tracking_number ? ` · ${parcel.tracking_number}` : ""}
                  </Link>
                  {isTrackable(parcel.tracking_number, labelStatus) ? (
                    <Link url={`/app/tracking?q=${encodeURIComponent(parcel.tracking_number ?? "")}`}>
                      Track
                    </Link>
                  ) : (
                    <Text as="p" tone="subdued">
                      {trackingUnavailableCopy(parcel.tracking_number)}
                    </Text>
                  )}
                </InlineStack>
              ) : (
                <Form method="post">
                  <Button submit variant="primary">Queue booking</Button>
                </Form>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
