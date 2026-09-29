import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  BlockStack,
  Button,
  ButtonGroup,
  Card,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { SettingsIcon } from "@shopify/polaris-icons";
import { requireInstalledShop } from "../../domain/tenancy/request.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, shop } = await requireInstalledShop(request);
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
    <Page title="InPost">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                India Post for this shop
              </Text>
              <Text as="p">
                {data.shopDomain} is {data.installed ? "installed" : "not active"}. Shopify stays
                the source of truth for orders and payments. InPost stores shipments, barcodes,
                labels, and tracking for this shop only.
              </Text>
              <ButtonGroup>
                <Button url="/app/orders">Open orders</Button>
                <Button url="/app/shipments">Shipments</Button>
                <Button url="/app/labels">Labels</Button>
                <Button url="/app/settings/india-post" icon={SettingsIcon}>
                  Connect India Post
                </Button>
                <Button url={data.themeEditorUrl} target="_blank">
                  Add tracking block
                </Button>
              </ButtonGroup>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Customer tracking
              </Text>
              <Text as="p">
                Customers look up a consignment on your shop domain at /apps/inpost/track. Add the
                Track shipment block to a page in the theme editor. The app cannot turn that block
                on by itself.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
