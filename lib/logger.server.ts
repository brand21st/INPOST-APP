type LogFields = Record<string, string | number | boolean | null | undefined>;

export function logInfo(message: string, fields: LogFields = {}) {
  console.log(JSON.stringify({ level: "info", message, ...fields }));
}

export function logError(message: string, fields: LogFields = {}) {
  console.error(JSON.stringify({ level: "error", message, ...fields }));
}
