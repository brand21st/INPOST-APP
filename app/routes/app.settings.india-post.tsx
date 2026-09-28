import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import { getSupabase } from "../db.server";
import { encryptSecret, sha256 } from "../../lib/crypto.server";
import { getShopByDomain } from "../../domain/tenancy/shops.server";
import { authenticate } from "../shopify.server";
import { randomBytes } from "node:crypto";

const settingsSchema = z.object({
  environment: z.enum(["UAT", "PRODUCTION"]),
  username: z.string().min(1),
  password: z.string().optional(),
  bulkCustomerId: z.string().min(1),
  officeId: z.string().regex(/^\d{8}$/),
  contractId: z.string().regex(/^\d{4,20}$/),
  serviceCode: z.enum(["SP_INLAND_PARCEL", "BUSINESS_PARCEL"]),
  prefix: z.string().regex(/^[A-Z]{2}$/),
  startNumber: z.coerce.number().int().positive(),
  endNumber: z.coerce.number().int().positive(),
  senderName: z.string().min(1),
  senderMobile: z.string().regex(/^[6-9]\d{9}$/),
  senderPincode: z.string().regex(/^\d{6}$/),
  senderAddress: z.string().min(1),
  autoBook: z.string().optional(),
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);
  if (!shop) return { connection: null };
  const { data } = await getSupabase()
    .from("india_post_connections")
    .select("environment, bulk_customer_id, office_id, status")
    .eq("shop_id", shop.id)
    .maybeSingle();
  return { connection: data };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);
  if (!shop) throw new Response("Shop is not installed", { status: 404 });
  const form = Object.fromEntries(await request.formData());
  const parsed = settingsSchema.safeParse(form);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid settings" };
  }
  const input = parsed.data;
  if (input.endNumber < input.startNumber) {
    return { error: "Range end is before the start" };
  }
  const { data: existing } = await getSupabase()
    .from("india_post_connections")
    .select("encrypted_password, inbound_token_hash")
    .eq("shop_id", shop.id)
    .maybeSingle();
  const current = existing as {
    encrypted_password: string | null;
    inbound_token_hash: string | null;
  } | null;
  if (!input.password && !current?.encrypted_password) {
    return { error: "Password is required the first time you connect" };
  }
  const inboundToken = current?.inbound_token_hash ? null : randomBytes(32).toString("hex");
  await getSupabase().from("india_post_connections").upsert(
    {
      shop_id: shop.id,
      encrypted_username: encryptSecret(input.username),
      encrypted_password: input.password ? encryptSecret(input.password) : current?.encrypted_password,
      bulk_customer_id: input.bulkCustomerId,
      environment: input.environment,
      office_id: input.officeId,
      inbound_token_hash: current?.inbound_token_hash ?? sha256(inboundToken ?? ""),
      status: "CONNECTED",
    },
    { onConflict: "shop_id" },
  );
  await getSupabase().from("shop_settings").upsert({
    shop_id: shop.id,
    auto_book: input.autoBook === "on",
    default_service: input.serviceCode,
    drop_off_office_id: input.officeId,
    sender_name: input.senderName,
    sender_mobile: input.senderMobile,
    sender_pincode: input.senderPincode,
    sender_address: input.senderAddress,
  });
  await getSupabase().from("india_post_contracts").upsert(
    {
      shop_id: shop.id,
      service_code: input.serviceCode,
      contract_id: input.contractId,
      is_default: true,
    },
    { onConflict: "shop_id,service_code" },
  );
  const { data: activeRange } = await getSupabase()
    .from("barcode_ranges")
    .select("id, prefix, start_number, end_number, next_number")
    .eq("shop_id", shop.id)
    .eq("service_code", input.serviceCode)
    .eq("active", true)
    .maybeSingle();
  const range = activeRange as {
    id: string;
    prefix: string;
    start_number: number;
    end_number: number;
    next_number: number;
  } | null;
  if (
    range &&
    range.prefix === input.prefix &&
    Number(range.start_number) === input.startNumber
  ) {
    if (input.endNumber < Number(range.next_number) - 1) {
      return { error: "Range end is below the next unused serial" };
    }
    const { error } = await getSupabase()
      .from("barcode_ranges")
      .update({ end_number: input.endNumber })
      .eq("shop_id", shop.id)
      .eq("id", range.id);
    if (error) return { error: error.message };
  } else {
    if (range) {
      await getSupabase()
        .from("barcode_ranges")
        .update({ active: false })
        .eq("shop_id", shop.id)
        .eq("id", range.id);
    }
    const { error } = await getSupabase().from("barcode_ranges").insert({
      shop_id: shop.id,
      prefix: input.prefix,
      suffix: "IN",
      start_number: input.startNumber,
      end_number: input.endNumber,
      next_number: input.startNumber,
      service_code: input.serviceCode,
      active: true,
    });
    if (error) return { error: error.message };
  }
  await getSupabase().from("audit_logs").insert({
    shop_id: shop.id,
    action: "credential_change",
    entity_type: "india_post_connection",
    detail: { environment: input.environment },
  });
  return {
    ok: true,
    inboundPath: inboundToken ? `/webhooks/india-post/${inboundToken}` : null,
  };
};

export default function IndiaPostSettings() {
  const { connection } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const row = connection as {
    environment: string;
    status: string;
    bulk_customer_id: string | null;
    office_id: string | null;
  } | null;

  return (
    <s-page heading="India Post">
      <s-section heading={row ? `${row.status} · ${row.environment}` : "Not connected"}>
        {actionData && "error" in actionData ? (
          <s-banner tone="critical">{actionData.error}</s-banner>
        ) : null}
        {actionData && "inboundPath" in actionData && actionData.inboundPath ? (
          <s-banner tone="info">
            Save this India Post callback path. It is shown once: {actionData.inboundPath}
          </s-banner>
        ) : null}
        <Form method="post">
          <s-stack direction="block" gap="base">
            <s-select label="Environment" name="environment" value={row?.environment ?? "UAT"}>
              <s-option value="UAT">UAT</s-option>
              <s-option value="PRODUCTION">Production</s-option>
            </s-select>
            <s-text-field label="Username" name="username" required />
            <s-password-field label="Password" name="password" />
            <s-text-field
              label="Bulk customer id"
              name="bulkCustomerId"
              value={row?.bulk_customer_id ?? ""}
              required
            />
            <s-text-field label="Office id" name="officeId" value={row?.office_id ?? ""} required />
            <s-select label="Service" name="serviceCode">
              <s-option value="SP_INLAND_PARCEL">Speed Post inland parcel</s-option>
              <s-option value="BUSINESS_PARCEL">Business parcel</s-option>
            </s-select>
            <s-text-field label="Contract id" name="contractId" required />
            <s-text-field label="Barcode prefix" name="prefix" required />
            <s-number-field label="Serial start" name="startNumber" required />
            <s-number-field label="Serial end" name="endNumber" required />
            <s-text-field label="Sender name" name="senderName" required />
            <s-text-field label="Sender mobile" name="senderMobile" required />
            <s-text-field label="Sender pincode" name="senderPincode" required />
            <s-text-field label="Sender address" name="senderAddress" required />
            <s-checkbox label="Book new orders automatically" name="autoBook" />
            <s-button type="submit" variant="primary">
              Save connection
            </s-button>
          </s-stack>
        </Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
