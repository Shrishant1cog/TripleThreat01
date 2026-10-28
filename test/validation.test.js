const test = require("node:test");
const assert = require("node:assert/strict");
const { validDate, validDateRange, dateOnly, isBeforeDate, createQrToken, hashQrToken, isLoopbackHostname, resolvePublicOrigin, qrProductDetails, escapeHtml, generateDemoProduct, publicCustomerProduct } = require("../server");

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


test("random demo product templates contain plausible inventory fields", () => {
  for (let i = 0; i < 30; i++) {
    const p = generateDemoProduct();
    assert.match(p.sku, /^DEMO-[A-F0-9]{6}$/);
    assert.ok(p.stock >= 6 && p.stock <= 50);
    assert.ok(p.reorderAt >= 3 && p.reorderAt <= 10);
    assert.ok(p.cost > 0 && p.price >= p.cost);
    assert.ok(p.leadTimeDays >= 1 && p.leadTimeDays <= 7);
    assert.equal(p.isDemo, true);
    if (p.expiry) assert.equal(validDate(p.expiry), true);
  }
});

test("QR origins never use a loopback address that a phone cannot reach", () => {
  for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.0.0.2", "::1", "[::1]", "0.0.0.0", "shop.localhost"]) {
    assert.equal(isLoopbackHostname(host), true, host);
  }
  for (const host of ["10.43.232.32", "192.168.1.20", "easy-gateway.onrender.com", "172.16.4.9"]) {
    assert.equal(isLoopbackHostname(host), false, host);
  }
  const localRequest = { protocol: "http", get: name => name === "host" ? "localhost:3000" : "" };
  assert.throws(() => resolvePublicOrigin(localRequest, {}), /PUBLIC_APP_URL|phone cannot open/i);
  assert.throws(() => resolvePublicOrigin(localRequest, { PUBLIC_APP_URL: "http://127.0.0.1:3000" }), /PUBLIC_APP_URL|phone cannot open/i);
});

test("QR origins prefer PUBLIC_APP_URL and fall back to the request host", () => {
  const request = { protocol: "http", get: name => name === "host" ? "10.43.232.32:3000" : "" };
  assert.equal(resolvePublicOrigin(request, {}), "http://10.43.232.32:3000");
  assert.equal(resolvePublicOrigin(request, { PUBLIC_APP_URL: "http://10.43.232.32:3000/" }), "http://10.43.232.32:3000");
  assert.equal(resolvePublicOrigin(request, { PUBLIC_APP_URL: "https://shop.example.test" }), "https://shop.example.test");
  assert.throws(() => resolvePublicOrigin(request, { PUBLIC_APP_URL: "not a url" }), /valid URL/i);
});

test("public customer catalogue DTO excludes internal unit cost and exact stock", () => {
  const product = publicCustomerProduct({id:"p1",name:"Rice",sku:"RICE1",category:"Grocery",unit:"bag",stock:"8",selling_price:"95.50",unit_cost:"75"});
  assert.deepEqual(product, {id:"p1",name:"Rice",sku:"RICE1",category:"Grocery",unit:"bag",price:95.5,available:true});
  assert.equal("cost" in product, false);
  assert.equal("stock" in product, false);
});

test("dateOnly keeps the calendar day for pg DATE objects in any server timezone", () => {
  assert.equal(dateOnly(new Date(2026, 9, 28)), "2026-10-28");
  assert.equal(dateOnly(new Date(2024, 1, 29)), "2024-02-29");
  assert.equal(dateOnly("2026-10-28"), "2026-10-28");
  assert.equal(dateOnly("2026-10-28T00:00:00.000Z"), "2026-10-28");
  assert.equal(dateOnly(null), "");
  assert.equal(dateOnly(""), "");
});

test("restore date comparison accepts future dates and blocks past dates", () => {
  // Regression: String(pgDate).slice(0,10) produced "Wed Oct 28", which made
  // every ISO expiry date look earlier than today.
  const today = new Date(2026, 9, 28);
  assert.equal(isBeforeDate("2026-10-27", today), true);
  assert.equal(isBeforeDate("2026-10-28", today), false);
  assert.equal(isBeforeDate("2026-11-01", today), false);
  assert.equal(isBeforeDate(new Date(2026, 9, 27), today), true);
  assert.equal(isBeforeDate(new Date(2026, 10, 1), today), false);
});
