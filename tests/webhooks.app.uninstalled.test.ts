import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { ApiVersion, AppDistribution, shopifyApp } from "@shopify/shopify-app-react-router/server";

const API_SECRET = "test-api-secret";

const shopify = shopifyApp({
  apiKey: "test-api-key",
  apiSecretKey: API_SECRET,
  apiVersion: ApiVersion.July26,
  appUrl: "https://example.com",
  scopes: ["read_orders"],
  distribution: AppDistribution.AppStore,
  sessionStorage: {
    storeSession: async () => true,
    loadSession: async () => undefined,
    deleteSession: async () => true,
    deleteSessions: async () => true,
    findSessionsByShop: async () => [],
  },
});

function webhookRequest(body: string, hmac: string) {
  return new Request("https://example.com/webhooks/app/uninstalled", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": hmac,
      "x-shopify-topic": "app/uninstalled",
      "x-shopify-shop-domain": "a.myshopify.com",
      "x-shopify-api-version": "2026-07",
      "x-shopify-webhook-id": "wh_test_1",
    },
  });
}

test("forged webhook HMAC is rejected", async () => {
  const body = JSON.stringify({ shop_id: 1 });
  await assert.rejects(
    () => shopify.authenticate.webhook(webhookRequest(body, "not-a-valid-hmac")),
    (error: unknown) => error instanceof Response && error.status === 401,
  );
});

test("a correctly signed uninstall webhook is accepted", async () => {
  const body = JSON.stringify({ shop_id: 1 });
  const hmac = createHmac("sha256", API_SECRET).update(body, "utf8").digest("base64");
  const result = await shopify.authenticate.webhook(webhookRequest(body, hmac));
  assert.equal(result.shop, "a.myshopify.com");
  assert.equal(result.topic, "APP_UNINSTALLED");
  assert.equal(JSON.stringify(result).includes("shpat_"), false);
});
