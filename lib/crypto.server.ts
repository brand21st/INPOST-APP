import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "v1";

function encryptionKey(): Buffer {
  const raw = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("INTEGRATION_ENCRYPTION_KEY is required");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("INTEGRATION_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(payload: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(":");
  if (version !== PREFIX || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Encrypted value is not in the expected format");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function encryptOptional(value: string | null | undefined): string | null {
  if (!value) return null;
  return encryptSecret(value);
}

export function decryptOptional(value: string | null | undefined): string | null {
  if (!value) return null;
  return decryptSecret(value);
}
