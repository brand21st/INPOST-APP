import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../../domain/tenancy/shops.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);
  const storeHandle = session.shop.replace(".myshopify.com", "");
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  const themeEditorUrl = `https://admin.shopify.com/store/${storeHandle}/themes/current/editor?template=page&addAppBlockId=${apiKey}/track-shipment&target=newAppsSection`;
  return {
    shopDomain: session.shop,
    installed: shop?.status === "INSTALLED",
    themeEditorUrl,
  };
};

export default function Index() {
  const data = useLoaderData<typeof loader>();

  return (
    <s-page heading="InPost">
      <s-section heading="India Post for this shop">
        <s-paragraph>
          {data.shopDomain} is {data.installed ? "installed" : "not active"}. Shopify stays the
          source of truth for orders and payments. InPost stores shipments, barcodes, labels, and
          tracking for this shop only.
        </s-paragraph>
        <s-stack direction="inline" gap="base">
          <s-link href="/app/orders">Open orders</s-link>
          <s-link href="/app/settings/india-post">Connect India Post</s-link>
          <s-link href={data.themeEditorUrl} target="_blank">
            Add tracking block
          </s-link>
        </s-stack>
      </s-section>
      <s-section heading="Customer tracking">
        <s-paragraph>
          Customers look up a consignment on your shop domain at /apps/inpost/track. Add the Track
          shipment block to a page in the theme editor. The app cannot turn that block on by itself.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
