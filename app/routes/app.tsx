import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import "@shopify/polaris/build/esm/styles.css";

import { requireInstalledShop } from "../../domain/tenancy/request.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireInstalledShop(request);

  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/orders">Orders</s-link>
        <s-link href="/app/shipments">Shipments</s-link>
        <s-link href="/app/labels">Labels</s-link>
        <s-link href="/app/tracking">Tracking</s-link>
        <s-link href="/app/analytics">Analytics</s-link>
        <s-link href="/app/settings/india-post">India Post</s-link>
      </s-app-nav>
      <PolarisAppProvider i18n={enTranslations}>
        <Outlet />
      </PolarisAppProvider>
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
