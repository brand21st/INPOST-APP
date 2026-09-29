import type { OrderProjectionInput } from "../shipping/orders.server";

export function projectionFromGraphqlOrder(node: Record<string, unknown>): OrderProjectionInput {
  const address = (node.shippingAddress ?? {}) as Record<string, unknown>;
  const total = (node.currentTotalPriceSet as { shopMoney?: { amount?: string } } | null)?.shopMoney?.amount;
  const outstanding = (node.totalOutstandingSet as { shopMoney?: { amount?: string } } | null)?.shopMoney?.amount;
  const lines = ((node.lineItems as { nodes?: Record<string, unknown>[] } | null)?.nodes ?? []).map((line) => {
    const price = (line.originalUnitPriceSet as { shopMoney?: { amount?: string } } | null)?.shopMoney?.amount;
    return {
      gid: String(line.id),
      title: typeof line.title === "string" ? line.title : null,
      sku: typeof line.sku === "string" ? line.sku : null,
      quantity: Number(line.quantity ?? 1),
      grams: null,
      unitPrice: price == null ? null : Number(price),
    };
  });
  const zip = typeof address.zip === "string" ? address.zip : null;
  return {
    shopifyOrderGid: String(node.id),
    orderName: typeof node.name === "string" ? node.name : null,
    shopifyCreatedAt: typeof node.createdAt === "string" ? node.createdAt : null,
    financialStatus: typeof node.displayFinancialStatus === "string" ? node.displayFinancialStatus : null,
    fulfillmentStatus:
      typeof node.displayFulfillmentStatus === "string" ? node.displayFulfillmentStatus : null,
    gatewayNames: Array.isArray(node.paymentGatewayNames)
      ? node.paymentGatewayNames.filter((name): name is string => typeof name === "string")
      : [],
    orderTotal: Number(total ?? 0),
    amountOutstanding: Number(outstanding ?? 0),
    shippingName: typeof address.name === "string" ? address.name : null,
    shippingAddress: [address.address1, address.address2, address.city, address.zip]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(", "),
    phone: typeof address.phone === "string" ? address.phone : null,
    pincode: zip ? zip.replace(/\D/g, "").slice(0, 6) : null,
    cancelledAt: typeof node.cancelledAt === "string" ? node.cancelledAt : null,
    lines,
  };
}
