export type PaymentMode = "COD" | "PREPAID";

const COD_GATEWAY = /cash on delivery|\bcod\b/i;

export function mapShopifyPayment(input: {
  financialStatus: string | null | undefined;
  gatewayNames: string[];
  orderTotal: number;
  amountOutstanding: number;
}): { paymentMode: PaymentMode; codAmount: number } {
  const status = (input.financialStatus ?? "").toUpperCase();
  if (status === "PAID") {
    return { paymentMode: "PREPAID", codAmount: 0 };
  }
  if (status === "PARTIALLY_PAID") {
    const outstanding = Math.max(0, input.amountOutstanding);
    return {
      paymentMode: outstanding > 0 ? "COD" : "PREPAID",
      codAmount: outstanding,
    };
  }
  const codGateway = input.gatewayNames.some((name) => COD_GATEWAY.test(name));
  if (codGateway && (status === "PENDING" || status === "AUTHORIZED")) {
    return { paymentMode: "COD", codAmount: input.orderTotal };
  }
  return { paymentMode: "PREPAID", codAmount: 0 };
}
