import type { ActionFunctionArgs } from "react-router";
import { updateShopScopes } from "../../domain/tenancy/shops.server";
import { authenticate, sessionStorage } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, session, shop } = await authenticate.webhook(request);
  const current = payload.current as string[];
  const scopes = Array.isArray(current) ? current.join(",") : String(current ?? "");
  if (session) {
    session.scope = scopes;
    await sessionStorage.storeSession(session);
  }
  await updateShopScopes(shop, scopes);
  return new Response();
};
