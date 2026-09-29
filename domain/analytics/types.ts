export type KpiValue = {
  current: number;
  previous: number;
  change: number | null;
};

export type ServiceSlice = {
  orders: number;
  shipments: number;
  labelsGenerated: number;
  inTransit: number;
  delivered: number;
  returned: number;
  codOrders: number;
};

export type AnalyticsActivity = {
  event: string;
  reference: string;
  at: string;
  status: string;
};

export type AnalyticsSnapshot = {
  shopOrderCount: number;
  currency: string;
  timezone: string;
  rangeLabel: string;
  fetchedAt: string;
  kpis: {
    ordersReceived: KpiValue;
    ordersShipped: KpiValue;
    inTransit: KpiValue;
    delivered: KpiValue;
    returned: KpiValue;
    codOrders: KpiValue;
  };
  orders: {
    total: number;
    new: number;
    shipped: number;
    pendingShipment: number;
    cancelled: number;
    returned: number;
  };
  shipping: {
    total: number;
    created: number;
    labelsGenerated: number;
    labelsPrinted: null;
    inTransit: number;
    delivered: number;
    failedDelivery: number;
    returned: number;
  };
  services: {
    SP_INLAND_PARCEL: ServiceSlice;
    BUSINESS_PARCEL: ServiceSlice;
  };
  delivery: {
    delivered: number;
    inTransit: number;
    enough: boolean;
    sampleCount: number;
    avgHours: number | null;
    fastestHours: number | null;
    longestHours: number | null;
    successRate: number | null;
    returnRate: number | null;
  };
  cod: {
    orders: number;
    orderValue: number;
    delivered: number;
    returned: number;
    pending: number;
    collected: number;
    pendingValue: number;
    returnedValue: number;
    deliveryRate: number | null;
    returnRate: number | null;
  };
  returns: {
    orders: number;
    shipments: number;
    rate: number | null;
    cod: number;
    speedPost: number;
    businessParcel: number;
  };
  pincodes: Array<{ pincode: string; shipments: number }>;
  trends: Array<{ day: string; orders: number; shipments: number; delivered: number; returns: number }>;
  status: {
    shopifyOrder: Record<string, number>;
    shopifyFulfillment: Record<string, number>;
    inpost: Record<string, number>;
    tracking: Record<string, number>;
  };
  activity: AnalyticsActivity[];
};

export function emptyService(): ServiceSlice {
  return { orders: 0, shipments: 0, labelsGenerated: 0, inTransit: 0, delivered: 0, returned: 0, codOrders: 0 };
}
