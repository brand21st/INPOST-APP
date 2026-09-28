import assert from "node:assert/strict";
import test from "node:test";
import { mapShopifyPayment } from "./payment.ts";

test("paid orders stay prepaid even when the gateway name contains COD", () => {
  const mapped = mapShopifyPayment({
    financialStatus: "PAID",
    gatewayNames: ["Cash on Delivery (COD)"],
    orderTotal: 500,
    amountOutstanding: 0,
  });
  assert.deepEqual(mapped, { paymentMode: "PREPAID", codAmount: 0 });
});

test("pending COD gateway uses the order total", () => {
  const mapped = mapShopifyPayment({
    financialStatus: "PENDING",
    gatewayNames: ["cash on delivery"],
    orderTotal: 500,
    amountOutstanding: 500,
  });
  assert.deepEqual(mapped, { paymentMode: "COD", codAmount: 500 });
});

test("partially paid uses Shopify outstanding and does not collect an advance", () => {
  const mapped = mapShopifyPayment({
    financialStatus: "PARTIALLY_PAID",
    gatewayNames: ["Cash on Delivery"],
    orderTotal: 500,
    amountOutstanding: 200,
  });
  assert.deepEqual(mapped, { paymentMode: "COD", codAmount: 200 });
});
