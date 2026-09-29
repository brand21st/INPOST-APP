import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  DescriptionList,
  InlineStack,
  Layout,
  Link,
  Page,
  Text,
} from "@shopify/polaris";
import { getSupabase } from "../db.server";
import { requireInstalledShop } from "../../domain/tenancy/request.server";
import { queueShipmentBooking } from "../../domain/shipping/list.server";
import { formatCreated, formatMoney, serviceMark } from "../../domain/orders/page";
import { isTrackable, trackingUnavailableCopy } from "../../domain/shipping/trackable";
import { drainShopShipping } from "../../workers/processor.server";
import type { AdminGraphql } from "../../shopify/admin-graphql";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireInstalledShop(request);
  if (!params.id) throw new Response("Not found", { status: 404 });
  const { data, error } = await getSupabase()
    .from("shipments")
    .select(
      "id, order_id, status, operational_status, tracking_number, accepted_article_number, last_error, cod_amount, service_code, weight_grams, length_cm, width_cm, height_cm, created_at, updated_at, booked_at, last_tracking_synced_at, last_tracking_location",
    )
    .eq("shop_id", shop.id)
    .eq("id", params.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Response("Not found", { status: 404 });
  const { data: order } = await getSupabase()
    .from("orders")
    .select("id, order_name, shopify_order_gid, shopify_created_at, financial_status, total_amount, payment_mode, shipping_name, shipping_address, phone, pincode")
    .eq("shop_id", shop.id)
    .eq("id", data.order_id)
    .maybeSingle();
  const { data: label } = await getSupabase()
    .from("labels")
    .select("id, status, last_error, created_at, updated_at")
    .eq("shop_id", shop.id)
    .eq("shipment_id", params.id)
    .eq("kind", "INDIA_POST")
    .maybeSingle();
  const { data: contract } = await getSupabase()
    .from("india_post_contracts")
    .select("contract_id")
    .eq("shop_id", shop.id)
    .eq("service_code", data.service_code)
    .maybeSingle();
  const { data: connection } = await getSupabase()
    .from("india_post_connections")
    .select("office_id")
    .eq("shop_id", shop.id)
    .maybeSingle();
  const { data: shopRow } = await getSupabase().from("shops").select("currency, timezone").eq("id", shop.id).maybeSingle();
  return {
    shipment: data,
    order,
    label,
    contractId: (contract as { contract_id: string } | null)?.contract_id ?? null,
    officeId: (connection as { office_id: string | null } | null)?.office_id ?? null,
    currency: (shopRow?.currency as string | null) ?? "INR",
    timeZone: (shopRow?.timezone as string | null) || "UTC",
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, shop } = await requireInstalledShop(request);
  if (!params.id) throw new Response("Not found", { status: 404 });
  await queueShipmentBooking(shop.id, params.id);
  await drainShopShipping(shop.id, async () => admin as AdminGraphql);
  return { ok: true };
};

export default function ShipmentDetail() {
  const data = useLoaderData<typeof loader>();
  const shipment = data.shipment as {
    id: string;
    status: string;
    operational_status: string | null;
    tracking_number: string | null;
    accepted_article_number: string | null;
    last_error: string | null;
    service_code: string;
    cod_amount: number;
    weight_grams: number;
    length_cm: number | null;
    width_cm: number | null;
    height_cm: number | null;
    created_at: string;
    updated_at: string;
    last_tracking_synced_at: string | null;
    last_tracking_location: string | null;
  };
  const order = data.order as {
    id: string;
    order_name: string | null;
    shopify_order_gid: string;
    shopify_created_at: string | null;
    financial_status: string | null;
    total_amount: number | null;
    payment_mode: string | null;
    shipping_name: string | null;
    shipping_address: string | null;
    phone: string | null;
    pincode: string | null;
  } | null;
  const label = data.label as { id: string; status: string; last_error: string | null } | null;
  const created = formatCreated(shipment.created_at, data.timeZone);
  const updated = formatCreated(shipment.updated_at, data.timeZone);
  const orderCreated = formatCreated(order?.shopify_created_at ?? null, data.timeZone);
  const service = serviceMark(shipment.service_code);
  const canRetry = shipment.status === "FAILED" || shipment.status === "QUEUED" || shipment.status === "DRAFT";
  const trackingId = shipment.tracking_number ?? shipment.accepted_article_number ?? "—";
  const lastSynced = shipment.last_tracking_synced_at
    ? formatCreated(shipment.last_tracking_synced_at, data.timeZone)
    : null;

  return (
    <Page
      title={`Shipment ${shipment.id.slice(0, 8)}`}
      backAction={{ content: "Shipments", url: "/app/shipments" }}
      titleMetadata={<Badge tone={shipment.status === "FAILED" ? "critical" : shipment.status === "IN_TRANSIT" ? "attention" : "info"}>{shipment.status}</Badge>}
    >
      <BlockStack gap="400">
        {shipment.last_error ? <Banner tone="critical" title="Shipment error">{shipment.last_error}</Banner> : null}
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center" gap="300">
                    <Text as="h2" variant="headingMd">Shipment</Text>
                    {canRetry ? <Form method="post"><Button submit variant="primary">Retry booking</Button></Form> : null}
                  </InlineStack>
                  <DescriptionList
                    gap="loose"
                    items={[
                      { term: "Shipment ID", description: shipment.id },
                      { term: "India Post article / tracking ID", description: trackingId },
                      { term: "Status", description: `${shipment.status}${shipment.operational_status ? ` · ${shipment.operational_status}` : ""}` },
                      { term: "Service", description: service === "BP" ? "Business Parcel" : service === "SP" ? "Speed Post" : shipment.service_code },
                      { term: "Created", description: `${created.date} ${created.time}` },
                      { term: "Updated", description: `${updated.date} ${updated.time}` },
                    ]}
                  />
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Order</Text>
                  {order ? (
                    <DescriptionList
                      gap="loose"
                      items={[
                        { term: "Shopify order", description: <Link url={`/app/orders/${order.id}`}>{order.order_name ?? order.id}</Link> },
                        { term: "Order ID", description: order.id },
                        { term: "Order date", description: `${orderCreated.date} ${orderCreated.time}` },
                        { term: "Order total", description: formatMoney(order.total_amount, data.currency) },
                        { term: "Payment status", description: order.financial_status ?? order.payment_mode ?? "—" },
                      ]}
                    />
                  ) : <Banner tone="warning">Order was not found.</Banner>}
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Package and tracking</Text>
                  <DescriptionList
                    gap="loose"
                    items={[
                      { term: "Weight", description: `${shipment.weight_grams} g` },
                      ...(shipment.length_cm || shipment.width_cm || shipment.height_cm
                        ? [{ term: "Package", description: `${shipment.length_cm ?? "—"} × ${shipment.width_cm ?? "—"} × ${shipment.height_cm ?? "—"} cm` }]
                        : []),
                      { term: "Contract ID", description: data.contractId ?? "—" },
                      { term: "Drop office ID", description: data.officeId ?? "—" },
                      { term: "Tracking ID", description: shipment.tracking_number ?? "—" },
                      { term: "Location", description: shipment.last_tracking_location ?? "—" },
                      { term: "Last synced", description: lastSynced ? `${lastSynced.date} ${lastSynced.time}` : "—" },
                      { term: "Label status", description: label?.status ?? "None" },
                    ]}
                  />
                  {label?.last_error ? <Banner tone="critical" title="Label error">{label.last_error}</Banner> : null}
                  <InlineStack gap="300" wrap>
                    {isTrackable(shipment.tracking_number, label?.status) ? (
                      <Button url={`/app/tracking?q=${encodeURIComponent(shipment.tracking_number ?? "")}`}>Track shipment</Button>
                    ) : <Text as="p" tone="subdued">{trackingUnavailableCopy(shipment.tracking_number)}</Text>}
                    {label?.status === "READY" ? (
                      <Button url={`/app/labels/${label.id}`} target="_blank" variant="primary">Download official label</Button>
                    ) : <Text as="p" tone="subdued">The official India Post label appears here after generation.</Text>}
                  </InlineStack>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Customer</Text>
                  <DescriptionList
                    items={[
                      { term: "Customer name", description: order?.shipping_name ?? "—" },
                      { term: "Phone", description: order?.phone ?? "—" },
                    ]}
                  />
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Delivery address</Text>
                  <Text as="p">{order?.shipping_address ?? "—"}</Text>
                  <DescriptionList items={[{ term: "Pincode", description: order?.pincode ?? "—" }]} />
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
