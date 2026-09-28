import { decryptOptional, encryptSecret } from "../../lib/crypto.server";
import { getSupabase } from "../../app/db.server";
import { classifyCeptFailure, type ErrorClass } from "./errors";

const DEFAULT_UAT = "https://test.cept.gov.in/beextcustomer";
const DEFAULT_PROD = "https://app.indiapost.gov.in/beextcustomer";

export type ConnectionRow = {
  shop_id: string;
  encrypted_username: string | null;
  encrypted_password: string | null;
  encrypted_access_token: string | null;
  token_expires_at: string | null;
  bulk_customer_id: string | null;
  environment: "UAT" | "PRODUCTION";
  office_id: string | null;
  status: string;
};

export function ceptRoot(environment: "UAT" | "PRODUCTION"): string {
  const raw =
    environment === "PRODUCTION"
      ? process.env.INDIA_POST_PROD_BASE_URL || DEFAULT_PROD
      : process.env.INDIA_POST_UAT_BASE_URL || DEFAULT_UAT;
  return raw.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export class CeptError extends Error {
  errorClass: ErrorClass;
  constructor(errorClass: ErrorClass, message: string) {
    super(message);
    this.errorClass = errorClass;
  }
}

async function login(connection: ConnectionRow): Promise<string> {
  const username = decryptOptional(connection.encrypted_username);
  const password = decryptOptional(connection.encrypted_password);
  if (!username || !password) {
    throw new CeptError("PERMANENT_AUTH_ERROR", "India Post credentials are missing");
  }
  const expires = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : 0;
  if (connection.encrypted_access_token && expires - Date.now() > 60_000) {
    return decryptOptional(connection.encrypted_access_token) ?? "";
  }
  const response = await fetch(`${ceptRoot(connection.environment)}/v1/access/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new CeptError(classifyCeptFailure(response.status, text), "India Post login failed");
  }
  const body = JSON.parse(text) as { access_token?: string; accessToken?: string; expires_in?: number };
  const token = body.access_token ?? body.accessToken;
  if (!token) throw new CeptError("PERMANENT_AUTH_ERROR", "India Post login returned no token");
  const expiresAt = new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString();
  await getSupabase()
    .from("india_post_connections")
    .update({
      encrypted_access_token: encryptSecret(token),
      token_expires_at: expiresAt,
      status: "CONNECTED",
    })
    .eq("shop_id", connection.shop_id);
  return token;
}

async function authorizedPost(connection: ConnectionRow, path: string, body: unknown) {
  const token = await login(connection);
  const response = await fetch(`${ceptRoot(connection.environment)}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new CeptError(classifyCeptFailure(response.status, text), text.slice(0, 500));
  }
  return text;
}

export async function processArticles(connection: ConnectionRow, articles: unknown[]) {
  if (!connection.bulk_customer_id) {
    throw new CeptError("VALIDATION_ERROR", "bulk customer id is missing");
  }
  const text = await authorizedPost(
    connection,
    `/process-articles/${encodeURIComponent(connection.bulk_customer_id)}`,
    { articles },
  );
  return JSON.parse(text) as Record<string, unknown>;
}

export async function fetchOfficialLabel(connection: ConnectionRow, article: Record<string, unknown>) {
  const token = await login(connection);
  const response = await fetch(`${ceptRoot(connection.environment)}/v1/label/create/domestic`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(article),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok || !bytes.subarray(0, 4).toString("utf8").startsWith("%PDF")) {
    throw new CeptError(
      classifyCeptFailure(response.status, bytes.toString("utf8").slice(0, 300)),
      "India Post label was not a PDF",
    );
  }
  return bytes;
}

export async function trackBulk(connection: ConnectionRow, barcodes: string[]) {
  if (barcodes.length === 0) return [];
  if (barcodes.length > 500) {
    throw new CeptError("VALIDATION_ERROR", "tracking bulk accepts at most 500 barcodes");
  }
  const text = await authorizedPost(connection, "/v1/tracking/bulk", { barcodes });
  const body = JSON.parse(text) as { events?: unknown[] } | unknown[];
  return Array.isArray(body) ? body : (body.events ?? []);
}

export function acceptedArticleNumber(body: Record<string, unknown>, submitted: string): string {
  const nested = (body.articles ?? body.data ?? body) as Record<string, unknown> | unknown[];
  const first = Array.isArray(nested) ? (nested[0] as Record<string, unknown>) : nested;
  const candidate =
    first?.article_number ?? first?.barcode_no ?? first?.consignment_number ?? body.article_number;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : submitted;
}

export function tariffFromBooking(body: Record<string, unknown>): number | null {
  const value = body.calculated_tariff;
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) ? amount : null;
}
