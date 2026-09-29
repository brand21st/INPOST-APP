import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "@shopify/shopify-api";
import { decryptOptional } from "../lib/crypto.server.ts";
import { sanitizeLogFields } from "../lib/logger.server.ts";
import { sessionToRow } from "./session-storage.server.ts";

process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

test("session tokens are encrypted at rest and logs drop secret fields", () => {
  const token = "shpat_plaintext_token";
  const row = sessionToRow(
    new Session({
      id: "offline_a.myshopify.com",
      shop: "a.myshopify.com",
      state: "state",
      isOnline: false,
      accessToken: token,
      refreshToken: "shpss_refresh_secret",
    }),
  );
  assert.notEqual(row.access_token, token);
  assert.equal(row.access_token?.includes(token), false);
  assert.equal(decryptOptional(row.access_token), token);
  assert.equal(row.refresh_token?.includes("shpss_refresh_secret"), false);

  const safe = sanitizeLogFields({
    shop: "a.myshopify.com",
    event: "install",
    result: "ok",
    access_token: token,
    note: "shpss_do_not_log",
  });
  const encoded = JSON.stringify(safe);
  assert.equal(encoded.includes("shpat_"), false);
  assert.equal(encoded.includes("shpss_"), false);
  assert.equal(safe.shop, "a.myshopify.com");
});
