import type { ActionFunctionArgs } from "react-router";
import { acceptShopifyWebhook } from "../../domain/webhooks/inbox.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, payload } = await authenticate.webhook(request);
  await acceptShopifyWebhook({
    shop,
    topic,
    webhookId,
    payload: payload as Record<string, unknown>,
  });
  return new Response();
};
