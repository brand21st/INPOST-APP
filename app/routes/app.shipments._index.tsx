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
  Text,
  TextField,
  useIndexResourceState,
} from "@shopify/polaris";
import { AdminEmptyState, AdminListFeedback, AdminPagination } from "../components/polaris/AdminList";
import { requireInstalledShop } from "../../domain/tenancy/request.server";
import { listShipments, queueShipmentBooking, shipmentQueryFromParams, type ListedShipment, type ShipmentListQuery } from "../../domain/shipping/list.server";
import { formatCreated } from "../../domain/orders/page";
import { isTrackable, trackingUnavailableCopy } from "../../domain/shipping/trackable";
import { logError } from "../../lib/logger.server";
import { drainShopShipping } from "../../workers/processor.server";
import type { AdminGraphql } from "../../shopify/admin-graphql";

function href(filters: ShipmentListQuery, page = 1) {
  const params = new URLSearchParams();
  if (filters.search) params.set("q", filters.search);
  if (filters.date && filters.date !== "all") params.set("date", filters.date);
  if (filters.date === "custom" && filters.from) params.set("from", filters.from);
  if (filters.date === "custom" && filters.to) params.set("to", filters.to);
  if (filters.status) params.set("status", filters.status);
  if (filters.service) params.set("service", filters.service);
  if (page > 1) params.set("page", String(page));
  const search = params.toString();
  return search ? `/app/shipments?${search}` : "/app/shipments";
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ").toLowerCase().replace(/^\w/, (letter) => letter.toUpperCase());
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireInstalledShop(request);
  const url = new URL(request.url);
  const filters = shipmentQueryFromParams(url.searchParams);
  const page = Number(url.searchParams.get("page") ?? "1");
  try {
    const result = await listShipments(shop.id, page, filters);
    return { ...result, filters, error: null as string | null };
  } catch (error) {
    logError("shipments list failed", {
      shop_id: shop.id,
      event: "shipments_list",
      result: "error",
      error: error instanceof Error ? error.message.slice(0, 200) : "error",
    });
    return {
      shipments: [] as ListedShipment[],
      count: 0,
      page: 1,
      hasPrevious: false,
      hasNext: false,
      timeZone: "UTC",
      filters,
      error: "Unable to load shipments. Try again.",
    };
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop } = await requireInstalledShop(request);
  const form = await request.formData();
  if (form.get("intent") === "retry_booking") {
    try {
      await queueShipmentBooking(shop.id, String(form.get("shipment_id") ?? ""));
      await drainShopShipping(shop.id, async () => admin as AdminGraphql);
      return { ok: true as const };
    } catch (error) {
      logError("shipment retry failed", {
        shop_id: shop.id,
        event: "shipment_retry",
        result: "error",
        error: error instanceof Error ? error.message.slice(0, 200) : "error",
      });
      return { ok: false as const, error: "Shipment could not be retried." };
    }
  }
  return { ok: false as const, error: "Action is not available." };
};

export default function ShipmentsIndex() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const loading = navigation.state !== "idle";
  const rows = data.shipments as ListedShipment[];
  const [query, setQuery] = useState(data.filters.search ?? "");
  const [status, setStatus] = useState(data.filters.status ?? "");
  const [service, setService] = useState(data.filters.service ?? "");
  const [from, setFrom] = useState(data.filters.from ?? "");
  const [to, setTo] = useState(data.filters.to ?? "");
  const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(rows);
  const filtered = Boolean(data.filters.search) || data.filters.date !== "all" || Boolean(data.filters.status) || Boolean(data.filters.service);

  useEffect(() => {
    if (actionData?.ok) {
      (window as unknown as { shopify?: { toast?: { show: (message: string) => void } } }).shopify?.toast?.show("Shipment retry queued.");
    }
  }, [actionData]);

  const filters = [
    {
      key: "status",
      label: "Shipment status",
      filter: (
        <Select
          label="Shipment status"
          labelHidden
          options={[
            { label: "All statuses", value: "" },
            ...["DRAFT", "QUEUED", "BOOKING", "BOOKED", "LABEL_READY", "IN_TRANSIT", "FAILED", "CANCELLED"].map((value) => ({
              label: statusLabel(value),
              value,
            })),
          ]}
          value={status}
          onChange={setStatus}
        />
      ),
      shortcut: true,
    },
    {
      key: "service",
      label: "Service",
      filter: (
        <Select
          label="Service"
          labelHidden
          options={[
            { label: "All services", value: "" },
            { label: "Speed Post", value: "SP_INLAND_PARCEL" },
            { label: "Business Parcel", value: "BUSINESS_PARCEL" },
          ]}
          value={service}
          onChange={setService}
        />
      ),
      shortcut: true,
    },
  ];
  const appliedFilters = [
    ...(status ? [{ key: "status", label: `Status: ${statusLabel(status)}`, onRemove: () => setStatus("") }] : []),
    ...(service ? [{ key: "service", label: `Service: ${service === "SP_INLAND_PARCEL" ? "Speed Post" : "Business Parcel"}`, onRemove: () => setService("") }] : []),
  ];

  return (
    <Page title="Shipments" fullWidth>
      <BlockStack gap="400">
        <Text as="p" tone="subdued">India Post shipments for this shop.</Text>
        <AdminListFeedback loading={loading} error={data.error ?? (actionData && !actionData.ok ? actionData.error : null)} />
        <Card>
          <BlockStack gap="400">
            <ButtonGroup>
              <Button url={href({ ...data.filters, date: "all" })} pressed={data.filters.date === "all"}>All</Button>
              <Button url={href({ ...data.filters, date: "today" })} pressed={data.filters.date === "today"}>Today</Button>
              <Button url={href({ ...data.filters, date: "yesterday" })} pressed={data.filters.date === "yesterday"}>Yesterday</Button>
              <Button url={href({ ...data.filters, date: "custom" })} pressed={data.filters.date === "custom"}>Custom date</Button>
            </ButtonGroup>
            <Form method="get">
              <input type="hidden" name="q" value={query} />
              <input type="hidden" name="date" value={data.filters.date ?? "all"} />
              <input type="hidden" name="status" value={status} />
              <input type="hidden" name="service" value={service} />
              <BlockStack gap="300">
                <Filters
                  queryValue={query}
                  queryPlaceholder="Search shipment, order, tracking, customer, pincode..."
                  filters={filters}
                  appliedFilters={appliedFilters}
                  onQueryChange={setQuery}
                  onQueryClear={() => setQuery("")}
                  onClearAll={() => window.location.assign("/app/shipments")}
                />
                {data.filters.date === "custom" ? (
                  <InlineStack gap="300" wrap>
                    <TextField label="From" type="date" value={from} onChange={setFrom} name="from" autoComplete="off" />
                    <TextField label="To" type="date" value={to} onChange={setTo} name="to" autoComplete="off" />
                  </InlineStack>
                ) : null}
                <InlineStack align="end"><Button submit variant="primary">Apply filters</Button></InlineStack>
              </BlockStack>
            </Form>
          </BlockStack>
        </Card>
        {!data.error && !loading && rows.length === 0 ? (
          <Card>
            <AdminEmptyState
              heading={filtered ? "No matching shipments" : "No shipments found"}
              description={filtered ? "Try changing or clearing your filters." : "Shipments will appear here after orders are booked."}
            />
          </Card>
        ) : null}
        {rows.length > 0 ? (
          <Card padding="0">
            <IndexTable
              resourceName={{ singular: "shipment", plural: "shipments" }}
              itemCount={rows.length}
              selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
              onSelectionChange={handleSelectionChange}
              loading={loading}
              headings={[
                { title: "Shipment" },
                { title: "Order" },
                { title: "Customer" },
                { title: "Service" },
                { title: "Tracking ID" },
                { title: "Status" },
                { title: "Destination" },
                { title: "Location" },
                { title: "Last synced" },
                { title: "Created" },
                { title: "Actions" },
              ]}
            >
              {rows.map((row, index) => {
                const created = formatCreated(row.createdAt, data.timeZone);
                const synced = formatCreated(row.lastTrackingSyncedAt, data.timeZone);
                const canRetry = row.status === "FAILED" || row.status === "QUEUED" || row.status === "DRAFT";
                return (
                  <IndexTable.Row id={row.id} key={row.id} position={index} selected={selectedResources.includes(row.id)}>
                    <IndexTable.Cell><Link url={`/app/shipments/${row.id}`} dataPrimaryLink>{row.id.slice(0, 8)}</Link></IndexTable.Cell>
                    <IndexTable.Cell><Link url={`/app/orders/${row.orderId}`}>{row.orderName}</Link></IndexTable.Cell>
                    <IndexTable.Cell>{row.customer}</IndexTable.Cell>
                    <IndexTable.Cell>{row.service ?? "—"}</IndexTable.Cell>
                    <IndexTable.Cell>{row.trackingNumber ?? "—"}</IndexTable.Cell>
                    <IndexTable.Cell><Badge tone={row.status === "FAILED" ? "critical" : row.status === "IN_TRANSIT" ? "attention" : row.status === "BOOKED" || row.status === "LABEL_READY" ? "success" : "info"}>{statusLabel(row.status)}</Badge></IndexTable.Cell>
                    <IndexTable.Cell>{row.pincode || row.destination}</IndexTable.Cell>
                    <IndexTable.Cell>{row.lastTrackingLocation ?? "—"}</IndexTable.Cell>
                    <IndexTable.Cell>{row.lastTrackingSyncedAt ? `${synced.date} ${synced.time}` : "—"}</IndexTable.Cell>
                    <IndexTable.Cell>{created.date} {created.time}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="200" blockAlign="center" wrap>
                        <Button url={`/app/shipments/${row.id}`} variant="plain">View</Button>
                        {isTrackable(row.trackingNumber, row.labelStatus) ? (
                          <Button url={`/app/tracking?q=${encodeURIComponent(row.trackingNumber ?? "")}`} variant="plain">Track</Button>
                        ) : <Text as="span" tone="subdued">{trackingUnavailableCopy(row.trackingNumber)}</Text>}
                        {row.labelId && row.labelStatus === "READY" ? <Button url={`/app/labels/${row.labelId}`} variant="plain">Download</Button> : null}
                        {canRetry ? (
                          <Form method="post">
                            <input type="hidden" name="intent" value="retry_booking" />
                            <input type="hidden" name="shipment_id" value={row.id} />
                            <Button submit variant="plain">Retry</Button>
                          </Form>
                        ) : null}
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
            previousUrl={data.hasPrevious ? href(data.filters, data.page - 1) : undefined}
            nextUrl={data.hasNext ? href(data.filters, data.page + 1) : undefined}
          />
        </InlineStack>
      </BlockStack>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
