import { getSupabase, requireShopId } from "../../app/db.server";
import {
  customBounds,
  dayBounds,
  formatCreated,
  formatMoney,
  paymentLabel,
  searchTerm,
  serviceMark,
  type DateBounds,
  type OrderListQuery,
} from "./page";
import { pageWindow } from "./page";

const ORDER_LIST_COLUMNS =
  "id, order_name, shipping_name, phone, shopify_created_at, financial_status, fulfillment_status, total_amount, payment_mode, cod_amount, status";

export type { OrderListQuery } from "./page";

export type ListedOrder = {
  id: string;
  orderName: string;
  customer: string;
  phone: string;
  itemCount: number;
  status: string;
  financialStatus: string | null;
  paymentMode: string | null;
  payment: string;
  totalAmount: number | null;
  createdAt: string | null;
  service: "SP" | "BP" | null;
  shipmentId: string | null;
  serviceLocked: boolean;
  trackingNumber: string | null;
  labelStatus: string | null;
};

type OrderRow = {
  id: string;
  order_name: string | null;
  shipping_name: string | null;
  phone: string | null;
  shopify_created_at: string | null;
  financial_status: string | null;
  total_amount: number | null;
  payment_mode: string | null;
  status: string | null;
};

type FilterQuery = {
  eq: (column: string, value: string) => FilterQuery;
  or: (filters: string) => FilterQuery;
  gte: (column: string, value: string) => FilterQuery;
  lt: (column: string, value: string) => FilterQuery;
};

function boundsFor(filters: OrderListQuery, timeZone: string): DateBounds | null {
  if (filters.date === "today" || filters.date === "yesterday") return dayBounds(timeZone, filters.date);
  if (filters.date === "custom" && filters.from && filters.to) return customBounds(timeZone, filters.from, filters.to);
  return null;
}

function applyOrderFilters<T extends FilterQuery>(query: T, shopId: string, filters: OrderListQuery, bounds: DateBounds | null) {
  let next = query.eq("shop_id", shopId);
  if (filters.status === "READY" || filters.status === "CANCELLED") next = next.eq("status", filters.status);
  if (filters.payment === "COD") next = next.eq("payment_mode", "COD");
  else if (filters.payment) next = next.eq("financial_status", filters.payment);
  const term = searchTerm(filters.search ?? "");
  if (term) {
    const pattern = `"%${term}%"`;
    next = next.or(`order_name.ilike.${pattern},shipping_name.ilike.${pattern},phone.ilike.${pattern}`);
  }
  if (bounds) next = next.gte("shopify_created_at", bounds.start).lt("shopify_created_at", bounds.end);
  return next as T;
}

async function countOrders(shopId: string, filters: OrderListQuery, bounds: DateBounds | null) {
  const query = applyOrderFilters(
    getSupabase().from("orders").select("id", { count: "exact", head: true }) as unknown as FilterQuery,
    shopId,
    filters,
    bounds,
  );
  const { count, error } = await (query as unknown as PromiseLike<{ count: number | null; error: { message: string } | null }>);
  if (error) throw new Error("Orders could not be loaded");
  return count ?? 0;
}

const PAYMENT_STATUSES = ["PAID", "PENDING", "AUTHORIZED", "PARTIALLY_PAID", "PARTIALLY_REFUNDED", "REFUNDED", "VOIDED", "EXPIRED"];

async function paymentChoices(shopId: string) {
  const checks = await Promise.all([
    ...PAYMENT_STATUSES.map(async (status) => {
      const { count, error } = await getSupabase()
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("shop_id", shopId)
        .eq("financial_status", status);
      if (error) throw new Error("Orders could not be loaded");
      return count ? status : null;
    }),
    getSupabase()
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("shop_id", shopId)
      .eq("payment_mode", "COD")
      .then(({ count, error }) => {
        if (error) throw new Error("Orders could not be loaded");
        return count ? "COD" : null;
      }),
  ]);
  return checks.filter((value): value is string => Boolean(value));
}

export async function listOrders(
  shopId: string,
  page: number,
  searchOrFilters: string | OrderListQuery = "",
  options?: { includeMeta?: boolean },
) {
  requireShopId(shopId);
  const filters: OrderListQuery = typeof searchOrFilters === "string" ? { search: searchOrFilters } : searchOrFilters;
  const window = pageWindow(page);
  const shop = await getSupabase().from("shops").select("currency, timezone").eq("id", shopId).maybeSingle();
  if (shop.error) throw new Error("Orders could not be loaded");
  const timeZone = (shop.data?.timezone as string | null) || "UTC";
  const currency = (shop.data?.currency as string | null) ?? null;
  const bounds = boundsFor(filters, timeZone);
  const listed = applyOrderFilters(
    getSupabase().from("orders").select(ORDER_LIST_COLUMNS, { count: "exact" }) as unknown as FilterQuery,
    shopId,
    filters,
    bounds,
  );
  const { data, error, count } = await (
    listed as unknown as {
      order: (column: string, options: { ascending: boolean }) => {
        range: (from: number, to: number) => Promise<{ data: OrderRow[] | null; error: { message: string } | null; count: number | null }>;
      };
    }
  )
    .order("shopify_created_at", { ascending: false })
    .range(window.from, window.to);
  if (error) throw new Error("Orders could not be loaded");
  const rows = data ?? [];
  const ids = rows.map((row) => row.id);
  const includeMeta = options?.includeMeta !== false;
  const [items, shipments, settings, payments, allCount, todayCount, yesterdayCount] = await Promise.all([
    ids.length
      ? getSupabase().from("order_line_items").select("order_id, quantity").eq("shop_id", shopId).in("order_id", ids)
      : Promise.resolve({ data: [], error: null }),
    ids.length
      ? getSupabase()
          .from("shipments")
          .select("id, order_id, service_code, status, submitted_s10, tracking_number")
          .eq("shop_id", shopId)
          .in("order_id", ids)
          .neq("status", "CANCELLED")
      : Promise.resolve({ data: [], error: null }),
    getSupabase().from("shop_settings").select("default_service").eq("shop_id", shopId).maybeSingle(),
    includeMeta ? paymentChoices(shopId) : Promise.resolve([] as string[]),
    includeMeta ? countOrders(shopId, filters, null) : Promise.resolve(0),
    includeMeta ? countOrders(shopId, filters, dayBounds(timeZone, "today")) : Promise.resolve(0),
    includeMeta ? countOrders(shopId, filters, dayBounds(timeZone, "yesterday")) : Promise.resolve(0),
  ]);
  if (items.error || shipments.error || settings.error) throw new Error("Orders could not be loaded");
  const quantities = new Map<string, number>();
  for (const item of items.data ?? []) {
    const orderId = String(item.order_id);
    quantities.set(orderId, (quantities.get(orderId) ?? 0) + Number(item.quantity ?? 0));
  }
  const shipmentByOrder = new Map<
    string,
    { id: string; service: "SP" | "BP" | null; locked: boolean; trackingNumber: string | null }
  >();
  for (const shipment of shipments.data ?? []) {
    const orderId = String(shipment.order_id);
    if (!shipmentByOrder.has(orderId)) {
      const status = String(shipment.status ?? "");
      shipmentByOrder.set(orderId, {
        id: String(shipment.id),
        service: serviceMark(String(shipment.service_code ?? "")),
        locked: Boolean(shipment.submitted_s10) || !["DRAFT", "QUEUED", "FAILED"].includes(status),
        trackingNumber: (shipment.tracking_number as string | null) ?? null,
      });
    }
  }
  const shipmentIds = [...shipmentByOrder.values()].map((row) => row.id);
  const labels = shipmentIds.length
    ? await getSupabase()
        .from("labels")
        .select("shipment_id, status")
        .eq("shop_id", shopId)
        .in("shipment_id", shipmentIds)
        .eq("kind", "INDIA_POST")
    : { data: [], error: null };
  if (labels.error) throw new Error("Orders could not be loaded");
  const labelByShipment = new Map((labels.data ?? []).map((row) => [String(row.shipment_id), String(row.status)]));
  const fallbackService = serviceMark((settings.data?.default_service as string | null) ?? null);
  const orders: ListedOrder[] = rows.map((row) => {
    const shipment = shipmentByOrder.get(row.id);
    return {
      id: row.id,
      orderName: row.order_name ?? "Order",
      customer: row.shipping_name ?? "—",
      phone: row.phone ?? "",
      itemCount: quantities.get(row.id) ?? 0,
      status: row.status ?? "READY",
      financialStatus: row.financial_status,
      paymentMode: row.payment_mode,
      payment: paymentLabel(row.financial_status, row.payment_mode),
      totalAmount: row.total_amount,
      createdAt: row.shopify_created_at,
      service: shipment?.service ?? fallbackService,
      shipmentId: shipment?.id ?? null,
      serviceLocked: shipment?.locked ?? false,
      trackingNumber: shipment?.trackingNumber ?? null,
      labelStatus: shipment ? (labelByShipment.get(shipment.id) ?? null) : null,
    };
  });
  const total = count ?? 0;
  return {
    orders,
    count: total,
    page: window.page,
    hasPrevious: window.page > 1,
    hasNext: total > window.to + 1,
    currency,
    timeZone,
    payments,
    counts: {
      all: allCount,
      today: todayCount,
      yesterday: yesterdayCount,
      custom: filters.date === "custom" ? (bounds ? total : null) : null,
    },
  };
}

function csvCell(value: string | number) {
  const text = String(value);
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

const SHOP_SERVICES = ["SP_INLAND_PARCEL", "BUSINESS_PARCEL"] as const;
export type ShopServiceCode = (typeof SHOP_SERVICES)[number];

function isShopService(value: string): value is ShopServiceCode {
  return value === "SP_INLAND_PARCEL" || value === "BUSINESS_PARCEL";
}

export async function shopServiceChoice(shopId: string) {
  requireShopId(shopId);
  const [contracts, settings] = await Promise.all([
    getSupabase().from("india_post_contracts").select("service_code, contract_id").eq("shop_id", shopId),
    getSupabase().from("shop_settings").select("default_service").eq("shop_id", shopId).maybeSingle(),
  ]);
  if (contracts.error || settings.error) throw new Error("Orders could not be loaded");
  const services = [
    ...new Set(
      (contracts.data ?? [])
        .filter((row) => row.contract_id && isShopService(String(row.service_code)))
        .map((row) => String(row.service_code) as ShopServiceCode),
    ),
  ];
  const stored = settings.data?.default_service === "BUSINESS_PARCEL" ? "BUSINESS_PARCEL" : "SP_INLAND_PARCEL";
  let active: ShopServiceCode = services.length === 1 ? services[0] : stored;
  if (services.length === 1 && stored !== services[0]) {
    const { error } = await getSupabase().from("shop_settings").update({ default_service: services[0] }).eq("shop_id", shopId);
    if (error) throw new Error("Orders could not be loaded");
    active = services[0];
  }
  return { activeService: active, services, canToggle: services.length === 2 };
}

export async function setShopService(shopId: string, serviceCode: string) {
  requireShopId(shopId);
  if (!isShopService(serviceCode)) throw new Error("Service is not available");
  await requireContract(shopId, serviceCode);
  const { error: settingsError } = await getSupabase()
    .from("shop_settings")
    .update({ default_service: serviceCode })
    .eq("shop_id", shopId);
  if (settingsError) throw new Error("Orders could not be loaded");
  const { error: shipmentError } = await getSupabase()
    .from("shipments")
    .update({ service_code: serviceCode })
    .eq("shop_id", shopId)
    .in("status", ["DRAFT", "QUEUED", "FAILED"])
    .is("submitted_s10", null);
  if (shipmentError) throw new Error("Orders could not be loaded");
}

async function requireContract(shopId: string, serviceCode: ShopServiceCode) {
  const { data: contract, error } = await getSupabase()
    .from("india_post_contracts")
    .select("contract_id")
    .eq("shop_id", shopId)
    .eq("service_code", serviceCode)
    .maybeSingle();
  if (error) throw new Error("Orders could not be loaded");
  if (!contract?.contract_id) throw new Error("Service is not available");
}

export async function setOrderService(shopId: string, orderId: string, serviceCode: string) {
  requireShopId(shopId);
  if (!orderId) throw new Error("Service is not available");
  if (!isShopService(serviceCode)) throw new Error("Service is not available");
  await requireContract(shopId, serviceCode);
  const { data: order, error: orderError } = await getSupabase()
    .from("orders")
    .select("id, status, payment_mode, cod_amount")
    .eq("shop_id", shopId)
    .eq("id", orderId)
    .maybeSingle();
  if (orderError) throw new Error("Orders could not be loaded");
  if (!order) throw new Error("Service is not available");
  if (order.status === "CANCELLED") throw new Error("Service is not available");
  const { data: shipment, error: shipmentError } = await getSupabase()
    .from("shipments")
    .select("id, status, submitted_s10")
    .eq("shop_id", shopId)
    .eq("order_id", orderId)
    .neq("status", "CANCELLED")
    .maybeSingle();
  if (shipmentError) throw new Error("Orders could not be loaded");
  if (shipment) {
    const status = String(shipment.status ?? "");
    if (shipment.submitted_s10 || !["DRAFT", "QUEUED", "FAILED"].includes(status)) {
      throw new Error("Service is not available");
    }
    const { error } = await getSupabase()
      .from("shipments")
      .update({ service_code: serviceCode })
      .eq("shop_id", shopId)
      .eq("id", shipment.id);
    if (error) throw new Error("Orders could not be loaded");
    return;
  }
  const { data: settings, error: settingsError } = await getSupabase()
    .from("shop_settings")
    .select("default_parcel_grams")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (settingsError) throw new Error("Orders could not be loaded");
  const { error: insertError } = await getSupabase().from("shipments").insert({
    shop_id: shopId,
    order_id: orderId,
    service_code: serviceCode,
    payment_mode: order.payment_mode === "COD" ? "COD" : "PREPAID",
    cod_amount: order.cod_amount ?? 0,
    weight_grams: Number(settings?.default_parcel_grams ?? 500),
    status: "DRAFT",
  });
  if (insertError) throw new Error("Orders could not be loaded");
}

export async function getOrderSyncState(shopId: string) {
  requireShopId(shopId);
  const { data, error } = await getSupabase()
    .from("order_sync_states")
    .select("status, processed_count, last_error, started_at, finished_at, updated_at")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw new Error("Orders could not be loaded");
  return data as {
    status: string;
    processed_count: number;
    last_error: string | null;
    started_at: string | null;
    finished_at: string | null;
    updated_at: string;
  } | null;
}

export async function exportOrdersCsv(shopId: string, filters: OrderListQuery) {
  requireShopId(shopId);
  const lines = [["Order", "Customer", "Phone", "Items", "Source", "Status", "Payment", "Total", "Created", "Service"].join(",")];
  let page = 1;
  for (;;) {
    const result = await listOrders(shopId, page, filters, { includeMeta: false });
    for (const order of result.orders) {
      const created = formatCreated(order.createdAt, result.timeZone);
      lines.push(
        [
          order.orderName,
          order.customer,
          order.phone,
          order.itemCount,
          "Shopify",
          order.status,
          order.payment,
          formatMoney(order.totalAmount, result.currency),
          `${created.date} ${created.time}`.trim(),
          order.service ?? "",
        ]
          .map(csvCell)
          .join(","),
      );
    }
    if (!result.hasNext || page >= 400) break;
    page += 1;
  }
  return `${lines.join("\n")}\n`;
}
