export const ORDER_FULFILLMENT_ORDERS = `#graphql
  query InpostFulfillmentOrders($id: ID!) {
    order(id: $id) {
      fulfillmentOrders(first: 10) {
        nodes {
          id
          status
        }
      }
    }
  }
`;

export const FULFILLMENT_CREATE = `#graphql
  mutation InpostFulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const FULFILLMENT_TRACKING_UPDATE = `#graphql
  mutation InpostFulfillmentTrackingUpdate(
    $fulfillmentId: ID!
    $trackingInfoInput: FulfillmentTrackingInput!
    $notifyCustomer: Boolean
  ) {
    fulfillmentTrackingInfoUpdate(
      fulfillmentId: $fulfillmentId
      trackingInfoInput: $trackingInfoInput
      notifyCustomer: $notifyCustomer
    ) {
      fulfillment {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const UNFULFILLED_ORDERS = `#graphql
  query InpostUnfulfilledOrders($cursor: String, $query: String!) {
    orders(first: 50, after: $cursor, query: $query) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        name
        displayFinancialStatus
        displayFulfillmentStatus
        paymentGatewayNames
        currentTotalPriceSet {
          shopMoney {
            amount
          }
        }
        totalOutstandingSet {
          shopMoney {
            amount
          }
        }
        shippingAddress {
          name
          address1
          address2
          city
          zip
          phone
        }
        cancelledAt
        lineItems(first: 50) {
          nodes {
            id
            title
            sku
            quantity
          }
        }
      }
    }
  }
`;
