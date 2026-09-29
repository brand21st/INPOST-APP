import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Badge,
  BlockStack,
  Button,
  ButtonGroup,
  Card,
  Filters,
  IndexTable,
  InlineStack,
  Link,
  Page,
  Select,
  SkeletonBodyText,
  Text,
  TextField,
  useIndexResourceState,
} from "@shopify/polaris";
import { ExportIcon, RefreshIcon } from "@shopify/polaris-icons";
import { getSupabase } from "../db.server";
import {
  AdminEmptyState,
  AdminListFeedback,
  AdminPagination,
} from "../components/polaris/AdminList";
import { requireInstalledShop } from "../../domain/tenancy/request.server";
import { enqueueJob } from "../../domain/tenancy/shops.server";
import { getOrderSyncState, listOrders, setOrderService, setShopService, shopServiceChoice, type ListedOrder } from "../../domain/orders/list.server";
import { createShipment } from "../../domain/shipping/orders.server";
import { formatCreated, formatMoney, orderQueryFromParams, paymentLabel, type OrderListQuery } from "../../domain/orders/page";
import { isTrackable, trackingUnavailableCopy } from "../../domain/shipping/tracking.server";
import { logError } from "../../lib/logger.server";
import { drainShopOrderSync, drainShopShipping } from "../../workers/processor.server";
import type { AdminGraphql } from "../../shopify/admin-graphql";

function ordersHref(filters: OrderListQuery, page = 1) {
  const params = new URLSearchParams();
  if (filters.search) params.set("q", filters.search);
  if (filters.date && filters.date !== "all") params.set("date", filters.date);
  if (filters.date === "custom" && filters.from) params.set("from", filters.from);
  if (filters.date === "custom" && filters.to) params.set("to", filters.to);
  if (filters.status) params.set("status", filters.status);
  if (filters.payment) params.set("payment", filters.payment);
  if (filters.source) params.set("source", filters.source);
  if (page > 1) params.set("page", String(page));
  const search = params.toString();
  return search ? `/app/orders?${search}` : "/app/orders";
}

function exportHref(filters: OrderListQuery) {
  const query = ordersHref(filters).split("?")[1];
  return query ? `/app/orders/export?${query}` : "/app/orders/export";
}

function paymentOptionLabel(value: string) {
  if (value === "COD") return "COD";
  return paymentLabel(value, null);
}

function DateTab({ active, href, label }: { active: boolean; href: string; label: string }) {
  return (
    <Button url={href} variant={active ? "primary" : "secondary"}>
      {label}
    </Button>
  );
}

const emptyCounts = { all: 0, today: 0, yesterday: 0, custom: null as number | null };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireInstalledShop(request);
  const url = new URL(request.url);
  const filters = orderQueryFromParams(url.searchParams);
  const page = Number(url.searchParams.get("page") ?? "1");
  try {
    const service = await shopServiceChoice(shop.id);
    const result = await listOrders(shop.id, page, filters);
    const sync = await getOrderSyncState(shop.id);
    return { ...result, ...service, sync, filters, error: null as string | null };
  } catch (error) {
    logError("orders list failed", {
      shop_id: shop.id,
      event: "orders_list",
      result: "error",
      error: error instanceof Error ? error.message.slice(0, 200) : "error",
    });
    return {
      orders: [] as ListedOrder[],
      count: 0,
      page: 1,
      hasPrevious: false,
      hasNext: false,
      currency: null as string | null,
      timeZone: "UTC",
      payments: [] as string[],
      counts: emptyCounts,
      activeService: "SP_INLAND_PARCEL" as const,
      services: [] as Array<"SP_INLAND_PARCEL" | "BUSINESS_PARCEL">,
      canToggle: false,
      sync: null,
      filters,
      error: "Orders could not be loaded.",
    };
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop } = await requireInstalledShop(request);
  const form = await request.formData();
  if (form.get("intent") === "set_service") {
    try {
      await setShopService(shop.id, String(form.get("service") ?? ""));
      return { intent: "set_service" as const, ok: true as const, queued: false, drained: 0 };
    } catch (error) {
      logError("order service switch failed", {
        shop_id: shop.id,
        event: "service_switch",
        result: "error",
        error: error instanceof Error ? error.message.slice(0, 200) : "error",
      });
      return {
        intent: "set_service" as const,
        ok: false as const,
        error: "Service could not be changed.",
        queued: false,
        drained: 0,
      };
    }
  }
  if (form.get("intent") === "set_order_service") {
    try {
      await setOrderService(shop.id, String(form.get("order_id") ?? ""), String(form.get("service") ?? ""));
      return { intent: "set_order_service" as const, ok: true as const, queued: false, drained: 0 };
    } catch (error) {
      logError("order row service switch failed", {
        shop_id: shop.id,
        event: "order_service_switch",
        result: "error",
        error: error instanceof Error ? error.message.slice(0, 200) : "error",
      });
      return {
        intent: "set_order_service" as const,
        ok: false as const,
        error: "Service could not be changed.",
        queued: false,
        drained: 0,
      };
    }
  }
  if (form.get("intent") === "ship_orders") {
    try {
      const ids = form.getAll("order_id").map(String).filter(Boolean);
      const { data: settings } = await getSupabase()
        .from("shop_settings")
        .select("default_service, default_parcel_grams")
        .eq("shop_id", shop.id)
        .maybeSingle();
      const grams = Number((settings as { default_parcel_grams?: number } | null)?.default_parcel_grams ?? 500);
      const fallback = (settings as { default_service?: string } | null)?.default_service ?? "SP_INLAND_PARCEL";
      for (const orderId of ids) {
        const { data: order } = await getSupabase()
          .from("orders")
          .select("id, status")
          .eq("shop_id", shop.id)
          .eq("id", orderId)
          .maybeSingle();
        if (!order || order.status === "CANCELLED") continue;
        const { data: existing } = await getSupabase()
          .from("shipments")
          .select("service_code")
          .eq("shop_id", shop.id)
          .eq("order_id", orderId)
          .neq("status", "CANCELLED")
          .maybeSingle();
        const service = String((existing as { service_code?: string } | null)?.service_code ?? fallback);
        await createShipment(shop.id, orderId, service, grams, true);
      }
      const drained = await drainShopShipping(shop.id, async () => admin as AdminGraphql);
      return { intent: "ship_orders" as const, ok: true as const, queued: true, drained };
    } catch (error) {
      logError("order ship failed", {
        shop_id: shop.id,
        event: "order_ship",
        result: "error",
        error: error instanceof Error ? error.message.slice(0, 200) : "error",
      });
      return { intent: "ship_orders" as const, ok: false as const, error: "Shipment could not be created.", queued: false, drained: 0 };
    }
  }
  const queued = await enqueueJob(shop.id, "order-sync", null, {});
  const drained = await drainShopOrderSync(shop.id, async () => admin as AdminGraphql);
  return { intent: "sync" as const, ok: true as const, queued, drained };
};

export default function OrdersIndex() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const loading = navigation.state !== "idle";
  const filters = data.filters;
  const orders = data.orders as ListedOrder[];
  const sync = data.sync as { status: string } | null;
  const {
    selectedResources,
    allResourcesSelected,
    handleSelectionChange,
  } = useIndexResourceState(orders);
  const visibleIds = orders.map((order) => order.id);
  const chosen = selectedResources.filter((id) => visibleIds.includes(id));
  const filtered =
    Boolean(filters.search) ||
    filters.date === "today" ||
    filters.date === "yesterday" ||
    filters.date === "custom" ||
    Boolean(filters.status) ||
    Boolean(filters.payment) ||
    Boolean(filters.source);
  const paymentOptions = [...data.payments].sort((left, right) => paymentOptionLabel(left).localeCompare(paymentOptionLabel(right)));
  const [queryValue, setQueryValue] = useState(filters.search ?? "");
  const [statusValue, setStatusValue] = useState(filters.status ?? "");
  const [sourceValue, setSourceValue] = useState(filters.source ?? "");
  const [paymentValue, setPaymentValue] = useState(filters.payment ?? "");
  const [fromValue, setFromValue] = useState(filters.from ?? "");
  const [toValue, setToValue] = useState(filters.to ?? "");

  useEffect(() => {
    setQueryValue(filters.search ?? "");
    setStatusValue(filters.status ?? "");
    setSourceValue(filters.source ?? "");
    setPaymentValue(filters.payment ?? "");
    setFromValue(filters.from ?? "");
    setToValue(filters.to ?? "");
  }, [
    filters.search,
    filters.status,
    filters.source,
    filters.payment,
    filters.from,
    filters.to,
  ]);

  let success: string | null = null;
  let actionError: string | null = null;
  if (actionData) {
    if (!actionData.ok) {
      actionError = "error" in actionData ? actionData.error : "The action could not be completed.";
    } else if (actionData.intent === "ship_orders") {
      success = "Shipment queued.";
    } else if (actionData.intent === "sync") {
      success =
        actionData.drained > 0
          ? "Orders synced."
          : actionData.queued
            ? "Sync started."
            : "Sync already running.";
    } else if (actionData.intent === "set_service") {
      success = "Service updated.";
    } else if (actionData.intent === "set_order_service") {
      success = "Order service updated.";
    }
  }

  useEffect(() => {
    if (!success) return;
    const toast = (window as unknown as { shopify?: { toast?: { show: (message: string) => void } } }).shopify?.toast;
    toast?.show(success);
  }, [success]);

  const appliedFilters = [
    statusValue
      ? { key: "status", label: `Status: ${statusValue}`, onRemove: () => setStatusValue("") }
      : null,
    sourceValue
      ? { key: "source", label: "Source: Shopify", onRemove: () => setSourceValue("") }
      : null,
    paymentValue
      ? {
          key: "payment",
          label: `Payment: ${paymentOptionLabel(paymentValue)}`,
          onRemove: () => setPaymentValue(""),
        }
      : null,
  ].filter((value): value is NonNullable<typeof value> => value !== null);

  return (
    <Page title="Orders" subtitle="Synced Shopify orders for this shop.">
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="400">
            <InlineStack gap="300" align="space-between" blockAlign="center">
              <ButtonGroup>
                <Form method="post">
                  <Button submit loading={loading} icon={RefreshIcon}>
                    Sync Shopify
                  </Button>
                </Form>
                <Button url={exportHref(filters)} icon={ExportIcon}>
                  Export
                </Button>
                <Form method="post">
                  <input type="hidden" name="intent" value="ship_orders" />
                  {chosen.map((id) => (
                    <input key={id} type="hidden" name="order_id" value={id} />
                  ))}
                  <Button submit variant="primary" disabled={chosen.length === 0}>
                    Ship selected
                  </Button>
                </Form>
              </ButtonGroup>
              {data.canToggle ? (
                <ButtonGroup>
                  <Form method="post">
                    <input type="hidden" name="intent" value="set_service" />
                    <input type="hidden" name="service" value="SP_INLAND_PARCEL" />
                    <Button submit disabled={data.activeService === "SP_INLAND_PARCEL"}>
                      SP
                    </Button>
                  </Form>
                  <Form method="post">
                    <input type="hidden" name="intent" value="set_service" />
                    <input type="hidden" name="service" value="BUSINESS_PARCEL" />
                    <Button submit disabled={data.activeService === "BUSINESS_PARCEL"}>
                      BP
                    </Button>
                  </Form>
                </ButtonGroup>
              ) : null}
            </InlineStack>
            <AdminListFeedback
              loading={sync?.status === "RUNNING"}
              error={data.error ?? actionError}
              success={success}
            />
            <ButtonGroup>
              <DateTab
                active={!filters.date || filters.date === "all"}
                href={ordersHref({ ...filters, date: "all", from: "", to: "" })}
                label={`All Orders (${data.counts.all})`}
              />
              <DateTab
                active={filters.date === "today"}
                href={ordersHref({ ...filters, date: "today", from: "", to: "" })}
                label={`Today (${data.counts.today})`}
              />
              <DateTab
                active={filters.date === "yesterday"}
                href={ordersHref({ ...filters, date: "yesterday", from: "", to: "" })}
                label={`Yesterday (${data.counts.yesterday})`}
              />
              <DateTab
                active={filters.date === "custom"}
                href={ordersHref({ ...filters, date: "custom" })}
                label={`Custom Date${data.counts.custom == null ? "" : ` (${data.counts.custom})`}`}
              />
            </ButtonGroup>
            <Form method="get">
              <BlockStack gap="300">
                <input type="hidden" name="date" value={filters.date ?? "all"} />
                <Filters
                  queryValue={queryValue}
                  queryPlaceholder="Search order number, customer, phone..."
                  onQueryChange={setQueryValue}
                  onQueryClear={() => setQueryValue("")}
                  filters={[
                    {
                      key: "status",
                      label: "Status",
                      filter: (
                        <Select
                          label="Status"
                          options={[
                            { label: "All statuses", value: "" },
                            { label: "Ready", value: "READY" },
                            { label: "Cancelled", value: "CANCELLED" },
                          ]}
                          value={statusValue}
                          onChange={setStatusValue}
                        />
                      ),
                    },
                    {
                      key: "source",
                      label: "Source",
                      filter: (
                        <Select
                          label="Source"
                          options={[
                            { label: "All sources", value: "" },
                            { label: "Shopify", value: "shopify" },
                          ]}
                          value={sourceValue}
                          onChange={setSourceValue}
                        />
                      ),
                    },
                    {
                      key: "payment",
                      label: "Payment",
                      filter: (
                        <Select
                          label="Payment"
                          options={[
                            { label: "All payments", value: "" },
                            ...paymentOptions.map((value) => ({
                              label: paymentOptionLabel(value),
                              value,
                            })),
                          ]}
                          value={paymentValue}
                          onChange={setPaymentValue}
                        />
                      ),
                    },
                  ]}
                  appliedFilters={appliedFilters}
                  onClearAll={() => {
                    setStatusValue("");
                    setSourceValue("");
                    setPaymentValue("");
                  }}
                />
                <input type="hidden" name="q" value={queryValue} />
                <input type="hidden" name="status" value={statusValue} />
                <input type="hidden" name="source" value={sourceValue} />
                <input type="hidden" name="payment" value={paymentValue} />
                {filters.date === "custom" ? (
                  <InlineStack gap="300">
                    <TextField
                      label="From"
                      type="date"
                      name="from"
                      value={fromValue}
                      onChange={setFromValue}
                      autoComplete="off"
                    />
                    <TextField
                      label="To"
                      type="date"
                      name="to"
                      value={toValue}
                      onChange={setToValue}
                      autoComplete="off"
                    />
                  </InlineStack>
                ) : null}
                <InlineStack align="end">
                  <Button submit variant="primary">Apply filters</Button>
                </InlineStack>
              </BlockStack>
            </Form>
          </BlockStack>
        </Card>
        {loading ? (
          <Card>
            <SkeletonBodyText lines={6} />
          </Card>
        ) : null}
        {!data.error && !loading && orders.length === 0 ? (
          <AdminEmptyState
            heading={filtered ? "No matching orders" : "No orders found"}
            description={
              filtered
                ? "No orders match your current search and filters."
                : "Sync Shopify to load orders for this shop."
            }
          />
        ) : null}
        {orders.length > 0 ? (
          <Card padding="0">
            <IndexTable
              resourceName={{ singular: "order", plural: "orders" }}
              itemCount={orders.length}
              selectedItemsCount={allResourcesSelected ? "All" : chosen.length}
              onSelectionChange={handleSelectionChange}
              headings={[
                { title: "Order" },
                { title: "Customer" },
                { title: "Items" },
                { title: "Source" },
                { title: "Status" },
                { title: "Payment" },
                { title: "Total", alignment: "end" },
                { title: "Created" },
                { title: "Service" },
                { title: "Actions" },
              ]}
            >
              {orders.map((order, index) => {
                const created = formatCreated(order.createdAt, data.timeZone);
                return (
                  <IndexTable.Row
                    id={order.id}
                    key={order.id}
                    selected={chosen.includes(order.id)}
                    position={index}
                  >
                    <IndexTable.Cell>
                      <Link url={`/app/orders/${order.id}`} removeUnderline>
                        <Text as="span" fontWeight="semibold">{order.orderName}</Text>
                      </Link>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{order.customer}</IndexTable.Cell>
                    <IndexTable.Cell>{order.itemCount}</IndexTable.Cell>
                    <IndexTable.Cell>Shopify</IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={order.status === "CANCELLED" ? "critical" : "success"}>
                        {order.status === "CANCELLED" ? "Cancelled" : "Ready"}
                      </Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{order.payment}</IndexTable.Cell>
                    <IndexTable.Cell>{formatMoney(order.totalAmount, data.currency)}</IndexTable.Cell>
                    <IndexTable.Cell>
                      {created.date}
                      {created.time ? ` ${created.time}` : ""}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {data.canToggle && !order.serviceLocked && order.status !== "CANCELLED" ? (
                        <ButtonGroup>
                          <Form method="post">
                            <input type="hidden" name="intent" value="set_order_service" />
                            <input type="hidden" name="order_id" value={order.id} />
                            <input type="hidden" name="service" value="SP_INLAND_PARCEL" />
                            <Button submit size="slim" disabled={order.service === "SP"}>SP</Button>
                          </Form>
                          <Form method="post">
                            <input type="hidden" name="intent" value="set_order_service" />
                            <input type="hidden" name="order_id" value={order.id} />
                            <input type="hidden" name="service" value="BUSINESS_PARCEL" />
                            <Button submit size="slim" disabled={order.service === "BP"}>BP</Button>
                          </Form>
                        </ButtonGroup>
                      ) : (
                        order.service ?? "—"
                      )}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="200" wrap>
                        {order.status !== "CANCELLED" ? (
                          <Form method="post">
                            <input type="hidden" name="intent" value="ship_orders" />
                            <input type="hidden" name="order_id" value={order.id} />
                            <Button submit size="slim">Create shipment</Button>
                          </Form>
                        ) : (
                          <Button size="slim" disabled>Create shipment</Button>
                        )}
                        <Button size="slim" disabled>Print label</Button>
                        {order.shipmentId ? (
                          <Button url={`/app/shipments/${order.shipmentId}`} size="slim">
                            View shipment
                          </Button>
                        ) : (
                          <Button size="slim" disabled>View shipment</Button>
                        )}
                        {isTrackable(order.trackingNumber, order.labelStatus) ? (
                          <Button
                            url={`/app/tracking?q=${encodeURIComponent(order.trackingNumber ?? "")}`}
                            size="slim"
                          >
                            Track
                          </Button>
                        ) : (
                          <Text as="span" tone="subdued">
                            {trackingUnavailableCopy(order.trackingNumber)}
                          </Text>
                        )}
                      </InlineStack>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                );
              })}
            </IndexTable>
          </Card>
        ) : null}
        <InlineStack align="center">
          <AdminPagination
            previousUrl={
              data.hasPrevious ? ordersHref(filters, data.page - 1) : undefined
            }
            nextUrl={data.hasNext ? ordersHref(filters, data.page + 1) : undefined}
          />
        </InlineStack>
      </BlockStack>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
