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

export function indiaPostPublicTrackingUrl(barcode: string, template?: string): string {
  const pattern =
    template ?? "https://www.indiapost.gov.in/track-result/article-number/{barcode}";
  return pattern.replaceAll("{barcode}", encodeURIComponent(barcode));
}
