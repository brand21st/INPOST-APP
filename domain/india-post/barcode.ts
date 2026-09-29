const WEIGHTS = [8, 6, 4, 2, 3, 5, 9, 7] as const;

const UAT_SERIAL_START = 21433001;
const UAT_SERIAL_END = 21434000;

export function s10CheckDigit(serial: number): number {
  const digits = String(serial).padStart(8, "0");
  if (!/^\d{8}$/.test(digits)) {
    throw new Error("INVALID_BARCODE");
  }
  let total = 0;
  for (let index = 0; index < 8; index += 1) {
    total += Number(digits[index]) * WEIGHTS[index];
  }
  const check = 11 - (total % 11);
  if (check === 11) return 5;
  if (check === 10) return 0;
  return check;
}

export function formatS10(prefix: string, serial: number, suffix = "IN"): string {
  if (!/^[A-Z]{2}$/.test(prefix)) {
    throw new Error("INVALID_BARCODE");
  }
  return `${prefix}${String(serial).padStart(8, "0")}${s10CheckDigit(serial)}${suffix}`;
}

export function isCeptUatTestSeries(serial: number): boolean {
  return serial >= UAT_SERIAL_START && serial <= UAT_SERIAL_END;
}

export function rangeIntersectsUatSeries(start: number, end: number): boolean {
  return start <= UAT_SERIAL_END && end >= UAT_SERIAL_START;
}

export function availableBarcodeCount(start: number, end: number): number {
  return end - start + 1;
}

export function remainingBarcodeCount(endNumber: number, nextNumber: number): number {
  const remaining = endNumber - nextNumber + 1;
  return remaining > 0 ? remaining : 0;
}

export function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA <= endB && startB <= endA;
}

export type BarcodeRangeIssue =
  | "MISSING_PREFIX"
  | "INVALID_PREFIX"
  | "INVALID_START"
  | "INVALID_END"
  | "START_AFTER_END"
  | "UAT_SERIES_IN_PRODUCTION";

const SERIAL_MIN = 1;
const SERIAL_MAX = 99_999_999;

function validSerial(value: number): boolean {
  return Number.isInteger(value) && value >= SERIAL_MIN && value <= SERIAL_MAX;
}

export function validateBarcodeRange(input: {
  prefix: string;
  startNumber: number;
  endNumber: number;
  environment: "UAT" | "PRODUCTION";
}):
  | { ok: true; prefix: string; available: number }
  | { ok: false; issues: BarcodeRangeIssue[] } {
  const issues: BarcodeRangeIssue[] = [];
  const prefix = input.prefix.trim().toUpperCase();
  if (!prefix) issues.push("MISSING_PREFIX");
  else if (!/^[A-Z]{2}$/.test(prefix)) issues.push("INVALID_PREFIX");

  const startOk = validSerial(input.startNumber);
  const endOk = validSerial(input.endNumber);
  if (!startOk) issues.push("INVALID_START");
  if (!endOk) issues.push("INVALID_END");
  if (startOk && endOk && input.startNumber > input.endNumber) issues.push("START_AFTER_END");
  if (
    startOk &&
    endOk &&
    input.startNumber <= input.endNumber &&
    input.environment === "PRODUCTION" &&
    rangeIntersectsUatSeries(input.startNumber, input.endNumber)
  ) {
    issues.push("UAT_SERIES_IN_PRODUCTION");
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    prefix,
    available: availableBarcodeCount(input.startNumber, input.endNumber),
  };
}

export function barcodeIssueMessage(issue: BarcodeRangeIssue): string {
  switch (issue) {
    case "MISSING_PREFIX":
      return "Prefix is required";
    case "INVALID_PREFIX":
      return "Prefix must be two letters";
    case "INVALID_START":
      return "Invalid start number";
    case "INVALID_END":
      return "Invalid end number";
    case "START_AFTER_END":
      return "Start is after the end";
    case "UAT_SERIES_IN_PRODUCTION":
      return "This range includes the India Post UAT test series";
    default: {
      const unreachable: never = issue;
      return unreachable;
    }
  }
}

export function indiaPostPublicTrackingUrl(barcode: string, template?: string): string {
  const pattern =
    template ?? "https://www.indiapost.gov.in/track-result/article-number/{barcode}";
  return pattern.replaceAll("{barcode}", encodeURIComponent(barcode));
}
