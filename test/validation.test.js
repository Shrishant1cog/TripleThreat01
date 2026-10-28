const test = require("node:test");
const assert = require("node:assert/strict");
const { validDate } = require("../server");

test("validDate accepts real ISO calendar dates", () => {
  assert.equal(validDate("2026-10-28"), true);
  assert.equal(validDate("2024-02-29"), true);
});

test("validDate rejects invalid and impossible dates", () => {
  assert.equal(validDate("2025-02-29"), false);
  assert.equal(validDate("2026-13-01"), false);
  assert.equal(validDate("2026-04-31"), false);
  assert.equal(validDate("28-10-2026"), false);
  assert.equal(validDate(""), false);
});
