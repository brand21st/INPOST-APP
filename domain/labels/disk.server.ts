import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

let testRoot: string | undefined;

export function setLabelStorageDirForTests(directory: string | undefined) {
  testRoot = directory;
}

export function labelStorageRoot() {
  const configured = testRoot ?? process.env.LABEL_STORAGE_DIR?.trim();
  if (!configured) throw new Error("Label storage is not configured");
  return path.resolve(configured);
}

export function labelStorageKey(shopId: string, shipmentId: string) {
  return `${shopId}/${shipmentId}.pdf`;
}

export function resolveLabelPath(shopId: string, storageKey: string) {
  const root = labelStorageRoot();
  const relative = storageKey.replaceAll("\\", "/");
  if (relative.includes("..") || relative.startsWith("/") || !relative.startsWith(`${shopId}/`)) {
    throw new Error("Label path is not valid");
  }
  const resolved = path.resolve(root, relative);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error("Label path is not valid");
  }
  return resolved;
}

export async function writeLabelPdf(shopId: string, shipmentId: string, pdf: Buffer | Uint8Array) {
  const key = labelStorageKey(shopId, shipmentId);
  const filePath = resolveLabelPath(shopId, key);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, pdf);
  return key;
}

export async function readLabelFile(shopId: string, storageKey: string) {
  const filePath = resolveLabelPath(shopId, storageKey);
  return new Uint8Array(await readFile(filePath));
}
