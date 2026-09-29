import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { setSupabaseForTests } from "../../app/db.server.ts";
import {
  applyTrackingEvent,
  findTrackableShipment,
  parseTrackingBulkItem,
  refreshMerchantTracking,
  setTrackBulkForTests,
} from "./tracking.server.ts";

type Row = Record<string, unknown>;

function memorySupabase() {
  const tables: Record<string, Row[]> = {
    barcode_allocations: [],
    shipments: [],
    labels: [],
    tracking_events: [],
    orders: [],
    india_post_connections: [],
  };
  function from(table: string) {
    const filters: Array<{ col: string; op: string; value: unknown }> = [];
    let op: "select" | "update" | "upsert" = "select";
    let payload: Row | null = null;
    let conflict = "";
    const rows = () => tables[table] ?? (tables[table] = []);
    const matched = () =>
      rows().filter((row) =>
        filters.every((filter) => {
          if (filter.op === "eq") return row[filter.col] === filter.value;
          return true;
        }),
      );
    const exec = () => {
      if (op === "upsert" && payload) {
        const keys = conflict.split(",").map((key) => key.trim());
        const index = rows().findIndex((row) => keys.every((key) => String(row[key]) === String(payload?.[key])));
        if (index >= 0) {
          rows()[index] = { ...rows()[index], ...payload };
          return { data: rows()[index], error: null };
        }
        rows().push({ id: `ev-${rows().length + 1}`, ...payload });
        return { data: payload, error: null };
      }
      if (op === "update" && payload) {
        for (const row of matched()) Object.assign(row, payload);
        return { data: matched(), error: null };
      }
      return { data: matched(), error: null };
    };
    const chain = {
      select() {
        return chain;
      },
      eq(col: string, value: unknown) {
        filters.push({ col, op: "eq", value });
        return chain;
      },
      upsert(next: Row, options?: { onConflict?: string }) {
        op = "upsert";
        payload = next;
        conflict = options?.onConflict ?? "id";
        return Promise.resolve(exec());
      },
      update(next: Row) {
        op = "update";
        payload = next;
        return chain;
      },
      order() {
        return chain;
      },
      maybeSingle() {
        const found = exec().data as Row[];
        return Promise.resolve({ data: found[0] ?? null, error: null });
      },
      single() {
        const found = exec().data as Row[];
        return Promise.resolve({ data: found[0] ?? null, error: null });
      },
      then(resolve: (value: { data: unknown; error: null }) => unknown) {
        return Promise.resolve(exec()).then(resolve);
      },
    };
    return chain;
  }
  return {
    from,
    tables,
    rpc() {
      return Promise.resolve({ data: true, error: null });
    },
  };
}

function seedTrackable(db: ReturnType<typeof memorySupabase>, labelStatus = "READY") {
  db.tables.shipments.push({
    id: "ship-1",
    shop_id: "shop-a",
    order_id: "ord-1",
    tracking_number: "EK123456789IN",
    barcode: "EK123456789IN",
    submitted_s10: "EK123456789IN",
    service_code: "SP_INLAND_PARCEL",
    status: "LABEL_READY",
    operational_status: "BOOKED",
    last_tracking_synced_at: null,
    last_tracking_location: null,
  });
  db.tables.shipments.push({
    id: "ship-b",
    shop_id: "shop-b",
    order_id: "ord-b",
    tracking_number: "EK123456789IN",
    service_code: "SP_INLAND_PARCEL",
    status: "LABEL_READY",
    operational_status: "BOOKED",
  });
  db.tables.labels.push({
    id: "lab-1",
    shop_id: "shop-a",
    shipment_id: "ship-1",
    kind: "INDIA_POST",
    status: labelStatus,
  });
  db.tables.orders.push({
    id: "ord-1",
    shop_id: "shop-a",
    order_name: "#1",
    shipping_name: "Bindu",
    pincode: "673121",
  });
  db.tables.india_post_connections.push({
    shop_id: "shop-a",
    encrypted_username: "x",
    encrypted_password: "y",
    encrypted_access_token: "z",
    token_expires_at: null,
    bulk_customer_id: "1",
    environment: "PRODUCTION",
    office_id: "12345678",
    status: "CONNECTED",
  });
}

test("parseTrackingBulkItem keeps only present fields", () => {
  const parsed = parseTrackingBulkItem(
    { barcode: "EK123456789IN", event: "Item booked", occurred_at: "2026-09-28T10:00:00.000Z", location: "Wayanad HO" },
    "FALLBACK",
  );
  assert.equal(parsed.barcode, "EK123456789IN");
  assert.equal(parsed.summary, "Item booked");
  assert.equal(parsed.location, "Wayanad HO");
  assert.equal(parsed.occurredAt, "2026-09-28T10:00:00.000Z");
});

test("lookup is shop-local and requires a READY India Post label", async () => {
  const db = memorySupabase();
  setSupabaseForTests(db as unknown as SupabaseClient);
  try {
    seedTrackable(db, "PENDING");
    const pending = await findTrackableShipment("shop-a", "EK123456789IN");
    assert.equal(pending.ok, false);
    if (!pending.ok) assert.equal(pending.reason, "not_ready");
    db.tables.labels[0].status = "READY";
    const found = await findTrackableShipment("shop-a", "ek123456789in");
    assert.equal(found.ok, true);
    const otherShop = await findTrackableShipment("shop-c", "EK123456789IN");
    assert.equal(otherShop.ok, false);
    if (!otherShop.ok) assert.equal(otherShop.reason, "not_found");
    const unknown = await findTrackableShipment("shop-a", "EK000000000IN");
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.match(unknown.message, /not found in your shipments/i);
  } finally {
    setSupabaseForTests(undefined);
  }
});

test("tracking events upsert on shop, shipment, key, and time", async () => {
  const db = memorySupabase();
  setSupabaseForTests(db as unknown as SupabaseClient);
  try {
    seedTrackable(db);
    const input = {
      shopId: "shop-a",
      barcode: "EK123456789IN",
      eventKey: "booked",
      occurredAt: "2026-09-28T10:00:00.000Z",
      summary: "Item booked",
      location: "Wayanad HO",
    };
    assert.equal(await applyTrackingEvent(input), true);
    assert.equal(await applyTrackingEvent(input), true);
    assert.equal(db.tables.tracking_events.length, 1);
    assert.equal(db.tables.tracking_events[0].location, "Wayanad HO");
    assert.equal(db.tables.shipments[0].last_tracking_location, "Wayanad HO");
  } finally {
    setSupabaseForTests(undefined);
  }
});

test("refresh uses the injected bulk client and does not call India Post live", async () => {
  const db = memorySupabase();
  setSupabaseForTests(db as unknown as SupabaseClient);
  let called: string[] | null = null;
  setTrackBulkForTests(async (_connection, barcodes) => {
    called = barcodes;
    return [{ article_number: barcodes[0], remarks: "Bagged", occurred_at: "2026-09-28T12:00:00.000Z" }];
  });
  try {
    seedTrackable(db);
    const result = await refreshMerchantTracking("shop-a", "EK123456789IN");
    assert.equal(result.ok, true);
    assert.deepEqual(called, ["EK123456789IN"]);
    if (result.ok) {
      assert.equal(result.view.events.length, 1);
      assert.equal(result.view.events[0].summary, "Bagged");
      assert.ok(result.view.lastSyncedAt);
    }
  } finally {
    setTrackBulkForTests(undefined);
    setSupabaseForTests(undefined);
  }
});
