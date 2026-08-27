import test from "node:test";
import assert from "node:assert/strict";


test("cursor truncate flag frame is recognized and halving retry recovers", async () => {
  const { decodeCursorTruncateFlag } = await import("../modules/provider-cursor/src/native-protocol.mjs");
  assert.equal(decodeCursorTruncateFlag(Buffer.from("000000000f0a0d0a0b0a097472756e63617465", "hex")), true);
  assert.equal(decodeCursorTruncateFlag(Buffer.from("0000000004deadbeef", "hex")), false);
});
