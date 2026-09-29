import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  DataTable,
  EmptyState,
  InlineStack,
  Page,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import { RefreshIcon, SearchIcon } from "@shopify/polaris-icons";
import { requireInstalledShop } from "../../domain/tenancy/request.server";
import { formatCreated } from "../../domain/orders/page";
import { loadMerchantTracking, refreshMerchantTracking, type MerchantTrackingView } from "../../domain/shipping/tracking.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireInstalledShop(request);
  const q = new URL(request.url).searchParams.get("q") ?? "";
  if (!q.trim()) {
    return { q: "", view: null as MerchantTrackingView | null, error: null as string | null };
  }
  const result = await loadMerchantTracking(shop.id, q);
  if (!result.ok) return { q, view: null, error: result.message };
  return { q, view: result.view, error: null };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireInstalledShop(request);
  const form = await request.formData();
  if (form.get("intent") !== "refresh") {
    return { ok: false as const, error: "Action is not available.", view: null as MerchantTrackingView | null };
  }
  const tracking = String(form.get("q") ?? form.get("tracking_number") ?? "");
  const result = await refreshMerchantTracking(shop.id, tracking);
  if (!result.ok) return { ok: false as const, error: result.message, view: null };
  return { ok: true as const, error: null as string | null, view: result.view };
};

export default function TrackingIndex() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [query, setQuery] = useState(data.q);
  const view = actionData?.view ?? data.view;
  const error = actionData?.error ?? data.error;
  const isSearching = navigation.state !== "idle" && navigation.formMethod === "GET";
  const isRefreshing = navigation.state !== "idle" && navigation.formData?.get("intent") === "refresh";

  return (
    <Page title="Tracking" subtitle="Look up India Post consignments booked for this shop.">
      <BlockStack gap="400">
        {error ? <Banner tone="critical" title={error} /> : null}
        <Card>
          <Form method="get">
            <BlockStack gap="300">
              <TextField
                label="Tracking ID"
                name="q"
                type="search"
                autoComplete="off"
                placeholder="Enter tracking ID"
                value={query}
                onChange={setQuery}
              />
              <InlineStack align="end">
                <Button submit variant="primary" icon={SearchIcon} loading={isSearching}>
                  Look up
                </Button>
              </InlineStack>
            </BlockStack>
          </Form>
        </Card>

        {navigation.state !== "idle" && !view ? (
          <Card>
            <InlineStack gap="200" align="center" blockAlign="center">
              <Spinner accessibilityLabel="Loading tracking" size="small" />
              <Text as="p">Loading tracking…</Text>
            </InlineStack>
          </Card>
        ) : null}

        {view ? (
          <>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">Shipment</Text>
                  <Form method="post">
                    <input type="hidden" name="intent" value="refresh" />
                    <input type="hidden" name="q" value={view.trackingNumber} />
                    <input type="hidden" name="shipment_id" value={view.shipmentId} />
                    <Button submit icon={RefreshIcon} loading={isRefreshing}>
                      Refresh tracking
                    </Button>
                  </Form>
                </InlineStack>
                <DataTable
                  columnContentTypes={["text", "text"]}
                  headings={["Detail", "Value"]}
                  rows={[
                    ["Tracking ID", view.trackingNumber],
                    ["Service", view.service === "BP" ? "Business Parcel" : view.service === "SP" ? "Speed Post" : "—"],
                    ["Status", view.operationalStatus ?? view.status],
                    ["Location", view.location ?? "—"],
                    [
                      "Last synced",
                      view.lastSyncedAt
                        ? `${formatCreated(view.lastSyncedAt, view.timeZone).date} ${formatCreated(view.lastSyncedAt, view.timeZone).time}`
                        : "Not synced",
                    ],
                    ["Customer", `${view.customer} · ${view.pincode || "—"}`],
                    ["Order", <Button variant="plain" url={`/app/orders/${view.orderId}`}>{view.orderName}</Button>],
                  ]}
                />
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Timeline</Text>
                {view.events.length === 0 ? (
                  <EmptyState
                    heading="No tracking events yet"
                    image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                  >
                    <Text as="p">Refresh tracking to fetch the latest India Post updates.</Text>
                  </EmptyState>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "text", "text"]}
                    headings={["Date and time", "Event", "Location"]}
                    rows={view.events.map((event) => {
                      const when = formatCreated(event.at, view.timeZone);
                      return [`${when.date} ${when.time}`.trim(), event.summary ?? "Update", event.location ?? "—"];
                    })}
                  />
                )}
              </BlockStack>
            </Card>
          </>
        ) : null}
      </BlockStack>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
