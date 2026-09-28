import type { Session } from "@shopify/shopify-api";
import type { AdminGraphql } from "../../shopify/admin-graphql";
import { getSupabase, requireShopId } from "../../app/db.server";
import { encryptOptional } from "../../lib/crypto.server";
import { logInfo } from "../../lib/logger.server";

export type ShopRow = {
  id: string;
  shop_domain: string;
  status: string;
  encrypted_offline_token: string | null;
};

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
    .select("id, shop_domain, status, encrypted_offline_token")
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
  const row = {
    shop_domain: domain,
    shop_gid: shop?.id ?? null,
    name: shop?.name ?? null,
    email: shop?.email ?? null,
    currency: shop?.currencyCode ?? null,
    timezone: shop?.ianaTimezone ?? null,
    encrypted_offline_token: session.accessToken ? encryptOptional(session.accessToken) : null,
    token_expires_at: session.expires ? session.expires.toISOString() : null,
    refresh_token: encryptOptional(session.refreshToken),
    scopes: session.scope ?? null,
    status: "INSTALLED",
    installed_at: now,
    uninstalled_at: null,
    webhooks_registered_at: now,
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
    action: "install",
    entity_type: "shop",
    entity_id: shopId,
  });
  await enqueueJob(shopId, "order-sync", null, {});
  logInfo("shop installed", { shop_id: shopId, shop: domain });
  return shopId;
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
  logInfo("shop uninstalled", { shop: domain, shop_id: existing?.id ?? null });
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
