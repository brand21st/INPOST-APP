import type { Session } from "@shopify/shopify-api";
import type { AdminGraphql } from "../../shopify/admin-graphql";
import { getSupabase, requireShopId } from "../../app/db.server";
import { logInfo } from "../../lib/logger.server";

export type ShopRow = {
  id: string;
  shop_domain: string;
  status: string;
  encrypted_offline_token: string | null;
  installed_at: string | null;
};

export function installRecord(
  existing: Pick<ShopRow, "status" | "installed_at"> | null,
  now: string,
) {
  const fresh = !existing || existing.status === "UNINSTALLED";
  return {
    event: !existing ? "install" : existing.status === "UNINSTALLED" ? "reinstall" : "reauth",
    installed_at: existing?.installed_at ?? now,
    shouldSyncOrders: fresh,
    status: "INSTALLED" as const,
  };
}

export function assertInstalledShop(shop: ShopRow | null): ShopRow {
  if (!shop || shop.status !== "INSTALLED") {
    logInfo("authentication denied", {
      shop: shop?.shop_domain ?? null,
      event: "auth_denied",
      result: "denied",
    });
    throw new Response("Shop is not installed", { status: 401 });
  }
  return shop;
}

export function shopDomainFromSession(sessionShop: string, clientSuppliedShop?: string | null): string {
  void clientSuppliedShop;
  return normalizeShopDomain(sessionShop);
}

const SHOP_QUERY = `#graphql
  query InpostShopIdentity {
    shop {
      id
      name
      myshopifyDomain
      email
      currencyCode
      ianaTimezone
    }
  }
`;

export function normalizeShopDomain(shop: string): string {
  return shop.trim().toLowerCase();
}

export async function getShopByDomain(shop: string): Promise<ShopRow | null> {
  const domain = normalizeShopDomain(shop);
  const { data, error } = await getSupabase()
    .from("shops")
    .select("id, shop_domain, status, encrypted_offline_token, installed_at")
    .eq("shop_domain", domain)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ShopRow | null) ?? null;
}

export async function upsertShopOnInstall(session: Session, admin: AdminGraphql) {
  const domain = normalizeShopDomain(session.shop);
  const response = await admin.graphql(SHOP_QUERY);
  const body = (await response.json()) as {
    data?: {
      shop?: {
        id: string;
        name: string;
        myshopifyDomain: string;
        email: string;
        currencyCode: string;
        ianaTimezone: string;
      };
    };
  };
  const shop = body.data?.shop;
  const now = new Date().toISOString();
  const existing = await getShopByDomain(domain);
  const transition = installRecord(existing, now);
  const row = {
    shop_domain: domain,
    shop_gid: shop?.id ?? null,
    name: shop?.name ?? null,
    email: shop?.email ?? null,
    currency: shop?.currencyCode ?? null,
    timezone: shop?.ianaTimezone ?? null,
    encrypted_offline_token: null,
    token_expires_at: null,
    refresh_token: null,
    scopes: session.scope ?? null,
    status: transition.status,
    installed_at: transition.installed_at,
    uninstalled_at: null,
    ...(transition.shouldSyncOrders ? { webhooks_registered_at: now } : {}),
  };
  const { data, error } = await getSupabase()
    .from("shops")
    .upsert(row, { onConflict: "shop_domain" })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const shopId = requireShopId((data as { id: string }).id);
  await getSupabase().from("shopify_sessions").update({ shop_id: shopId }).eq("shop", domain);
  const { error: settingsError } = await getSupabase()
    .from("shop_settings")
    .upsert({ shop_id: shopId }, { onConflict: "shop_id", ignoreDuplicates: true });
  if (settingsError) throw new Error(settingsError.message);
  await getSupabase().from("audit_logs").insert({
    shop_id: shopId,
    action: transition.event,
    entity_type: "shop",
    entity_id: shopId,
  });
  if (transition.shouldSyncOrders) {
    await enqueueJob(shopId, "order-sync", null, {});
  }
  logInfo("shop authenticated", {
    shop_id: shopId,
    shop: domain,
    event: transition.event,
    result: "ok",
  });
  return shopId;
}

export async function updateShopScopes(shop: string, scopes: string) {
  const domain = normalizeShopDomain(shop);
  const { error } = await getSupabase().from("shops").update({ scopes }).eq("shop_domain", domain);
  if (error) throw new Error(error.message);
  logInfo("shop scopes updated", { shop: domain, event: "scopes_update", result: "ok" });
}

export async function markShopUninstalled(shop: string) {
  const domain = normalizeShopDomain(shop);
  const existing = await getShopByDomain(domain);
  const now = new Date().toISOString();
  if (existing) {
    await getSupabase()
      .from("shops")
      .update({
        status: "UNINSTALLED",
        uninstalled_at: now,
        encrypted_offline_token: null,
        refresh_token: null,
        token_expires_at: null,
      })
      .eq("id", existing.id);
    await getSupabase()
      .from("background_jobs")
      .update({ status: "CANCELLED" })
      .eq("shop_id", existing.id)
      .in("status", ["QUEUED", "RUNNING"]);
    await getSupabase().from("audit_logs").insert({
      shop_id: existing.id,
      action: "uninstall",
      entity_type: "shop",
      entity_id: existing.id,
    });
  }
  await getSupabase().from("shopify_sessions").delete().eq("shop", domain);
  logInfo("shop uninstalled", {
    shop: domain,
    shop_id: existing?.id ?? null,
    event: "uninstall",
    result: "ok",
  });
}

export async function enqueueJob(
  shopId: string,
  type: string,
  entityId: string | null,
  payload: Record<string, unknown>,
  runAfter?: Date,
) {
  requireShopId(shopId);
  const { error } = await getSupabase().from("background_jobs").insert({
    shop_id: shopId,
    type,
    entity_id: entityId,
    payload,
    status: "QUEUED",
    run_after: (runAfter ?? new Date()).toISOString(),
  });
  if (error && error.code !== "23505") {
    throw new Error(error.message);
  }
  return error?.code !== "23505";
}
