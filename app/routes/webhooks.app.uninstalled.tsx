import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { markShopUninstalled } from "../../domain/tenancy/shops.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticate.webhook(request);
  await markShopUninstalled(shop);
  return new Response();
};
