import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { setSupabaseForTests } from "../../app/db.server.ts";
import { upsertOrderProjection } from "../shipping/orders.server.ts";
import { exportOrdersCsv, listOrders, setOrderService, setShopService, shopServiceChoice } from "./list.server.ts";
import {
  ORDER_PAGE_SIZE,
  cursorIfPageAccepted,
  customBounds,
  dayBounds,
  isShopifyThrottled,
  ordersForShop,
  pageCount,
  pageWindow,
  paymentLabel,
} from "./page.ts";
import { ORDERS_PAGE } from "../../shopify/graphql.ts";
import { processJob } from "../../workers/processor.server.ts";
import type { AdminGraphql } from "../../shopify/admin-graphql.ts";

type Row = Record<string, unknown>;

function memorySupabase() {
  const tables: Record<string, Row[]> = {
    shops: [],
    orders: [],
    order_line_items: [],
    order_sync_states: [],
    shipments: [],
    background_jobs: [],
    shop_settings: [],
    india_post_contracts: [],
  };
  let seq = 1;
  function from(table: string) {
    const filters: Array<{ col: string; op: "eq" | "in" | "ilike" | "neq" | "gte" | "lt" | "or" | "is"; value: unknown }> = [];
    let op: "select" | "update" | "insert" | "upsert" = "select";
    let payload: Row | null = null;
    let conflict: string | undefined;
    let rangeFrom = 0;
    let rangeTo = Number.POSITIVE_INFINITY;
    const rows = () => tables[table] ?? (tables[table] = []);
    const matched = () =>
      rows().filter((row) =>
        filters.every((filter) => {
          if (filter.op === "eq") return row[filter.col] === filter.value;
          if (filter.op === "neq") return row[filter.col] !== filter.value;
          if (filter.op === "in") return (filter.value as unknown[]).includes(row[filter.col]);
          if (filter.op === "gte") return String(row[filter.col] ?? "") >= String(filter.value);
          if (filter.op === "lt") return String(row[filter.col] ?? "") < String(filter.value);
          if (filter.op === "is") return filter.value == null ? row[filter.col] == null : row[filter.col] === filter.value;
          if (filter.op === "or") {
            return String(filter.value)
              .split(",")
              .some((clause) => {
                const match = clause.match(/^(\w+)\.ilike\."?%(.*)%"?$/);
                if (!match) return false;
                return String(row[match[1]] ?? "")
                  .toLowerCase()
                  .includes(match[2].toLowerCase());
              });
          }
          const pattern = String(filter.value).replace(/%/g, "").toLowerCase();
          return String(row[filter.col] ?? "")
            .toLowerCase()
            .includes(pattern);
        }),
      );
    const exec = () => {
      if (op === "insert" && payload) {
        const created = { id: `id-${seq++}`, ...payload };
        rows().push(created);
        return { data: created, error: null, count: null };
      }
      if (op === "upsert" && payload) {
        const keys = (conflict ?? "id").split(",");
        const index = rows().findIndex((row) => keys.every((key) => row[key] === payload?.[key]));
        if (index >= 0) {
          rows()[index] = { ...rows()[index], ...payload };
          return { data: rows()[index], error: null, count: null };
        }
        const created = { id: `id-${seq++}`, ...payload };
        rows().push(created);
        return { data: created, error: null, count: null };
      }
      if (op === "update" && payload) {
        for (const row of matched()) Object.assign(row, payload);
        return { data: matched(), error: null, count: null };
      }
      const found = matched().slice(rangeFrom, rangeTo + 1);
      return { data: found, error: null, count: matched().length };
    };
    const chain = {
      select() {
        return chain;
      },
      eq(col: string, value: unknown) {
        filters.push({ col, op: "eq", value });
        return chain;
      },
      neq(col: string, value: unknown) {
        filters.push({ col, op: "neq", value });
        return chain;
      },
      in(col: string, value: unknown[]) {
        filters.push({ col, op: "in", value });
        return chain;
      },
      ilike(col: string, value: unknown) {
        filters.push({ col, op: "ilike", value });
        return chain;
      },
      or(value: string) {
        filters.push({ col: "", op: "or", value });
        return chain;
      },
      gte(col: string, value: unknown) {
        filters.push({ col, op: "gte", value });
        return chain;
      },
      lt(col: string, value: unknown) {
        filters.push({ col, op: "lt", value });
        return chain;
      },
      is(col: string, value: unknown) {
        filters.push({ col, op: "is", value });
        return chain;
      },
      order() {
        return chain;
      },
      range(from: number, to: number) {
        rangeFrom = from;
        rangeTo = to;
        return chain;
      },
      insert(row: Row) {
        op = "insert";
        payload = row;
        return chain;
      },
      upsert(row: Row, options?: { onConflict?: string }) {
        op = "upsert";
        payload = row;
        conflict = options?.onConflict;
        return chain;
      },
      update(row: Row) {
        op = "update";
        payload = row;
        return chain;
      },
      maybeSingle() {
        const result = exec();
        const data = Array.isArray(result.data) ? (result.data[0] ?? null) : result.data;
        return Promise.resolve({ data, error: null });
      },
      single() {
        const result = exec();
        const data = Array.isArray(result.data) ? result.data[0] : result.data;
        return Promise.resolve({ data, error: data ? null : { message: "not found" } });
      },
      then(resolve: (value: { data: unknown; error: null; count: number | null }) => unknown) {
        return Promise.resolve(exec()).then(resolve);
      },
    };
    return chain;
  }
  return { from, tables };
}

function orderNode(id: string, name: string) {
  return {
    id,
    name,
    createdAt: "2026-01-02T00:00:00Z",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    paymentGatewayNames: ["Cash on Delivery (COD)"],
    currentTotalPriceSet: { shopMoney: { amount: "10.00" } },
    totalOutstandingSet: { shopMoney: { amount: "0.00" } },
    shippingAddress: { name: "Asha", address1: "1 Road", city: "Pune", zip: "411001", phone: "9999999999" },
    cancelledAt: null,
    lineItems: {
      nodes: [
        {
          id: `gid://shopify/LineItem/${id}`,
          title: name,
          sku: "SKU",
          quantity: 1,
          originalUnitPriceSet: { shopMoney: { amount: "10.00" } },
        },
      ],
    },
  };
}

test("a second receipt of the same Shopify order updates one row", async () => {
  const db = memorySupabase();
  setSupabaseForTests(db as unknown as SupabaseClient);
  try {
    const input = {
      shopifyOrderGid: "gid://shopify/Order/1",
      orderName: "#1001",
      shopifyCreatedAt: "2026-01-02T00:00:00Z",
      financialStatus: "pending",
      fulfillmentStatus: null,
      gatewayNames: ["Cash on Delivery (COD)"],
      orderTotal: 500,
      amountOutstanding: 500,
      shippingName: "Asha",
      shippingAddress: "1 Road",
      phone: null,
      pincode: "411001",
      cancelledAt: null,
      lines: [
        {
          gid: "gid://shopify/LineItem/1",
          title: "Lamp",
          sku: "L",
          quantity: 1,
          grams: 200,
          unitPrice: 500,
        },
      ],
    };
    await upsertOrderProjection("shop-a", input);
    await upsertOrderProjection("shop-a", { ...input, orderName: "#1001-updated", lines: [{ ...input.lines[0], title: "Lamp updated", unitPrice: 450 }] });
    assert.equal(db.tables.orders.length, 1);
    assert.equal(db.tables.orders[0].order_name, "#1001-updated");
    assert.equal(db.tables.orders[0].shopify_created_at, "2026-01-02T00:00:00Z");
    assert.equal(db.tables.orders[0].payment_mode, "COD");
    assert.equal(db.tables.order_line_items.length, 1);
    assert.equal(db.tables.order_line_items[0].title, "Lamp updated");
    assert.equal(db.tables.order_line_items[0].unit_price, 450);
    assert.equal(db.tables.order_line_items[0].grams, 200);
  } finally {
    setSupabaseForTests(undefined);
  }
});

test("a throttled page stays on the same cursor and a later page completes the sync", async () => {
  const db = memorySupabase();
  setSupabaseForTests(db as unknown as SupabaseClient);
  const shopId = "shop-a";
  db.tables.shops.push({ id: shopId, status: "INSTALLED", shop_domain: "a.myshopify.com" });
  db.tables.shop_settings.push({ shop_id: shopId, auto_book: true, default_service: "SP", default_parcel_grams: 500 });
  db.tables.background_jobs.push({
    id: "job-1",
    shop_id: shopId,
    type: "order-sync",
    status: "RUNNING",
    payload: { cursor: "cursor-1" },
    attempts: 1,
  });
  const pages = [
    { errors: [{ extensions: { code: "THROTTLED" } }] },
    {
      data: {
        orders: {
          pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
          nodes: [orderNode("gid://shopify/Order/1", "#1001")],
        },
      },
    },
    {
      data: {
        orders: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [orderNode("gid://shopify/Order/2", "#1002")],
        },
      },
    },
  ];
  let call = 0;
  const admin = (): AdminGraphql => ({
    graphql: async (_query, options) => {
      const body = pages[call++] ?? pages[pages.length - 1];
      return Response.json({ ...body, variables: options?.variables });
    },
  });
  try {
    assert.equal(cursorIfPageAccepted(pages[0]), null);
    assert.equal(isShopifyThrottled(pages[0]), true);
    await processJob(
      {
        id: "job-1",
        shop_id: shopId,
        type: "order-sync",
        entity_id: null,
        payload: { cursor: "cursor-1" },
        attempts: 1,
      },
      async () => admin(),
    );
    assert.equal(db.tables.orders.length, 0);
    assert.equal(db.tables.background_jobs.length, 1);
    assert.equal(db.tables.background_jobs[0].status, "QUEUED");
    assert.deepEqual(db.tables.background_jobs[0].payload, { cursor: "cursor-1" });
    assert.equal(db.tables.order_sync_states[0].status, "RUNNING");

    await processJob(
      {
        id: "job-1",
        shop_id: shopId,
        type: "order-sync",
        entity_id: null,
        payload: { cursor: "cursor-1" },
        attempts: 1,
      },
      async () => admin(),
    );
    assert.equal(db.tables.orders.length, 1);
    assert.equal(db.tables.order_sync_states[0].cursor, "cursor-2");
    assert.equal(db.tables.order_sync_states[0].status, "RUNNING");
    const next = db.tables.background_jobs.find((job) => job.id !== "job-1");
    assert.ok(next);
    assert.deepEqual(next?.payload, { cursor: "cursor-2" });

    await processJob(
      {
        id: String(next?.id),
        shop_id: shopId,
        type: "order-sync",
        entity_id: null,
        payload: { cursor: "cursor-2" },
        attempts: 1,
      },
      async () => admin(),
    );
    assert.equal(db.tables.orders.length, 2);
    assert.equal(db.tables.order_sync_states[0].status, "COMPLETED");
    assert.equal(db.tables.order_sync_states[0].cursor, null);
    assert.equal(db.tables.background_jobs.filter((job) => job.type === "order-sync").length, 2);
    assert.equal(db.tables.shipments.length, 0);
    assert.equal(db.tables.orders[0].shopify_created_at, "2026-01-02T00:00:00Z");
    assert.equal(db.tables.order_line_items[0].unit_price, 10);
  } finally {
    setSupabaseForTests(undefined);
  }
});

test("list results stay on the session shop, including an empty page", async () => {
  const db = memorySupabase();
  setSupabaseForTests(db as unknown as SupabaseClient);
  try {
    db.tables.orders.push(
      { id: "order-a", shop_id: "shop-a", order_name: "#1001", shopify_created_at: "2026-01-02T00:00:00Z" },
      { id: "order-b", shop_id: "shop-b", order_name: "#1001", shopify_created_at: "2026-01-03T00:00:00Z" },
    );
    assert.equal(ordersForShop("shop-a", "shop-b"), "shop-a");
    const page = await listOrders("shop-a", 1, "");
    assert.equal(page.orders.length, 1);
    assert.equal((page.orders[0] as { id: string }).id, "order-a");
    const empty = await listOrders("shop-c", 1, "");
    assert.deepEqual(empty.orders, []);
    assert.equal(empty.count, 0);
    assert.equal(pageWindow(1).from, 0);
    assert.equal(db.tables.background_jobs.length, 0);
  } finally {
    setSupabaseForTests(undefined);
  }
});

test("a large order set is split into pages of 25", () => {
  assert.equal(ORDER_PAGE_SIZE, 25);
  assert.match(ORDERS_PAGE, /first: 25/);
  assert.match(ORDERS_PAGE, /createdAt/);
  assert.match(ORDERS_PAGE, /cancelledAt/);
  assert.match(ORDERS_PAGE, /originalUnitPriceSet/);
  assert.doesNotMatch(ORDERS_PAGE, /unfulfilled/);
  const total = 60;
  const pages: number[][] = [];
  const ids = Array.from({ length: total }, (_, index) => index + 1);
  for (let index = 0; index < ids.length; index += ORDER_PAGE_SIZE) {
    pages.push(ids.slice(index, index + ORDER_PAGE_SIZE));
  }
  assert.equal(pages.length, pageCount(total));
  assert.equal(pages.length, 3);
  assert.ok(pages.every((page) => page.length <= ORDER_PAGE_SIZE));
  assert.equal(pages[0].length, 25);
  assert.equal(pages[2].length, 10);
  assert.equal(
    isShopifyThrottled({
      extensions: { cost: { requestedQueryCost: 80, throttleStatus: { currentlyAvailable: 10 } } },
    }),
    true,
  );
});

test("today and yesterday follow the shop timezone", () => {
  const now = new Date("2026-09-28T18:04:00.000Z");
  const today = dayBounds("Asia/Kolkata", "today", now);
  assert.equal(today.start, "2026-09-27T18:30:00.000Z");
  assert.equal(today.end, "2026-09-28T18:30:00.000Z");
  const yesterday = dayBounds("Asia/Kolkata", "yesterday", now);
  assert.equal(yesterday.start, "2026-09-26T18:30:00.000Z");
  assert.equal(yesterday.end, "2026-09-27T18:30:00.000Z");
  const custom = customBounds("Asia/Kolkata", "2026-09-28", "2026-09-28");
  assert.equal(custom?.start, today.start);
  assert.equal(custom?.end, today.end);
  assert.equal(customBounds("Asia/Kolkata", "2026-09-29", "2026-09-28"), null);
});

test("payment labels use the stored status and COD mode", () => {
  assert.equal(paymentLabel("PAID", "PREPAID"), "Paid");
  assert.equal(paymentLabel("PENDING", "COD"), "COD");
  assert.equal(paymentLabel("PARTIALLY_PAID", "PREPAID"), "Partially paid");
  assert.equal(paymentLabel("PENDING", "PREPAID"), "Pending");
  assert.equal(paymentLabel("AUTHORIZED", null), "Pending");
});

test("search, date, and payment filters stay on the session shop", async () => {
  const db = memorySupabase();
  setSupabaseForTests(db as unknown as SupabaseClient);
  try {
    db.tables.shops.push({ id: "shop-a", currency: "INR", timezone: "Asia/Kolkata" });
    db.tables.shop_settings.push({ shop_id: "shop-a", default_service: "SP_INLAND_PARCEL" });
    db.tables.orders.push(
      {
        id: "o1",
        shop_id: "shop-a",
        order_name: "#1001",
        shipping_name: "Asha",
        phone: "9991112222",
        shopify_created_at: "2026-09-28T18:04:00.000Z",
        financial_status: "PAID",
        payment_mode: "PREPAID",
        total_amount: 120,
        status: "READY",
      },
      {
        id: "o2",
        shop_id: "shop-a",
        order_name: "#1002",
        shipping_name: "Ravi",
        phone: "8880001111",
        shopify_created_at: "2026-09-27T18:04:00.000Z",
        financial_status: "PENDING",
        payment_mode: "COD",
        total_amount: 80,
        status: "READY",
      },
      {
        id: "o3",
        shop_id: "shop-b",
        order_name: "#1001",
        shipping_name: "Asha",
        phone: "9991112222",
        shopify_created_at: "2026-09-28T18:04:00.000Z",
        financial_status: "PAID",
        payment_mode: "PREPAID",
        status: "READY",
      },
    );
    db.tables.order_line_items.push(
      { order_id: "o1", shop_id: "shop-a", quantity: 2 },
      { order_id: "o1", shop_id: "shop-a", quantity: 1 },
    );
    db.tables.shipments.push({
      id: "ship-1",
      shop_id: "shop-a",
      order_id: "o2",
      service_code: "BUSINESS_PARCEL",
      status: "LABEL_READY",
    });

    const byName = await listOrders("shop-a", 1, { search: "Asha" });
    assert.equal(byName.orders.length, 1);
    assert.equal(byName.orders[0].id, "o1");
    assert.equal(byName.orders[0].itemCount, 3);
    assert.equal(byName.orders[0].service, "SP");
    assert.equal(byName.orders[0].payment, "Paid");

    const byPhone = await listOrders("shop-a", 1, { search: "8880001111" });
    assert.equal(byPhone.orders[0].id, "o2");
    assert.equal(byPhone.orders[0].payment, "COD");
    assert.equal(byPhone.orders[0].service, "BP");
    assert.equal(byPhone.orders[0].shipmentId, "ship-1");

    const custom = await listOrders("shop-a", 1, { date: "custom", from: "2026-09-28", to: "2026-09-28" });
    assert.equal(custom.orders.length, 1);
    assert.equal(custom.orders[0].id, "o1");
    assert.equal(custom.counts.custom, 1);
    assert.equal(custom.payments.includes("COD"), true);
    assert.equal(custom.payments.includes("PAID"), true);
    assert.equal(custom.payments.includes("PARTIALLY_PAID"), false);

    const cod = await listOrders("shop-a", 1, { payment: "COD" });
    assert.deepEqual(cod.orders.map((order) => order.id), ["o2"]);

    const open = await listOrders("shop-a", 1, { date: "custom" });
    assert.equal(open.counts.custom, null);
    assert.equal(open.orders.length, 2);
  } finally {
    setSupabaseForTests(undefined);
  }
});

test("csv export pages the current shop filters", async () => {
  const db = memorySupabase();
  setSupabaseForTests(db as unknown as SupabaseClient);
  try {
    db.tables.shops.push({ id: "shop-a", currency: "INR", timezone: "Asia/Kolkata" });
    for (let index = 0; index < 26; index += 1) {
      db.tables.orders.push({
        id: `o-${index}`,
        shop_id: "shop-a",
        order_name: `#${1000 + index}`,
        shipping_name: "Asha",
        phone: "9991112222",
        shopify_created_at: "2026-09-28T18:04:00.000Z",
        financial_status: "PAID",
        payment_mode: "PREPAID",
        total_amount: 10,
        status: "READY",
      });
    }
    db.tables.orders.push({
      id: "other",
      shop_id: "shop-b",
      order_name: "#9",
      shipping_name: "Asha",
      phone: "9991112222",
      shopify_created_at: "2026-09-28T18:04:00.000Z",
      status: "READY",
    });
    const csv = await exportOrdersCsv("shop-a", { search: "Asha" });
    const lines = csv.trim().split("\n");
    assert.equal(lines.length, 27);
    assert.equal(lines[0].startsWith("Order,Customer,"), true);
    assert.equal(csv.includes("#9"), false);
    assert.equal(csv.includes("Shopify"), true);
  } finally {
    setSupabaseForTests(undefined);
  }
});

test("service switch follows saved contracts and leaves booked shipments", async () => {
  const db = memorySupabase();
  setSupabaseForTests(db as unknown as SupabaseClient);
  try {
    db.tables.shop_settings.push({ shop_id: "shop-a", default_service: "SP_INLAND_PARCEL" });
    db.tables.india_post_contracts.push(
      { shop_id: "shop-a", service_code: "SP_INLAND_PARCEL", contract_id: "11111111" },
      { shop_id: "shop-a", service_code: "BUSINESS_PARCEL", contract_id: "22222222" },
      { shop_id: "shop-b", service_code: "BUSINESS_PARCEL", contract_id: "33333333" },
    );
    db.tables.shipments.push(
      { id: "draft", shop_id: "shop-a", status: "DRAFT", service_code: "SP_INLAND_PARCEL", submitted_s10: null },
      { id: "queued", shop_id: "shop-a", status: "QUEUED", service_code: "SP_INLAND_PARCEL" },
      { id: "failed-open", shop_id: "shop-a", status: "FAILED", service_code: "SP_INLAND_PARCEL", submitted_s10: null },
      { id: "failed-sent", shop_id: "shop-a", status: "FAILED", service_code: "SP_INLAND_PARCEL", submitted_s10: "EK1" },
      { id: "booked", shop_id: "shop-a", status: "BOOKED", service_code: "SP_INLAND_PARCEL", submitted_s10: "EK2" },
      { id: "booking", shop_id: "shop-a", status: "BOOKING", service_code: "SP_INLAND_PARCEL", submitted_s10: null },
      { id: "other-shop", shop_id: "shop-b", status: "DRAFT", service_code: "SP_INLAND_PARCEL", submitted_s10: null },
    );

    const both = await shopServiceChoice("shop-a");
    assert.equal(both.canToggle, true);
    assert.equal(both.activeService, "SP_INLAND_PARCEL");
    assert.deepEqual(both.services.sort(), ["BUSINESS_PARCEL", "SP_INLAND_PARCEL"]);

    await setShopService("shop-a", "BUSINESS_PARCEL");
    assert.equal(db.tables.shop_settings[0].default_service, "BUSINESS_PARCEL");
    assert.equal(db.tables.shipments.find((row) => row.id === "draft")?.service_code, "BUSINESS_PARCEL");
    assert.equal(db.tables.shipments.find((row) => row.id === "queued")?.service_code, "BUSINESS_PARCEL");
    assert.equal(db.tables.shipments.find((row) => row.id === "failed-open")?.service_code, "BUSINESS_PARCEL");
    assert.equal(db.tables.shipments.find((row) => row.id === "failed-sent")?.service_code, "SP_INLAND_PARCEL");
    assert.equal(db.tables.shipments.find((row) => row.id === "booked")?.service_code, "SP_INLAND_PARCEL");
    assert.equal(db.tables.shipments.find((row) => row.id === "booking")?.service_code, "SP_INLAND_PARCEL");
    assert.equal(db.tables.shipments.find((row) => row.id === "other-shop")?.service_code, "SP_INLAND_PARCEL");

    db.tables.india_post_contracts.splice(0, db.tables.india_post_contracts.length, {
      shop_id: "shop-a",
      service_code: "SP_INLAND_PARCEL",
      contract_id: "11111111",
    });
    db.tables.shop_settings[0].default_service = "BUSINESS_PARCEL";
    const onlySpeedPost = await shopServiceChoice("shop-a");
    assert.equal(onlySpeedPost.canToggle, false);
    assert.equal(onlySpeedPost.activeService, "SP_INLAND_PARCEL");
    assert.equal(db.tables.shop_settings[0].default_service, "SP_INLAND_PARCEL");
    await assert.rejects(() => setShopService("shop-a", "BUSINESS_PARCEL"), /Service is not available/);
  } finally {
    setSupabaseForTests(undefined);
  }
});

test("an order row can change SP or BP until it is booked", async () => {
  const db = memorySupabase();
  setSupabaseForTests(db as unknown as SupabaseClient);
  try {
    db.tables.shop_settings.push({ shop_id: "shop-a", default_service: "SP_INLAND_PARCEL", default_parcel_grams: 500 });
    db.tables.india_post_contracts.push(
      { shop_id: "shop-a", service_code: "SP_INLAND_PARCEL", contract_id: "11111111" },
      { shop_id: "shop-a", service_code: "BUSINESS_PARCEL", contract_id: "22222222" },
    );
    db.tables.orders.push(
      { id: "open", shop_id: "shop-a", status: "READY", payment_mode: "PREPAID", cod_amount: 0 },
      { id: "drafted", shop_id: "shop-a", status: "READY", payment_mode: "COD", cod_amount: 80 },
      { id: "booked", shop_id: "shop-a", status: "READY", payment_mode: "PREPAID", cod_amount: 0 },
      { id: "cancelled", shop_id: "shop-a", status: "CANCELLED", payment_mode: "PREPAID", cod_amount: 0 },
      { id: "other", shop_id: "shop-b", status: "READY", payment_mode: "PREPAID", cod_amount: 0 },
    );
    db.tables.shipments.push(
      { id: "draft-1", shop_id: "shop-a", order_id: "drafted", status: "DRAFT", service_code: "SP_INLAND_PARCEL", submitted_s10: null },
      { id: "booked-1", shop_id: "shop-a", order_id: "booked", status: "BOOKED", service_code: "SP_INLAND_PARCEL", submitted_s10: "EK1" },
    );

    await setOrderService("shop-a", "drafted", "BUSINESS_PARCEL");
    assert.equal(db.tables.shipments.find((row) => row.id === "draft-1")?.service_code, "BUSINESS_PARCEL");

    await setOrderService("shop-a", "open", "BUSINESS_PARCEL");
    const created = db.tables.shipments.find((row) => row.order_id === "open");
    assert.equal(created?.shop_id, "shop-a");
    assert.equal(created?.service_code, "BUSINESS_PARCEL");
    assert.equal(created?.status, "DRAFT");
    assert.equal(created?.payment_mode, "PREPAID");

    await assert.rejects(() => setOrderService("shop-a", "booked", "BUSINESS_PARCEL"), /Service is not available/);
    await assert.rejects(() => setOrderService("shop-a", "cancelled", "BUSINESS_PARCEL"), /Service is not available/);
    await assert.rejects(() => setOrderService("shop-b", "other", "BUSINESS_PARCEL"), /Service is not available/);
    assert.equal(db.tables.shipments.find((row) => row.id === "booked-1")?.service_code, "SP_INLAND_PARCEL");
  } finally {
    setSupabaseForTests(undefined);
  }
});
