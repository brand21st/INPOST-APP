import { authenticate } from "../../app/shopify.server";
import { assertInstalledShop, getShopByDomain } from "./shops.server";

export async function requireInstalledShop(request: Request) {
  const { session, admin } = await authenticate.admin(request);
  const shop = assertInstalledShop(await getShopByDomain(session.shop));
  return { session, admin, shop };
}
