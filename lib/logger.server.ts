type LogFields = Record<string, string | number | boolean | null | undefined>;

const SECRET_KEY = /token|secret|password|authorization/i;
const SECRET_VALUE = /shpat_|shpss_|eyJ/;

export function sanitizeLogFields(fields: LogFields): LogFields {
  const safe: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY.test(key)) continue;
    if (typeof value === "string" && SECRET_VALUE.test(value)) continue;
    safe[key] = value;
  }
  return safe;
}

export function logInfo(message: string, fields: LogFields = {}) {
  console.log(JSON.stringify({ level: "info", message, ...sanitizeLogFields(fields) }));
}

export function logError(message: string, fields: LogFields = {}) {
  console.error(JSON.stringify({ level: "error", message, ...sanitizeLogFields(fields) }));
}
