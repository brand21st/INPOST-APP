import { indiaPostPublicTrackingUrl } from "../domain/india-post/barcode";
import type { AdminGraphql } from "./admin-graphql";
import {
  FULFILLMENT_CREATE,
  FULFILLMENT_TRACKING_UPDATE,
  ORDER_FULFILLMENT_ORDERS,
} from "./graphql";

type UserError = { field?: string[] | null; message: string };

function userErrorMessage(errors: UserError[] | undefined): string | null {
  if (!errors || errors.length === 0) return null;
  return errors.map((error) => error.message).join("; ");
}

export async function writeShopifyFulfillment(
  admin: AdminGraphql,
  input: {
    orderGid: string;
    existingFulfillmentGid: string | null;
    trackingNumber: string;
  },
): Promise<string> {
  const trackingInfo = {
    company: "India Post",
    number: input.trackingNumber,
    url: indiaPostPublicTrackingUrl(
      input.trackingNumber,
      process.env.INDIA_POST_PUBLIC_TRACKING_URL,
    ),
  };

  if (input.existingFulfillmentGid) {
    const response = await admin.graphql(FULFILLMENT_TRACKING_UPDATE, {
      variables: {
        fulfillmentId: input.existingFulfillmentGid,
        trackingInfoInput: trackingInfo,
        notifyCustomer: false,
      },
    });
    const body = (await response.json()) as {
      data?: {
        fulfillmentTrackingInfoUpdate?: {
          fulfillment?: { id: string } | null;
          userErrors: UserError[];
        };
      };
    };
    const payload = body.data?.fulfillmentTrackingInfoUpdate;
    const message = userErrorMessage(payload?.userErrors);
    if (message || !payload?.fulfillment?.id) {
      throw new Error(message ?? "Shopify tracking update failed");
    }
    return payload.fulfillment.id;
  }

  const orderResponse = await admin.graphql(ORDER_FULFILLMENT_ORDERS, {
    variables: { id: input.orderGid },
  });
  const orderBody = (await orderResponse.json()) as {
    data?: { order?: { fulfillmentOrders?: { nodes: { id: string; status: string }[] } } };
  };
  const fulfillmentOrderId = orderBody.data?.order?.fulfillmentOrders?.nodes.find(
    (node) => node.status === "OPEN" || node.status === "IN_PROGRESS",
  )?.id;
  if (!fulfillmentOrderId) {
    throw new Error("No open merchant-managed fulfillment order");
  }

  const response = await admin.graphql(FULFILLMENT_CREATE, {
    variables: {
      fulfillment: {
        notifyCustomer: false,
        trackingInfo,
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId }],
      },
    },
  });
  const body = (await response.json()) as {
    data?: {
      fulfillmentCreate?: {
        fulfillment?: { id: string } | null;
        userErrors: UserError[];
      };
    };
  };
  const payload = body.data?.fulfillmentCreate;
  const message = userErrorMessage(payload?.userErrors);
  if (message || !payload?.fulfillment?.id) {
    throw new Error(message ?? "Shopify fulfillment create failed");
  }
  return payload.fulfillment.id;
}
