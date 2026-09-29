import assert from "node:assert/strict";
import test from "node:test";
import {
  availableBarcodeCount,
  barcodeIssueMessage,
  rangesOverlap,
  remainingBarcodeCount,
  validateBarcodeRange,
} from "./barcode.ts";
import { eligibleDropOffices, readLoginTokens } from "./client.server.ts";
import { inspectBarcodeRange } from "./settings.server.ts";

test("available barcode count is inclusive", () => {
  assert.equal(availableBarcodeCount(55697399, 55697999), 601);
  assert.equal(remainingBarcodeCount(55697999, 55697400), 600);
  assert.equal(remainingBarcodeCount(10, 11), 0);
});

test("barcode range rejects a missing or invalid prefix", () => {
  const missing = validateBarcodeRange({
    prefix: "  ",
    startNumber: 55697399,
    endNumber: 55697999,
    environment: "UAT",
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(barcodeIssueMessage(missing.issues[0]), "Prefix is required");

  const invalid = validateBarcodeRange({
    prefix: "XXXX",
    startNumber: 55697399,
    endNumber: 55697999,
    environment: "UAT",
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.ok(invalid.issues.includes("INVALID_PREFIX"));
});

test("barcode range rejects invalid serials and a reversed window", () => {
  const start = inspectBarcodeRange({
    prefix: "EB",
    startNumber: Number.NaN,
    endNumber: 10,
    environment: "UAT",
  });
  assert.equal(start.ok, false);
  if (!start.ok) assert.match(start.error, /Invalid start number/);

  const end = inspectBarcodeRange({
    prefix: "EB",
    startNumber: 10,
    endNumber: 100_000_000,
    environment: "UAT",
  });
  assert.equal(end.ok, false);
  if (!end.ok) assert.match(end.error, /Invalid end number/);

  const reversed = inspectBarcodeRange({
    prefix: "eb",
    startNumber: 20,
    endNumber: 10,
    environment: "UAT",
  });
  assert.equal(reversed.ok, false);
  if (!reversed.ok) assert.match(reversed.error, /Start is after the end/);
});

test("production rejects the India Post UAT test series", () => {
  const blocked = validateBarcodeRange({
    prefix: "ET",
    startNumber: 21433001,
    endNumber: 21434000,
    environment: "PRODUCTION",
  });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.ok(blocked.issues.includes("UAT_SERIES_IN_PRODUCTION"));

  const allowed = validateBarcodeRange({
    prefix: "ET",
    startNumber: 21433001,
    endNumber: 21434000,
    environment: "UAT",
  });
  assert.equal(allowed.ok, true);
  if (allowed.ok) assert.equal(allowed.available, 1000);
});

test("overlapping ranges are detected for the same prefix window", () => {
  assert.equal(rangesOverlap(10, 20, 20, 30), true);
  assert.equal(rangesOverlap(10, 19, 20, 30), false);
  assert.equal(rangesOverlap(55697399, 55697999, 55697999, 55698000), true);
});

test("login tokens are read from the documented data wrapper", () => {
  const tokens = readLoginTokens({
    success: true,
    data: { access_token: "access", refresh_token: "refresh", expires_in: 120 },
  });
  assert.deepEqual(tokens, { accessToken: "access", refreshToken: "refresh", expiresIn: 120 });
  assert.equal(readLoginTokens({ success: false, data: { access_token: "access" } }), null);
  assert.equal(readLoginTokens({ success: true, data: {} }), null);
});

test("drop offices accept the documented list and a data wrapper", () => {
  const wrapped = eligibleDropOffices({
    success: true,
    data: [
      {
        pincode: 570001,
        office_name: "Mysuru H.O",
        office_id: 21360043,
        office_type_code: "HPO",
        delivery_office_flag: "true",
        state_name: "Karnataka",
        city_name: "MYSURU",
        is_rolled_out: true,
      },
    ],
  });
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0]?.officeId, "21360043");
});

test("drop offices keep delivery offices that are not BPO", () => {
  const offices = eligibleDropOffices([
    {
      pincode: 570001,
      office_name: "Branch",
      office_id: "21661267",
      office_type_code: "BPO",
      delivery_office_flag: true,
      state_name: "Karnataka",
      city_name: "MYSURU",
      is_rolled_out: true,
    },
    {
      pincode: 570001,
      office_name: "Not delivery",
      office_id: "21661273",
      office_type_code: "SPO",
      delivery_office_flag: false,
      state_name: "Karnataka",
      city_name: "MYSURU",
      is_rolled_out: true,
    },
    {
      pincode: 570001,
      office_name: "Mysuru H.O",
      office_id: "21360043",
      office_type_code: "HPO",
      delivery_office_flag: true,
      state_name: "Karnataka",
      city_name: "MYSURU",
      is_rolled_out: true,
    },
  ]);
  assert.equal(offices.length, 1);
  assert.equal(offices[0]?.officeId, "21360043");
  assert.equal(offices[0]?.officeName, "Mysuru H.O");
});
