import assert from "node:assert/strict";
import test from "node:test";
import { formatS10, isCeptUatTestSeries, s10CheckDigit } from "./barcode.ts";

test("S10 check digit uses UPU weights", () => {
  assert.equal(s10CheckDigit(12345678), 5);
  assert.equal(formatS10("EE", 12345678), "EE123456785IN");
  assert.equal(s10CheckDigit(47312482), 9);
  assert.equal(formatS10("EK", 47312482), "EK473124829IN");
});

test("production rejects the CEPT UAT serial window", () => {
  assert.equal(isCeptUatTestSeries(21433001), true);
  assert.equal(isCeptUatTestSeries(21434000), true);
  assert.equal(isCeptUatTestSeries(21433000), false);
  assert.equal(isCeptUatTestSeries(21434001), false);
});
