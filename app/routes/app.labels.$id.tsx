import type { LoaderFunctionArgs } from "react-router";
import { readLabelPdf } from "../../domain/labels/store.server";
import { getShopByDomain } from "../../domain/tenancy/shops.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);
  if (!shop || !params.id) throw new Response("Not found", { status: 404 });
  const pdf = await readLabelPdf(shop.id, params.id);
  const body = new ArrayBuffer(pdf.byteLength);
  new Uint8Array(body).set(pdf);
  return new Response(body, {
    headers: {
      "content-type": "application/pdf",
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="${params.id}.pdf"`,
    },
  });
};
