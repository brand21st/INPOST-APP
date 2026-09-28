import type { ActionFunctionArgs } from "react-router";
import { unauthenticated } from "../shopify.server";
import { drainJobs } from "../../workers/processor.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization");
  if (!secret || header !== `Bearer ${secret}`) {
    return new Response(null, { status: 401 });
  }
  const claimed = await drainJobs(async (shop) => {
    const { admin } = await unauthenticated.admin(shop);
    return admin;
  });
  return Response.json({ claimed });
};
