import { getSupabase } from "../../app/db.server";
import { encryptSecret } from "../../lib/crypto.server";
import { logError, logInfo } from "../../lib/logger.server";
import {
  barcodeIssueMessage,
  rangesOverlap,
  remainingBarcodeCount,
  validateBarcodeRange,
} from "./barcode";
import {
  CeptError,
  connectWithCredentials,
  searchDropOffices,
  type ConnectionRow,
  type DropOffice,
} from "./client.server";

export const CONNECT_FAILURE =
  "Connection failed. Please check your India Post credentials and try again.";

const SPEED_POST = "SP_INLAND_PARCEL";
const BUSINESS_PARCELS = "BUSINESS_PARCEL";

export type IndiaPostSettings = {
  status: "DISCONNECTED" | "CONNECTED" | "FAILED";
  environment: "UAT" | "PRODUCTION";
  hasPassword: boolean;
  bulkCustomerId: string;
  lastError: string | null;
  speedPostContractId: string;
  businessParcelsContractId: string;
  barcode: {
    prefix: string;
    startNumber: number;
    endNumber: number;
    nextNumber: number;
    available: number;
    remaining: number;
  } | null;
  dropOffice: {
    id: string;
    name: string;
    pincode: string;
  } | null;
};

type ConnectionRecord = ConnectionRow & {
  encrypted_password: string | null;
  last_error: string | null;
  drop_office_name: string | null;
  drop_office_pincode: string | null;
};

type RangeRecord = {
  id: string;
  prefix: string;
  start_number: number | string;
  end_number: number | string;
  next_number: number | string;
  service_code: string | null;
  active: boolean;
};

function asNumber(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

function environmentOf(value: string | null | undefined): "UAT" | "PRODUCTION" {
  return value === "PRODUCTION" ? "PRODUCTION" : "UAT";
}

function statusOf(value: string | null | undefined): IndiaPostSettings["status"] {
  if (value === "CONNECTED" || value === "FAILED") return value;
  return "DISCONNECTED";
}

async function audit(
  shopId: string,
  action: string,
  detail: Record<string, string | number | boolean | null>,
) {
  const { error } = await getSupabase().from("audit_logs").insert({
    shop_id: shopId,
    action,
    entity_type: "india_post_connection",
    detail,
  });
  if (error) {
    logError("india post audit failed", { shop_id: shopId, event: action, result: "error" });
  }
}

async function connectionForShop(shopId: string): Promise<ConnectionRecord | null> {
  const { data, error } = await getSupabase()
    .from("india_post_connections")
    .select(
      "shop_id, encrypted_username, encrypted_password, encrypted_access_token, token_expires_at, bulk_customer_id, environment, office_id, status, last_error, drop_office_name, drop_office_pincode",
    )
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw new Error("India Post configuration could not be loaded");
  return (data as ConnectionRecord | null) ?? null;
}

export async function loadIndiaPostSettings(shopId: string): Promise<IndiaPostSettings> {
  const [connectionResult, contractResult, rangeResult] = await Promise.all([
    getSupabase()
      .from("india_post_connections")
      .select(
        "environment, status, bulk_customer_id, encrypted_password, last_error, office_id, drop_office_name, drop_office_pincode",
      )
      .eq("shop_id", shopId)
      .maybeSingle(),
    getSupabase()
      .from("india_post_contracts")
      .select("service_code, contract_id")
      .eq("shop_id", shopId)
      .in("service_code", [SPEED_POST, BUSINESS_PARCELS]),
    getSupabase()
      .from("barcode_ranges")
      .select("prefix, start_number, end_number, next_number")
      .eq("shop_id", shopId)
      .is("service_code", null)
      .eq("active", true)
      .maybeSingle(),
  ]);
  const loadError = connectionResult.error ?? contractResult.error ?? rangeResult.error;
  if (loadError) {
    logError("india post settings load failed", {
      shop_id: shopId,
      event: "settings_load",
      result: "error",
      error: loadError.message.slice(0, 200),
    });
    throw new Error("India Post configuration could not be loaded");
  }
  const connection = connectionResult.data as {
    environment: string;
    status: string;
    bulk_customer_id: string | null;
    encrypted_password: string | null;
    last_error: string | null;
    office_id: string | null;
    drop_office_name: string | null;
    drop_office_pincode: string | null;
  } | null;
  const contracts = (contractResult.data ?? []) as { service_code: string; contract_id: string }[];
  const range = rangeResult.data as {
    prefix: string;
    start_number: number | string;
    end_number: number | string;
    next_number: number | string;
  } | null;
  const startNumber = range ? asNumber(range.start_number) : 0;
  const endNumber = range ? asNumber(range.end_number) : 0;
  const nextNumber = range ? asNumber(range.next_number) : 0;
  return {
    status: statusOf(connection?.status),
    environment: environmentOf(connection?.environment),
    hasPassword: Boolean(connection?.encrypted_password),
    bulkCustomerId: connection?.bulk_customer_id ?? "",
    lastError: connection?.status === "FAILED" ? connection.last_error : null,
    speedPostContractId: contracts.find((row) => row.service_code === SPEED_POST)?.contract_id ?? "",
    businessParcelsContractId:
      contracts.find((row) => row.service_code === BUSINESS_PARCELS)?.contract_id ?? "",
    barcode: range
      ? {
          prefix: range.prefix,
          startNumber,
          endNumber,
          nextNumber,
          available: endNumber - startNumber + 1,
          remaining: remainingBarcodeCount(endNumber, nextNumber),
        }
      : null,
    dropOffice: connection?.office_id
      ? {
          id: connection.office_id,
          name: connection.drop_office_name ?? "",
          pincode: connection.drop_office_pincode ?? "",
        }
      : null,
  };
}

function parseContract(value: string): { ok: true; id: string | null } | { ok: false } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, id: null };
  if (!/^\d{8}$/.test(trimmed)) return { ok: false };
  return { ok: true, id: trimmed };
}

export async function connectIndiaPost(
  shopId: string,
  input: {
    environment: "UAT" | "PRODUCTION";
    username: string;
    password: string;
    bulkCustomerId: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const username = input.username.trim();
  const password = input.password;
  const bulkCustomerId = input.bulkCustomerId.trim();
  if (!username || !password.trim()) {
    return { ok: false, error: "Username and password are required" };
  }
  if (bulkCustomerId && !/^\d{10}$/.test(bulkCustomerId)) {
    return { ok: false, error: "Bulk customer id must be 10 digits" };
  }
  logInfo("india post connection attempt", {
    shop_id: shopId,
    event: "india_post_connect_attempt",
    environment: input.environment,
  });
  await audit(shopId, "india_post_connect_attempt", { environment: input.environment });

  const existing = await connectionForShop(shopId);
  if (!existing) {
    const { error } = await getSupabase().from("india_post_connections").insert({
      shop_id: shopId,
      environment: input.environment,
      status: "DISCONNECTED",
      bulk_customer_id: bulkCustomerId || null,
    });
    if (error) return { ok: false, error: CONNECT_FAILURE };
  }

  try {
    await connectWithCredentials({
      shop_id: shopId,
      encrypted_username: encryptSecret(username),
      encrypted_password: encryptSecret(password),
      encrypted_access_token: null,
      token_expires_at: null,
      bulk_customer_id: bulkCustomerId || existing?.bulk_customer_id || null,
      environment: input.environment,
      office_id: existing?.office_id ?? null,
      status: existing?.status ?? "DISCONNECTED",
    });
    const { error } = await getSupabase()
      .from("india_post_connections")
      .update({
        encrypted_username: encryptSecret(username),
        encrypted_password: encryptSecret(password),
        environment: input.environment,
        bulk_customer_id: bulkCustomerId || null,
        status: "CONNECTED",
        last_error: null,
      })
      .eq("shop_id", shopId);
    if (error) return { ok: false, error: CONNECT_FAILURE };
    logInfo("india post connection success", {
      shop_id: shopId,
      event: "india_post_connect_success",
      environment: input.environment,
      result: "ok",
    });
    await audit(shopId, "india_post_connect_success", { environment: input.environment });
    return { ok: true };
  } catch (error) {
    await getSupabase()
      .from("india_post_connections")
      .update({
        status: "FAILED",
        last_error: CONNECT_FAILURE,
        encrypted_access_token: null,
        encrypted_refresh_token: null,
        token_expires_at: null,
      })
      .eq("shop_id", shopId);
    logInfo("india post connection failure", {
      shop_id: shopId,
      event: "india_post_connect_failure",
      environment: input.environment,
      result: error instanceof CeptError ? error.errorClass : "error",
    });
    await audit(shopId, "india_post_connect_failure", { environment: input.environment });
    return { ok: false, error: CONNECT_FAILURE };
  }
}

export async function saveIndiaPostContracts(
  shopId: string,
  input: { speedPostContractId: string; businessParcelsContractId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const speed = parseContract(input.speedPostContractId);
  const parcels = parseContract(input.businessParcelsContractId);
  if (!speed.ok || !parcels.ok) {
    return { ok: false, error: "Contract id must be 8 digits" };
  }
  const saved = await Promise.all([
    writeContract(shopId, SPEED_POST, speed.id),
    writeContract(shopId, BUSINESS_PARCELS, parcels.id),
  ]);
  if (saved.some((result) => !result)) {
    return { ok: false, error: "Contract ids could not be saved" };
  }
  logInfo("india post configuration updated", {
    shop_id: shopId,
    event: "india_post_config_updated",
    result: "ok",
  });
  await audit(shopId, "india_post_config_updated", {
    speed_post: Boolean(speed.id),
    business_parcels: Boolean(parcels.id),
  });
  return { ok: true };
}

async function writeContract(shopId: string, serviceCode: string, contractId: string | null) {
  if (!contractId) {
    const { error } = await getSupabase()
      .from("india_post_contracts")
      .delete()
      .eq("shop_id", shopId)
      .eq("service_code", serviceCode);
    return !error;
  }
  const { error } = await getSupabase().from("india_post_contracts").upsert(
    {
      shop_id: shopId,
      service_code: serviceCode,
      contract_id: contractId,
      is_default: true,
    },
    { onConflict: "shop_id,service_code" },
  );
  return !error;
}

export function inspectBarcodeRange(input: {
  prefix: string;
  startNumber: number;
  endNumber: number;
  environment: "UAT" | "PRODUCTION";
}): { ok: true; prefix: string; available: number } | { ok: false; error: string } {
  const checked = validateBarcodeRange(input);
  if (!checked.ok) {
    return { ok: false, error: checked.issues.map(barcodeIssueMessage).join(". ") };
  }
  return { ok: true, prefix: checked.prefix, available: checked.available };
}

export async function saveBarcodeConfiguration(
  shopId: string,
  input: {
    prefix: string;
    startNumber: number;
    endNumber: number;
    environment: "UAT" | "PRODUCTION";
  },
): Promise<{ ok: true; available: number; remaining: number } | { ok: false; error: string }> {
  const checked = inspectBarcodeRange(input);
  if (!checked.ok) return checked;
  const { data, error } = await getSupabase()
    .from("barcode_ranges")
    .select("id, prefix, start_number, end_number, next_number, service_code, active")
    .eq("shop_id", shopId);
  if (error) return { ok: false, error: "Barcode configuration could not be saved" };
  const ranges = (data ?? []) as RangeRecord[];
  const shared = ranges.find((range) => range.active && range.service_code == null) ?? null;
  const overlapping = ranges.some(
    (range) =>
      range.id !== shared?.id &&
      range.prefix === checked.prefix &&
      rangesOverlap(
        input.startNumber,
        input.endNumber,
        asNumber(range.start_number),
        asNumber(range.end_number),
      ),
  );
  if (overlapping) {
    return { ok: false, error: "This range overlaps an existing barcode range" };
  }

  const rangeIds = ranges.filter((range) => range.prefix === checked.prefix).map((range) => range.id);
  const { data: allocationData, error: allocationError } = await getSupabase()
    .from("barcode_allocations")
    .select("serial, range_id")
    .eq("shop_id", shopId);
  if (allocationError) return { ok: false, error: "Barcode configuration could not be saved" };
  const allocations = ((allocationData ?? []) as { serial: number | string; range_id: string }[]).filter(
    (row) => rangeIds.includes(row.range_id) || row.range_id === shared?.id,
  );
  const inWindow = (serial: number) => serial >= input.startNumber && serial <= input.endNumber;
  const foreignHit = allocations.some(
    (row) => row.range_id !== shared?.id && inWindow(asNumber(row.serial)),
  );
  if (foreignHit) {
    return { ok: false, error: "This range includes previously allocated barcodes" };
  }

  if (shared && (shared.prefix !== checked.prefix || asNumber(shared.start_number) !== input.startNumber)) {
    const ownAllocated = allocations.some((row) => row.range_id === shared.id);
    if (ownAllocated) {
      return { ok: false, error: "This range includes previously allocated barcodes" };
    }
  }

  if (
    shared &&
    shared.prefix === checked.prefix &&
    asNumber(shared.start_number) === input.startNumber &&
    input.endNumber < asNumber(shared.next_number) - 1
  ) {
    return { ok: false, error: "Range end is below the next unused serial" };
  }

  const sameWindow =
    shared !== null &&
    shared.prefix === checked.prefix &&
    asNumber(shared.start_number) === input.startNumber;
  const write =
    shared && sameWindow
      ? getSupabase()
          .from("barcode_ranges")
          .update({ end_number: input.endNumber })
          .eq("shop_id", shopId)
          .eq("id", shared.id)
      : shared
        ? getSupabase()
            .from("barcode_ranges")
            .update({
              prefix: checked.prefix,
              suffix: "IN",
              start_number: input.startNumber,
              end_number: input.endNumber,
              next_number: input.startNumber,
            })
            .eq("shop_id", shopId)
            .eq("id", shared.id)
        : getSupabase().from("barcode_ranges").insert({
            shop_id: shopId,
            prefix: checked.prefix,
            suffix: "IN",
            start_number: input.startNumber,
            end_number: input.endNumber,
            next_number: input.startNumber,
            service_code: null,
            active: true,
          });
  const { error: writeError } = await write;
  if (writeError) {
    logError("barcode configuration save failed", {
      shop_id: shopId,
      event: "barcode_config_updated",
      result: "error",
      error: writeError.message.slice(0, 200),
    });
    if (writeError.code === "23P01") {
      return { ok: false, error: "This range overlaps an existing barcode range" };
    }
    return { ok: false, error: "Barcode configuration could not be saved" };
  }
  const nextNumber = shared && sameWindow ? asNumber(shared.next_number) : input.startNumber;
  logInfo("barcode configuration updated", {
    shop_id: shopId,
    event: "barcode_config_updated",
    result: "ok",
  });
  await audit(shopId, "barcode_config_updated", {
    prefix: checked.prefix,
    start_number: input.startNumber,
    end_number: input.endNumber,
  });
  return {
    ok: true,
    available: checked.available,
    remaining: remainingBarcodeCount(input.endNumber, nextNumber),
  };
}

export async function searchOfficesForShop(
  shopId: string,
  pincode: string,
): Promise<{ ok: true; offices: DropOffice[] } | { ok: false; error: string }> {
  const pin = pincode.trim();
  if (!/^\d{6}$/.test(pin)) return { ok: false, error: "Pincode must be 6 digits" };
  const connection = await connectionForShop(shopId);
  if (!connection || connection.status !== "CONNECTED") {
    return { ok: false, error: "Connect to India Post before searching for a drop office." };
  }
  try {
    const offices = await searchDropOffices(connection, pin);
    return { ok: true, offices };
  } catch (error) {
    logError("drop office search failed", {
      shop_id: shopId,
      event: "drop_office_search",
      result: error instanceof CeptError ? error.errorClass : "error",
    });
    return { ok: false, error: "Drop office search failed. Check the pincode and try again." };
  }
}

export async function saveDropOffice(
  shopId: string,
  input: { officeId: string; pincode?: string; officeName?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const officeId = input.officeId.trim();
  const pin = (input.pincode ?? "").trim();
  if (!/^\d{8}$/.test(officeId)) return { ok: false, error: "Office ID must be 8 digits" };
  if (pin && !/^\d{6}$/.test(pin)) return { ok: false, error: "Pincode must be 6 digits" };

  let officeName = (input.officeName ?? "").trim();
  if (pin && !officeName) {
    const found = await searchOfficesForShop(shopId, pin);
    const match = found.ok ? found.offices.find((row) => row.officeId === officeId) : undefined;
    if (match) officeName = match.officeName;
  }

  const existing = await connectionForShop(shopId);
  const payload = {
    office_id: officeId,
    drop_office_name: officeName || null,
    drop_office_pincode: pin || existing?.drop_office_pincode || null,
  };
  const { error } = existing
    ? await getSupabase().from("india_post_connections").update(payload).eq("shop_id", shopId)
    : await getSupabase().from("india_post_connections").insert({
        shop_id: shopId,
        environment: "UAT",
        status: "DISCONNECTED",
        ...payload,
      });
  if (error) return { ok: false, error: "Drop office could not be saved" };
  const { error: settingsError } = await getSupabase().from("shop_settings").upsert(
    { shop_id: shopId, drop_off_office_id: officeId },
    { onConflict: "shop_id" },
  );
  if (settingsError) return { ok: false, error: "Drop office could not be saved" };
  logInfo("drop office selected", {
    shop_id: shopId,
    event: "drop_office_selected",
    office_id: officeId,
    result: "ok",
  });
  await audit(shopId, "drop_office_selected", { office_id: officeId, pincode: pin || null });
  return { ok: true };
}
