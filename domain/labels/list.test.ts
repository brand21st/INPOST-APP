import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { setSupabaseForTests } from "../../app/db.server.ts";
import { listShipments } from "../shipping/list.server.ts";
import { listLabels } from "./list.server.ts";

type Row = Record<string, unknown>;

function memorySupabase() {
  const tables: Record<string, Row[]> = { shops: [], orders: [], shipments: [], labels: [] };
  function from(table: string) {
    const filters: Array<{ col: string; op: string; value: unknown }> = [];
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
      order() {
        return chain;
      },
      range(from: number, to: number) {
        rangeFrom = from;
        rangeTo = to;
        return chain;
      },
      maybeSingle() {
        const found = matched();
        return Promise.resolve({ data: found[0] ?? null, error: null, count: found.length });
      },
      then(resolve: (value: { data: unknown; error: null; count: number | null }) => unknown) {
        const found = matched().slice(rangeFrom, rangeTo + 1);
        return Promise.resolve({ data: found, error: null, count: matched().length }).then(resolve);
      },
    };
    return chain;
  }
  return { from, tables };
}

test("shipment and label lists stay on the session shop", async () => {
  const db = memorySupabase();
  setSupabaseForTests(db as unknown as SupabaseClient);
  try {
    db.tables.shops.push({ id: "shop-a", timezone: "Asia/Kolkata" });
    db.tables.orders.push(
      {
        id: "ord-1",
        shop_id: "shop-a",
        order_name: "#2344",
        shipping_name: "Bindu Baby",
        shipping_address: "Wayanad",
        pincode: "673121",
      },
      { id: "ord-b", shop_id: "shop-b", order_name: "#9", shipping_name: "Other", pincode: "110001" },
    );
    db.tables.shipments.push(
      {
        id: "ship-1",
        shop_id: "shop-a",
        order_id: "ord-1",
        service_code: "SP_INLAND_PARCEL",
        tracking_number: "EK123456789IN",
        status: "LABEL_READY",
        created_at: "2026-09-28T10:00:00.000Z",
      },
      {
        id: "ship-b",
        shop_id: "shop-b",
        order_id: "ord-b",
        service_code: "BUSINESS_PARCEL",
        tracking_number: "EK000",
        status: "BOOKED",
        created_at: "2026-09-28T10:00:00.000Z",
      },
    );
    db.tables.labels.push(
      { id: "lab-1", shop_id: "shop-a", shipment_id: "ship-1", kind: "INDIA_POST", status: "READY", created_at: "2026-09-28T11:00:00.000Z" },
      { id: "lab-b", shop_id: "shop-b", shipment_id: "ship-b", kind: "INDIA_POST", status: "READY", created_at: "2026-09-28T11:00:00.000Z" },
    );
    const shipments = await listShipments("shop-a", 1, { search: "Bindu" });
    assert.equal(shipments.shipments.length, 1);
    assert.equal(shipments.shipments[0].id, "ship-1");
    assert.equal(shipments.shipments[0].trackingNumber, "EK123456789IN");
    const labels = await listLabels("shop-a", 1, { search: "#2344" });
    assert.equal(labels.labels.length, 1);
    assert.equal(labels.labels[0].id, "lab-1");
    const empty = await listShipments("shop-c", 1, {});
    assert.equal(empty.shipments.length, 0);
  } finally {
    setSupabaseForTests(undefined);
  }
});
