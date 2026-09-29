import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "@shopify/shopify-api";
import type { SupabaseClient } from "@supabase/supabase-js";
import { setSupabaseForTests } from "../../app/db.server.ts";
import {
  assertInstalledShop,
  installRecord,
  markShopUninstalled,
  shopDomainFromSession,
  upsertShopOnInstall,
  type ShopRow,
} from "./shops.server.ts";
import type { AdminGraphql } from "../../shopify/admin-graphql.ts";

type Row = Record<string, unknown>;

function memorySupabase() {
  const tables: Record<string, Row[]> = {
    shops: [],
    shopify_sessions: [],
    shop_settings: [],
    audit_logs: [],
    background_jobs: [],
  };
  let seq = 1;
  function from(table: string) {
    const filters: Array<{ col: string; op: "eq" | "in"; value: unknown }> = [];
    let op: "select" | "update" | "delete" | "insert" | "upsert" = "select";
    let payload: Row | null = null;
    let conflict: string | undefined;
    const rows = () => tables[table] ?? (tables[table] = []);
    const matched = () =>
      rows().filter((row) =>
        filters.every((filter) =>
          filter.op === "eq" ? row[filter.col] === filter.value : (filter.value as unknown[]).includes(row[filter.col]),
        ),
      );
    const exec = () => {
      if (op === "insert" && payload) {
        rows().push(payload);
        return { data: payload, error: null };
      }
      if (op === "upsert" && payload) {
        const key = conflict ?? "id";
        const index = rows().findIndex((row) => row[key] === payload?.[key]);
        if (index >= 0) {
          rows()[index] = { ...rows()[index], ...payload };
          return { data: rows()[index], error: null };
        }
        const created = { id: `shop-${seq++}`, ...payload };
        rows().push(created);
        return { data: created, error: null };
      }
      if (op === "update" && payload) {
        for (const row of matched()) Object.assign(row, payload);
        return { data: matched(), error: null };
      }
      if (op === "delete") {
        const keep = rows().filter((row) => !matched().includes(row));
        tables[table] = keep;
        return { data: null, error: null };
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
      in(col: string, value: unknown[]) {
        filters.push({ col, op: "in", value });
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
      delete() {
        op = "delete";
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
      then(resolve: (value: { data: unknown; error: null }) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve(exec()).then(resolve, reject);
      },
    };
    return chain;
  }
  return { from, tables };
}

function admin(): AdminGraphql {
  return {
    graphql: async () =>
      Response.json({
        data: {
          shop: {
            id: "gid://shopify/Shop/1",
            name: "InPost Test",
            myshopifyDomain: "a.myshopify.com",
            email: "merchant@example.com",
            currencyCode: "INR",
            ianaTimezone: "Asia/Kolkata",
          },
        },
      }),
  };
}

function session() {
  return new Session({
    id: "offline_a.myshopify.com",
    shop: "A.myshopify.com",
    state: "state",
    isOnline: false,
    accessToken: "shpat_should_not_be_stored_on_shop",
    refreshToken: "shprt_should_not_be_stored_on_shop",
    scope: "read_orders",
  });
}

test("install, reauth, and reinstall keep one shop and the original installed_at", async () => {
  const db = memorySupabase();
  setSupabaseForTests(db as unknown as SupabaseClient);
  try {
    await upsertShopOnInstall(session(), admin());
    const first = db.tables.shops[0];
    assert.equal(db.tables.shops.length, 1);
    assert.equal(first.status, "INSTALLED");
    assert.equal(first.encrypted_offline_token, null);
    assert.equal(first.refresh_token, null);
    assert.equal(db.tables.background_jobs.length, 1);

    await upsertShopOnInstall(session(), admin());
    assert.equal(db.tables.shops.length, 1);
    assert.equal(db.tables.shops[0].installed_at, first.installed_at);
    assert.equal(db.tables.background_jobs.length, 1);

    db.tables.shopify_sessions.push({ id: "offline_a.myshopify.com", shop: "a.myshopify.com" });
    await markShopUninstalled("A.myshopify.com");
    assert.equal(db.tables.shops[0].status, "UNINSTALLED");
    assert.equal(db.tables.shopify_sessions.length, 0);
    assert.throws(
      () => assertInstalledShop(db.tables.shops[0] as unknown as ShopRow),
      (error: unknown) => error instanceof Response && error.status === 401,
    );

    await upsertShopOnInstall(session(), admin());
    assert.equal(db.tables.shops.length, 1);
    assert.equal(db.tables.shops[0].status, "INSTALLED");
    assert.equal(db.tables.shops[0].installed_at, first.installed_at);
    assert.equal(db.tables.background_jobs.length, 2);
    assertInstalledShop(db.tables.shops[0] as unknown as ShopRow);
  } finally {
    setSupabaseForTests(undefined);
  }
});

test("tenant identity comes from the session shop, not a client value", () => {
  assert.equal(shopDomainFromSession("Shop-A.myshopify.com", "shop-b.myshopify.com"), "shop-a.myshopify.com");
  assert.equal(installRecord(null, "2026-01-01T00:00:00.000Z").event, "install");
  assert.equal(
    installRecord({ status: "INSTALLED", installed_at: "2026-01-01T00:00:00.000Z" }, "2026-02-01T00:00:00.000Z")
      .shouldSyncOrders,
    false,
  );
  assert.throws(
    () => assertInstalledShop(null),
    (error: unknown) => error instanceof Response && error.status === 401,
  );
});
