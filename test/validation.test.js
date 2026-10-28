const test = require("node:test");
const assert = require("node:assert/strict");
const { validDate, validDateRange, createQrToken, hashQrToken, qrProductDetails, escapeHtml } = require("../server");

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


test("validDateRange requires valid ISO dates in chronological order", () => {
  assert.equal(validDateRange("2026-01-01", "2026-12-31"), true);
  assert.equal(validDateRange("2026-02-30", "2026-12-31"), false);
  assert.equal(validDateRange("2026-12-31", "2026-01-01"), false);
  assert.equal(validDateRange("", "2026-12-31"), false);
});

test("QR tokens use random base64url values and deterministic SHA-256 hashes", () => {
  const a = createQrToken();
  const b = createQrToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.match(hashQrToken(a), /^[a-f0-9]{64}$/);
  assert.equal(hashQrToken(a), hashQrToken(a));
  assert.notEqual(hashQrToken(a), hashQrToken(b));
});

test("public QR product details omit unit cost and internal inventory controls", () => {
  const details = qrProductDetails({
    shop_name: "Corner Shop", name: "Milk", sku: "MILK-1",
    category: "Grocery", unit: "bottle", stock: "12.000",
    selling_price: "32.50", unit_cost: "20.00", reorder_at: "5",
    expiry_date: "2026-11-01"
  });
  assert.deepEqual(details, {
    shopName: "Corner Shop", name: "Milk", sku: "MILK-1",
    category: "Grocery", unit: "bottle", stock: 12,
    price: 32.5, expiry: "2026-11-01"
  });
  assert.equal("unit_cost" in details, false);
  assert.equal("cost" in details, false);
});

test("scan-page HTML escaping blocks product-name markup injection", () => {
  assert.equal(escapeHtml('<script "x">'), "&lt;script &quot;x&quot;&gt;");
});
