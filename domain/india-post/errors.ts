export const PERMANENT_ERROR_CLASSES = [
  "VALIDATION_ERROR",
  "INVALID_BARCODE",
  "INVALID_CONTRACT",
  "PERMANENT_AUTH_ERROR",
  "BARCODE_RANGE_EXHAUSTED",
] as const;

export type ErrorClass = (typeof PERMANENT_ERROR_CLASSES)[number] | "RETRYABLE";

const RETRY_DELAYS_SECONDS = [60, 300, 900, 1800];
export const MAX_JOB_ATTEMPTS = 5;

export function classifyCeptFailure(status: number, body: string): ErrorClass {
  const text = body.toLowerCase();
  if (status === 401 || status === 403) return "PERMANENT_AUTH_ERROR";
  if (text.includes("invalid barcode")) return "INVALID_BARCODE";
  if (text.includes("contract")) return "INVALID_CONTRACT";
  if (status === 400 || status === 422) return "VALIDATION_ERROR";
  return "RETRYABLE";
}

export function isPermanent(errorClass: string): boolean {
  return (PERMANENT_ERROR_CLASSES as readonly string[]).includes(errorClass);
}

export function retryDelaySeconds(attempt: number): number | null {
  if (attempt >= MAX_JOB_ATTEMPTS) return null;
  return RETRY_DELAYS_SECONDS[Math.min(attempt, RETRY_DELAYS_SECONDS.length - 1)] ?? null;
}
