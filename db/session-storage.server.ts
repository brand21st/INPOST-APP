import { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { getSupabase } from "../app/db.server";
import { decryptOptional, encryptOptional } from "../lib/crypto.server";

type SessionRow = {
  id: string;
  shop: string;
  state: string;
  is_online: boolean;
  scope: string | null;
  expires: string | null;
  access_token: string | null;
  refresh_token: string | null;
  refresh_token_expires: string | null;
  user_id: number | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  account_owner: boolean;
  locale: string | null;
  collaborator: boolean | null;
  email_verified: boolean | null;
};

function rowToSession(row: SessionRow): Session {
  const session = new Session({
    id: row.id,
    shop: row.shop,
    state: row.state,
    isOnline: row.is_online,
    scope: row.scope ?? undefined,
    expires: row.expires ? new Date(row.expires) : undefined,
    accessToken: decryptOptional(row.access_token) ?? undefined,
    refreshToken: decryptOptional(row.refresh_token) ?? undefined,
    refreshTokenExpires: row.refresh_token_expires ? new Date(row.refresh_token_expires) : undefined,
  });
  if (row.is_online && row.user_id) {
    const expiresIn = row.expires
      ? Math.max(0, Math.floor((new Date(row.expires).getTime() - Date.now()) / 1000))
      : 0;
    session.onlineAccessInfo = {
      expires_in: expiresIn,
      associated_user_scope: row.scope ?? "",
      associated_user: {
        id: Number(row.user_id),
        first_name: row.first_name ?? "",
        last_name: row.last_name ?? "",
        email: row.email ?? "",
        account_owner: row.account_owner,
        locale: row.locale ?? "",
        collaborator: Boolean(row.collaborator),
        email_verified: Boolean(row.email_verified),
      },
    };
  }
  return session;
}

export function sessionToRow(session: Session): SessionRow {
  const user = session.onlineAccessInfo?.associated_user;
  return {
    id: session.id,
    shop: session.shop,
    state: session.state,
    is_online: session.isOnline,
    scope: session.scope ?? null,
    expires: session.expires ? session.expires.toISOString() : null,
    access_token: encryptOptional(session.accessToken),
    refresh_token: encryptOptional(session.refreshToken),
    refresh_token_expires: session.refreshTokenExpires
      ? session.refreshTokenExpires.toISOString()
      : null,
    user_id: user?.id ?? null,
    first_name: user?.first_name ?? null,
    last_name: user?.last_name ?? null,
    email: user?.email ?? null,
    account_owner: Boolean(user?.account_owner),
    locale: user?.locale ?? null,
    collaborator: user?.collaborator ?? null,
    email_verified: user?.email_verified ?? null,
  };
}

export class SupabaseSessionStorage implements SessionStorage {
  async storeSession(session: Session): Promise<boolean> {
    const { error } = await getSupabase()
      .from("shopify_sessions")
      .upsert(sessionToRow(session), { onConflict: "id" });
    if (error) throw new Error(error.message);
    return true;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const { data, error } = await getSupabase()
      .from("shopify_sessions")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return undefined;
    return rowToSession(data as SessionRow);
  }

  async deleteSession(id: string): Promise<boolean> {
    const { error } = await getSupabase().from("shopify_sessions").delete().eq("id", id);
    if (error) throw new Error(error.message);
    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    if (ids.length === 0) return true;
    const { error } = await getSupabase().from("shopify_sessions").delete().in("id", ids);
    if (error) throw new Error(error.message);
    return true;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const { data, error } = await getSupabase()
      .from("shopify_sessions")
      .select("*")
      .eq("shop", shop);
    if (error) throw new Error(error.message);
    return ((data ?? []) as SessionRow[]).map(rowToSession);
  }
}
