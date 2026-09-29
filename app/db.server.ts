import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | undefined;
let testClient: SupabaseClient | undefined;

export function setSupabaseForTests(next: SupabaseClient | undefined) {
  testClient = next;
}

export function getSupabase(): SupabaseClient {
  if (testClient) return testClient;
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    }
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

export function requireShopId(shopId: string | null | undefined): string {
  if (!shopId) {
    throw new Error("shop_id is required");
  }
  return shopId;
}

export function fromShop(table: string, shopId: string) {
  return getSupabase().from(table).select("*").eq("shop_id", requireShopId(shopId));
}
