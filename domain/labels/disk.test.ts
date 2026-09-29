import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { readLabelFile, resolveLabelPath, setLabelStorageDirForTests, writeLabelPdf } from "./disk.server.ts";

test("label files stay under the shop folder on disk", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inpost-labels-"));
  setLabelStorageDirForTests(root);
  try {
    const key = await writeLabelPdf("shop-a", "ship-1", Buffer.from("%PDF-1.4 test"));
    assert.equal(key, "shop-a/ship-1.pdf");
    const bytes = await readLabelFile("shop-a", key);
    assert.equal(Buffer.from(bytes).toString().includes("%PDF"), true);
    assert.throws(() => resolveLabelPath("shop-a", "../shop-b/secret.pdf"));
    assert.throws(() => resolveLabelPath("shop-a", "shop-b/ship-1.pdf"));
  } finally {
    setLabelStorageDirForTests(undefined);
    await rm(root, { recursive: true, force: true });
  }
});
