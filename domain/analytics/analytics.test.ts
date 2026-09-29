import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { setSupabaseForTests } from "../../app/db.server.ts";
import { deliverySummary, percentChange } from "./metrics.ts";
import { analyticsBounds, previousBounds } from "./range.ts";
import { clearAnalyticsCache, decorateAnalytics, loadAnalytics } from "./query.server.ts";

test("percent change is omitted when the previous period is empty", () => {
  assert.equal(percentChange(10, 0), null);
  assert.equal(percentChange(12, 10), 20);
});

test("delivery times stay hidden until two real samples exist", () => {
  const none = deliverySummary([]);
  assert.equal(none.enough, false);
  const one = deliverySummary([18]);
  assert.equal(one.enough, false);
  const two = deliverySummary([10, 20]);
  assert.equal(two.enough, true);
  assert.equal(two.avgHours, 15);
  assert.equal(two.fastestHours, 10);
  assert.equal(two.longestHours, 20);
});

test("label print is never derived from generated PDFs", () => {
  const snapshot = decorateAnalytics(
    {
      shopOrderCount: 1,
      currency: "USD",
      timezone: "UTC",
      kpis: {
        ordersReceived: { current: 2, previous: 1 },
        ordersShipped: { current: 1, previous: 1 },
        inTransit: { current: 0, previous: 0 },
        delivered: { current: 0, previous: 0 },
        returned: { current: 0, previous: 0 },
        codOrders: { current: 0, previous: 0 },
      },
      orders: { total: 2, new: 2, shipped: 1, pendingShipment: 1, cancelled: 0, returned: 0 },
      shipping: { total: 1, created: 1, labelsGenerated: 1, labelsPrinted: 99, inTransit: 0, delivered: 0, failedDelivery: 0, returned: 0 },
      services: {},
      delivery: { delivered: 0, inTransit: 0, sampleCount: 1, avgHours: 4, fastestHours: 4, longestHours: 4 },
      cod: { orders: 0, orderValue: 0, delivered: 0, returned: 0, pending: 0, collected: 0, pendingValue: 0, returnedValue: 0 },
      returns: { orders: 0, shipments: 0, booked: 1, cod: 0, speedPost: 0, businessParcel: 0 },
      pincodes: [],
      trends: [],
      status: {},
      activity: [],
    },
    { start: "2026-09-01T00:00:00.000Z", end: "2026-09-02T00:00:00.000Z" },
  );
  assert.equal(snapshot.shipping.labelsPrinted, null);
  assert.equal(snapshot.delivery.enough, false);
  assert.equal(snapshot.kpis.ordersReceived.change, 100);
});

test("last 7 days is a shop-timezone window of seven local days", () => {
  const range = analyticsBounds("UTC", { preset: "last_7" }, new Date("2026-09-29T12:00:00.000Z"));
  assert.ok(range);
  const ms = new Date(range.end).getTime() - new Date(range.start).getTime();
  assert.equal(Math.round(ms / 86_400_000), 7);
});

test("analytics RPC is called with the session shop only", async () => {
  let shopId: string | null = null;
  setSupabaseForTests({
    from() {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle() {
          return Promise.resolve({ data: { currency: "INR", timezone: "UTC" }, error: null });
        },
      };
    },
    rpc(_name: string, args: { p_shop_id: string }) {
      shopId = args.p_shop_id;
      return Promise.resolve({
        data: {
          shopOrderCount: args.p_shop_id === "shop-a" ? 3 : 0,
          currency: "INR",
          timezone: "UTC",
          kpis: {
            ordersReceived: { current: args.p_shop_id === "shop-a" ? 3 : 0, previous: 1 },
            ordersShipped: { current: 0, previous: 0 },
            inTransit: { current: 0, previous: 0 },
            delivered: { current: 0, previous: 0 },
            returned: { current: 0, previous: 0 },
            codOrders: { current: 0, previous: 0 },
          },
          orders: { total: 0, new: 0, shipped: 0, pendingShipment: 0, cancelled: 0, returned: 0 },
          shipping: { total: 0, created: 0, labelsGenerated: 0, inTransit: 0, delivered: 0, failedDelivery: 0, returned: 0 },
          services: {},
          delivery: { delivered: 0, inTransit: 0, sampleCount: 0 },
          cod: { orders: 0, orderValue: 0, delivered: 0, returned: 0, pending: 0, collected: 0, pendingValue: 0, returnedValue: 0 },
          returns: { orders: 0, shipments: 0, booked: 0, cod: 0, speedPost: 0, businessParcel: 0 },
          pincodes: [],
          trends: [],
          status: {},
          activity: [],
        },
        error: null,
      });
    },
  } as unknown as SupabaseClient);
  try {
    clearAnalyticsCache();
    const range = { start: "2026-09-01T00:00:00.000Z", end: "2026-09-08T00:00:00.000Z" };
    const a = await loadAnalytics("shop-a", range);
    assert.equal(shopId, "shop-a");
    assert.equal(a.shopOrderCount, 3);
    clearAnalyticsCache();
    const b = await loadAnalytics("shop-b", range);
    assert.equal(shopId, "shop-b");
    assert.equal(b.shopOrderCount, 0);
  } finally {
    clearAnalyticsCache();
    setSupabaseForTests(undefined);
  }
});

test("previous period is the same length immediately before the selection", () => {
  const previous = previousBounds({ start: "2026-09-08T00:00:00.000Z", end: "2026-09-15T00:00:00.000Z" });
  assert.equal(previous.start, "2026-09-01T00:00:00.000Z");
  assert.equal(previous.end, "2026-09-08T00:00:00.000Z");
});
