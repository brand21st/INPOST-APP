import type { LoaderFunctionArgs } from "react-router";
import { readLabelPdf } from "../../domain/labels/store.server";
import { requireInstalledShop } from "../../domain/tenancy/request.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireInstalledShop(request);
  if (!params.id) throw new Response("Not found", { status: 404 });
  const pdf = await readLabelPdf(shop.id, params.id);
  const view = new URL(request.url).searchParams.get("view") === "1";
  const body = new ArrayBuffer(pdf.byteLength);
  new Uint8Array(body).set(pdf);
  return new Response(body, {
    headers: {
      "content-type": "application/pdf",
      "cache-control": "private, no-store",
      "content-disposition": `${view ? "inline" : "attachment"}; filename="${params.id}.pdf"`,
    },
  });
};
