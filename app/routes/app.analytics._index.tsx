import { useCallback, useEffect, useMemo, useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigation, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Banner,
  BlockStack,
  Button,
  ButtonGroup,
  Card,
  DataTable,
  DatePicker,
  EmptyState,
  InlineGrid,
  Layout,
  Page,
  Popover,
  ProgressBar,
  Select,
  SkeletonBodyText,
  SkeletonPage,
  Text,
  Tooltip,
} from "@shopify/polaris";
import { ExportIcon, FilterIcon, RefreshIcon } from "@shopify/polaris-icons";
import { getSupabase } from "../db.server";
import { requireInstalledShop } from "../../domain/tenancy/request.server";
import { formatCreated, formatMoney } from "../../domain/orders/page";
import { loadAnalytics } from "../../domain/analytics/query.server";
import { analyticsBounds, analyticsQueryFromParams, type AnalyticsPreset } from "../../domain/analytics/range";
import { useAnalyticsPoll } from "../../domain/analytics/useAnalyticsPoll";
import type { AnalyticsSnapshot, KpiValue } from "../../domain/analytics/types";

const PRESET_LABELS: Array<{ id: AnalyticsPreset; label: string }> = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "last_7", label: "Last 7 days" },
  { id: "last_30", label: "Last 30 days" },
  { id: "this_month", label: "This month" },
  { id: "last_month", label: "Last month" },
  { id: "custom", label: "Custom" },
];

function deltaText(value: KpiValue) {
  if (value.change == null) return "";
  const arrow = value.change >= 0 ? "↑" : "↓";
  return `${arrow} ${Math.abs(value.change).toFixed(1)}%`;
}

function hoursText(value: number | null, enough: boolean) {
  if (!enough || value == null) return "Not enough data";
  return `${value.toFixed(1)} h`;
}

function rateText(value: number | null) {
  if (value == null) return "Not enough data";
  return `${(value * 100).toFixed(1)}%`;
}

function updatedLabel(fetchedAt: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - new Date(fetchedAt).getTime()) / 1000));
  if (seconds < 3) return "Last updated just now";
  return `Last updated ${seconds} seconds ago`;
}

function statusRows(values: Record<string, number>) {
  return Object.entries(values).map(([status, count]) => [status, String(count)]);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireInstalledShop(request);
  const query = analyticsQueryFromParams(new URL(request.url).searchParams);
  const shopRow = await getSupabase().from("shops").select("timezone").eq("id", shop.id).maybeSingle();
  const timezone = (shopRow.data?.timezone as string | null) || "UTC";
  const range = analyticsBounds(timezone, query);
  if (!range) {
    return { snapshot: null as AnalyticsSnapshot | null, query, error: "invalid_range" as string | null };
  }
  try {
    const snapshot = await loadAnalytics(shop.id, range, query.service);
    return { snapshot, query, error: null as string | null };
  } catch {
    return { snapshot: null as AnalyticsSnapshot | null, query, error: "unavailable" };
  }
};

export default function AnalyticsIndex() {
  const loaded = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [snapshot, setSnapshot] = useState<AnalyticsSnapshot | null>(loaded.snapshot);
  const [pollError, setPollError] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [picker, setPicker] = useState(false);
  const [month, setMonth] = useState(() => new Date().getMonth());
  const [year, setYear] = useState(() => new Date().getFullYear());

  useEffect(() => {
    setSnapshot(loaded.snapshot);
    setPollError(false);
  }, [loaded.snapshot]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useAnalyticsPoll(
    `?${searchParams.toString()}`,
    (next) => {
      setSnapshot(next);
      setPollError(false);
    },
    () => setPollError(true),
    Boolean(loaded.snapshot || snapshot),
  );

  const setPreset = useCallback(
    (preset: AnalyticsPreset) => {
      const next = new URLSearchParams(searchParams);
      next.set("preset", preset);
      if (preset !== "custom") {
        next.delete("from");
        next.delete("to");
      }
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  const customRange = useMemo(() => {
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    if (!from || !to) {
      const today = new Date();
      return { start: today, end: today };
    }
    return { start: new Date(`${from}T00:00:00`), end: new Date(`${to}T00:00:00`) };
  }, [searchParams]);

  if (navigation.state === "loading" && !snapshot) {
    return (
      <SkeletonPage title="Analytics">
        <Card>
          <SkeletonBodyText lines={8} />
        </Card>
      </SkeletonPage>
    );
  }

  const query = analyticsQueryFromParams(searchParams);
  const currency = snapshot?.currency ?? "INR";
  const zone = snapshot?.timezone ?? "UTC";

  return (
    <Page
        title="Analytics"
        subtitle={snapshot ? `${snapshot.rangeLabel} · ${updatedLabel(snapshot.fetchedAt, now)}` : undefined}
        primaryAction={
          snapshot
            ? {
                content: "Export CSV",
                url: `/app/analytics/export?${searchParams.toString()}`,
                icon: ExportIcon,
              }
            : undefined
        }
      >
        <BlockStack gap="400">
          {loaded.error && !snapshot ? (
            <Banner tone="critical" title="Analytics couldn't be updated. Please try again.">
              <Button icon={RefreshIcon} onClick={() => window.location.reload()}>Refresh analytics</Button>
            </Banner>
          ) : null}
          {pollError && snapshot ? (
            <Banner tone="warning" title="Analytics couldn't be updated. Please try again.">
              <Button icon={RefreshIcon} onClick={() => window.location.reload()}>Refresh analytics</Button>
            </Banner>
          ) : null}
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Date range
              </Text>
              <ButtonGroup variant="segmented">
                {PRESET_LABELS.map((item) => (
                  <Button key={item.id} pressed={query.preset === item.id} onClick={() => setPreset(item.id)}>
                    {item.label}
                  </Button>
                ))}
              </ButtonGroup>
              {query.preset === "custom" ? (
                <Popover
                  active={picker}
                  activator={
                    <Button icon={FilterIcon} onClick={() => setPicker((open) => !open)} disclosure>
                      {searchParams.get("from") && searchParams.get("to")
                        ? `${searchParams.get("from")} – ${searchParams.get("to")}`
                        : "Choose dates"}
                    </Button>
                  }
                  onClose={() => setPicker(false)}
                >
                  <DatePicker
                    month={month}
                    year={year}
                    allowRange
                    selected={customRange}
                    onMonthChange={(nextMonth, nextYear) => {
                      setMonth(nextMonth);
                      setYear(nextYear);
                    }}
                    onChange={(range) => {
                      const from = range.start.toISOString().slice(0, 10);
                      const to = range.end.toISOString().slice(0, 10);
                      const next = new URLSearchParams(searchParams);
                      next.set("preset", "custom");
                      next.set("from", from);
                      next.set("to", to);
                      setSearchParams(next);
                    }}
                  />
                </Popover>
              ) : null}
              <Select
                label="Service"
                options={[
                  { label: "All services", value: "" },
                  { label: "Speed Post", value: "SP_INLAND_PARCEL" },
                  { label: "Business Parcel", value: "BUSINESS_PARCEL" },
                ]}
                value={query.service ?? ""}
                onChange={(value) => {
                  const next = new URLSearchParams(searchParams);
                  if (value) next.set("service", value);
                  else next.delete("service");
                  setSearchParams(next);
                }}
              />
            </BlockStack>
          </Card>
          {!snapshot && loaded.error ? null : snapshot && snapshot.shopOrderCount === 0 ? (
            <Card>
              <EmptyState
                heading="No order data yet"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>Analytics will appear once Shopify orders are synced for this shop.</p>
              </EmptyState>
            </Card>
          ) : snapshot ? (
            <>
              <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
                {(
                  [
                    ["Orders received", snapshot.kpis.ordersReceived],
                    ["Orders shipped", snapshot.kpis.ordersShipped],
                    ["In transit", snapshot.kpis.inTransit],
                    ["Delivered", snapshot.kpis.delivered],
                    ["Returned", snapshot.kpis.returned],
                    ["COD orders", snapshot.kpis.codOrders],
                  ] as Array<[string, KpiValue]>
                ).map(([label, value]) => (
                  <Card key={label}>
                    <BlockStack gap="100">
                      <Text as="h3" variant="headingSm" tone="subdued">
                        {label}
                      </Text>
                      <Text as="p" variant="headingXl">
                        {value.current.toLocaleString("en-IN")}
                      </Text>
                      {deltaText(value) ? <Text as="p">{deltaText(value)}</Text> : null}
                    </BlockStack>
                  </Card>
                ))}
              </InlineGrid>
              <Layout>
                <Layout.Section>
                  <Card>
                    <BlockStack gap="300">
                      <Text as="h2" variant="headingMd">
                        Order analytics
                      </Text>
                      <DataTable
                        columnContentTypes={["text", "numeric"]}
                        headings={["Metric", "Count"]}
                        rows={[
                          ["Total orders", snapshot.orders.total],
                          ["New orders", snapshot.orders.new],
                          ["Shipped orders", snapshot.orders.shipped],
                          ["Pending shipment", snapshot.orders.pendingShipment],
                          ["Cancelled orders", snapshot.orders.cancelled],
                          ["Returned orders", snapshot.orders.returned],
                        ]}
                      />
                    </BlockStack>
                  </Card>
                </Layout.Section>
                <Layout.Section>
                  <Card>
                    <BlockStack gap="300">
                      <Text as="h2" variant="headingMd">
                        Shipping analytics
                      </Text>
                      <DataTable
                        columnContentTypes={["text", "numeric"]}
                        headings={["Metric", "Count"]}
                        rows={[
                          ["Total shipments", snapshot.shipping.total],
                          ["Shipments created", snapshot.shipping.created],
                          ["Labels generated", snapshot.shipping.labelsGenerated],
                          ["Labels printed", "Not available"],
                          ["In transit", snapshot.shipping.inTransit],
                          ["Delivered", snapshot.shipping.delivered],
                          ["Failed delivery (NDR)", snapshot.shipping.failedDelivery],
                          ["Returned", snapshot.shipping.returned],
                        ]}
                      />
                      <Text as="p" tone="subdued">
                        Print is not connected. Label download is not counted as printed.
                      </Text>
                    </BlockStack>
                  </Card>
                </Layout.Section>
              </Layout>
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Orders over time
                  </Text>
                  <DataTable
                    columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric"]}
                    headings={["Date", "Orders", "Shipments", "Delivered", "Returns"]}
                    rows={snapshot.trends.map((row) => [row.day, row.orders, row.shipments, row.delivered, row.returns])}
                  />
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    India Post service breakdown
                  </Text>
                  <Text as="p" tone="subdued">
                    Orders without a shipment use the shop default service.
                  </Text>
                  <DataTable
                    columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric"]}
                    headings={["Service", "Orders", "Shipments", "Labels generated", "In transit", "Delivered", "Returned", "COD orders"]}
                    rows={[
                      [
                        "Speed Post",
                        snapshot.services.SP_INLAND_PARCEL.orders,
                        snapshot.services.SP_INLAND_PARCEL.shipments,
                        snapshot.services.SP_INLAND_PARCEL.labelsGenerated,
                        snapshot.services.SP_INLAND_PARCEL.inTransit,
                        snapshot.services.SP_INLAND_PARCEL.delivered,
                        snapshot.services.SP_INLAND_PARCEL.returned,
                        snapshot.services.SP_INLAND_PARCEL.codOrders,
                      ],
                      [
                        "Business Parcel",
                        snapshot.services.BUSINESS_PARCEL.orders,
                        snapshot.services.BUSINESS_PARCEL.shipments,
                        snapshot.services.BUSINESS_PARCEL.labelsGenerated,
                        snapshot.services.BUSINESS_PARCEL.inTransit,
                        snapshot.services.BUSINESS_PARCEL.delivered,
                        snapshot.services.BUSINESS_PARCEL.returned,
                        snapshot.services.BUSINESS_PARCEL.codOrders,
                      ],
                    ]}
                  />
                </BlockStack>
              </Card>
              <Layout>
                <Layout.Section>
                  <Card>
                    <BlockStack gap="300">
                      <Text as="h2" variant="headingMd">
                        Delivery performance
                      </Text>
                      <DataTable
                        columnContentTypes={["text", "text"]}
                        headings={["Metric", "Value"]}
                        rows={[
                          ["Delivered", String(snapshot.delivery.delivered)],
                          ["Average delivery time", hoursText(snapshot.delivery.avgHours, snapshot.delivery.enough)],
                          ["Fastest delivery", hoursText(snapshot.delivery.fastestHours, snapshot.delivery.enough)],
                          ["Longest delivery", hoursText(snapshot.delivery.longestHours, snapshot.delivery.enough)],
                          ["In transit", String(snapshot.delivery.inTransit)],
                          ["Delivery success rate", rateText(snapshot.delivery.successRate)],
                          ["Return rate", rateText(snapshot.delivery.returnRate)],
                        ]}
                      />
                    </BlockStack>
                  </Card>
                </Layout.Section>
                <Layout.Section>
                  <Card>
                    <BlockStack gap="300">
                      <Text as="h2" variant="headingMd">
                        COD analytics
                      </Text>
                      <DataTable
                        columnContentTypes={["text", "text"]}
                        headings={["Metric", "Value"]}
                        rows={[
                          ["Total COD orders", String(snapshot.cod.orders)],
                          ["COD order value", formatMoney(snapshot.cod.orderValue, currency)],
                          ["COD collected on delivery", formatMoney(snapshot.cod.collected, currency)],
                          ["COD delivered", String(snapshot.cod.delivered)],
                          ["COD returned", String(snapshot.cod.returned)],
                          ["COD pending", String(snapshot.cod.pending)],
                          ["COD pending value", formatMoney(snapshot.cod.pendingValue, currency)],
                          ["COD returned value", formatMoney(snapshot.cod.returnedValue, currency)],
                          ["COD delivery rate", rateText(snapshot.cod.deliveryRate)],
                          ["COD return rate", rateText(snapshot.cod.returnRate)],
                        ]}
                      />
                    </BlockStack>
                  </Card>
                </Layout.Section>
              </Layout>
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Returns
                  </Text>
                  <DataTable
                    columnContentTypes={["text", "text"]}
                    headings={["Metric", "Value"]}
                    rows={[
                      ["Total returns (orders)", String(snapshot.returns.orders)],
                      ["Returned shipment count", String(snapshot.returns.shipments)],
                      ["Return rate", rateText(snapshot.returns.rate)],
                      ["COD returns", String(snapshot.returns.cod)],
                      ["Speed Post returns", String(snapshot.returns.speedPost)],
                      ["Business Parcel returns", String(snapshot.returns.businessParcel)],
                    ]}
                  />
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Destination pincodes
                  </Text>
                  <Text as="p" tone="subdued">
                    City and state are not stored separately. Customer names are not included.
                  </Text>
                  <DataTable
                    columnContentTypes={["text", "numeric"]}
                    headings={["Pincode", "Shipments"]}
                    rows={snapshot.pincodes.map((row) => [row.pincode, row.shipments])}
                  />
                </BlockStack>
              </Card>
              <Layout>
                <Layout.Section>
                  <Card>
                    <BlockStack gap="300">
                      <Text as="h2" variant="headingMd">
                        Shopify order status
                      </Text>
                      <DataTable columnContentTypes={["text", "numeric"]} headings={["Status", "Count"]} rows={statusRows(snapshot.status.shopifyOrder)} />
                    </BlockStack>
                  </Card>
                </Layout.Section>
                <Layout.Section>
                  <Card>
                    <BlockStack gap="300">
                      <Text as="h2" variant="headingMd">
                        Shopify fulfillment status
                      </Text>
                      <DataTable columnContentTypes={["text", "numeric"]} headings={["Status", "Count"]} rows={statusRows(snapshot.status.shopifyFulfillment)} />
                    </BlockStack>
                  </Card>
                </Layout.Section>
              </Layout>
              <Layout>
                <Layout.Section>
                  <Card>
                    <BlockStack gap="300">
                      <Text as="h2" variant="headingMd">
                        InPost shipment status
                      </Text>
                      <DataTable columnContentTypes={["text", "numeric"]} headings={["Status", "Count"]} rows={statusRows(snapshot.status.inpost)} />
                    </BlockStack>
                  </Card>
                </Layout.Section>
                <Layout.Section>
                  <Card>
                    <BlockStack gap="300">
                      <Text as="h2" variant="headingMd">
                        India Post tracking status
                      </Text>
                      <DataTable columnContentTypes={["text", "numeric"]} headings={["Status", "Count"]} rows={statusRows(snapshot.status.tracking)} />
                      {snapshot.delivery.successRate != null ? (
                        <Tooltip content="Delivered ÷ (delivered + NDR + RTO)">
                          <ProgressBar progress={Math.round(snapshot.delivery.successRate * 100)} size="small" />
                        </Tooltip>
                      ) : null}
                    </BlockStack>
                  </Card>
                </Layout.Section>
              </Layout>
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Recent activity
                  </Text>
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text"]}
                    headings={["Event", "Reference", "Date", "Status"]}
                    rows={snapshot.activity.map((row) => {
                      const when = formatCreated(row.at, zone);
                      return [row.event, row.reference, `${when.date} ${when.time}`.trim(), row.status];
                    })}
                  />
                </BlockStack>
              </Card>
            </>
          ) : (
            <SkeletonPage title="Analytics">
              <Card>
                <SkeletonBodyText lines={6} />
              </Card>
            </SkeletonPage>
          )}
        </BlockStack>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
