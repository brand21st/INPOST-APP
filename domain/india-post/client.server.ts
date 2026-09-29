import { decryptOptional, encryptSecret } from "../../lib/crypto.server";
import { getSupabase } from "../../app/db.server";
import { logInfo } from "../../lib/logger.server";
import { classifyCeptFailure, type ErrorClass } from "./errors";

const DEFAULT_UAT = "https://test.cept.gov.in/beextcustomer";
const DEFAULT_PROD = "https://app.indiapost.gov.in/beextcustomer";
const DEFAULT_UAT_MASTERDATA = "https://test.cept.gov.in/bemasterdata";
const DEFAULT_PROD_MASTERDATA = "https://app.indiapost.gov.in/bemasterdata";

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

export function masterDataRoot(environment: "UAT" | "PRODUCTION"): string {
  const raw =
    environment === "PRODUCTION"
      ? process.env.INDIA_POST_PROD_MASTERDATA_URL || DEFAULT_PROD_MASTERDATA
      : process.env.INDIA_POST_UAT_MASTERDATA_URL || DEFAULT_UAT_MASTERDATA;
  return raw.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export type LoginTokenBody = {
  success?: boolean;
  access_token?: string;
  accessToken?: string;
  refresh_token?: string;
  expires_in?: number;
  data?: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
};

export function readLoginTokens(body: LoginTokenBody): {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
} | null {
  if (body.success === false) return null;
  const accessToken = body.data?.access_token || body.access_token || body.accessToken || "";
  if (!accessToken) return null;
  const expiresIn = body.data?.expires_in ?? body.expires_in ?? 3600;
  return {
    accessToken,
    refreshToken: body.data?.refresh_token || body.refresh_token || null,
    expiresIn: expiresIn > 0 ? expiresIn : 3600,
  };
}

export type DropOffice = {
  pincode: string;
  officeName: string;
  officeId: string;
  officeTypeCode: string;
  stateName: string;
  cityName: string;
  deliveryOfficeFlag: boolean;
  isRolledOut: boolean;
};

export function officeRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (typeof payload === "object" && payload !== null && Array.isArray((payload as { data?: unknown }).data)) {
    return (payload as { data: unknown[] }).data;
  }
  return [];
}

function flagIsTrue(value: unknown): boolean {
  return value === true || value === "true" || value === "TRUE" || value === 1 || value === "1";
}

export function eligibleDropOffices(payload: unknown): DropOffice[] {
  const offices: DropOffice[] = [];
  for (const row of officeRows(payload)) {
    if (typeof row !== "object" || row === null) continue;
    const office = row as Record<string, unknown>;
    if (!flagIsTrue(office.delivery_office_flag)) continue;
    if (String(office.office_type_code ?? "").toUpperCase() === "BPO") continue;
    const officeId = String(office.office_id ?? "").trim();
    if (!/^\d{8}$/.test(officeId)) continue;
    offices.push({
      pincode: String(office.pincode ?? ""),
      officeName: String(office.office_name ?? ""),
      officeId,
      officeTypeCode: String(office.office_type_code ?? ""),
      stateName: String(office.state_name ?? ""),
      cityName: String(office.city_name ?? ""),
      deliveryOfficeFlag: true,
      isRolledOut: office.is_rolled_out === true,
    });
  }
  return offices;
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
  let body: LoginTokenBody = {};
  try {
    body = JSON.parse(text) as LoginTokenBody;
  } catch {
    body = {};
  }
  const tokens = response.ok ? readLoginTokens(body) : null;
  if (!tokens) {
    throw new CeptError(classifyCeptFailure(response.status, text), "India Post login failed");
  }
  const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000).toISOString();
  const patch: {
    encrypted_access_token: string;
    encrypted_refresh_token?: string;
    token_expires_at: string;
    status: string;
    last_error: null;
  } = {
    encrypted_access_token: encryptSecret(tokens.accessToken),
    token_expires_at: expiresAt,
    status: "CONNECTED",
    last_error: null,
  };
  if (tokens.refreshToken) patch.encrypted_refresh_token = encryptSecret(tokens.refreshToken);
  await getSupabase().from("india_post_connections").update(patch).eq("shop_id", connection.shop_id);
  return tokens.accessToken;
}

export async function connectWithCredentials(connection: ConnectionRow): Promise<void> {
  await login({
    ...connection,
    encrypted_access_token: null,
    token_expires_at: null,
  });
}

export async function searchDropOffices(connection: ConnectionRow, pincode: string): Promise<DropOffice[]> {
  if (!/^\d{6}$/.test(pincode)) {
    throw new CeptError("VALIDATION_ERROR", "Pincode must be 6 digits");
  }
  const token = await login(connection);
  const url = new URL(`${masterDataRoot(connection.environment)}/v1/offices/limited-details`);
  url.searchParams.set("pincode", pincode);
  url.searchParams.set("limit", "50");
  url.searchParams.set("office-type", "post");
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  const shape = Array.isArray(payload)
    ? `array:${payload.length}`
    : payload && typeof payload === "object"
      ? `object:${Object.keys(payload).slice(0, 8).join(",")}`
      : "unreadable";
  logInfo("drop office search response", {
    shop_id: connection.shop_id,
    event: "drop_office_search",
    status: response.status,
    shape,
    result: response.ok ? "ok" : "error",
  });
  if (!response.ok || payload === null) {
    throw new CeptError(classifyCeptFailure(response.status, text), "India Post office search failed");
  }
  return eligibleDropOffices(payload);
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
