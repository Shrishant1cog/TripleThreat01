/* End-to-end API check against a running Easy Gateway server.
 *
 * Creates a disposable shop, exercises Sell / Stocking / serialised units /
 * loyalty / customer order / expiry-waste flows, then deletes the shop so no
 * test inventory remains.
 *
 * Usage:
 *   npm run test:e2e
 *   E2E_BASE=http://127.0.0.1:3100 npm run test:e2e
 *
 * Requirements: the server must already be running and .env must contain the
 * same DATABASE_URL the server uses. The script never touches existing shops.
 */
const path = require("path");
const { Pool } = require("pg");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing. Set it in .env or the environment before running test:e2e.");
  process.exit(1);
}

const BASE = (process.env.E2E_BASE || "http://127.0.0.1:3000").replace(/\/+$/, "");
const stamp = Date.now().toString(36);
const email = `e2e-${stamp}@easygateway.test`;
const password = "E2eTestPass!2026";
let cookie = "";
let shopId = "";
let failures = 0;
const results = [];
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

function check(name, condition, detail) {
  if (condition) {
    results.push(`PASS ${name}`);
  } else {
    failures++;
    results.push(`FAIL ${name}${detail ? " :: " + detail : ""}`);
  }
}

async function request(method, route, body, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  const res = await fetch(BASE + route, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const setCookieHeader = res.headers.get("set-cookie");
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : (setCookieHeader ? [setCookieHeader] : []);
  if (setCookie.length) cookie = setCookie.map((v) => v.split(";")[0]).join("; ");
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: res.status, body: json, text };
}

async function expectStatus(name, status, want) {
  check(name, status === want, `expected ${want}, got ${status}`);
}

(async () => {
  try {
    // 1. Account
    const reg = await request("POST", "/api/auth/register", {
      fullName: "E2E QA Owner",
      shopName: `E2E Shop ${stamp}`,
      email,
      password
    });
    await expectStatus("register creates a shop", reg.status, 201);
    check("register returns shop slug", !!(reg.body.user && reg.body.user.publicSlug), JSON.stringify(reg.body));
    const slug = reg.body.user && reg.body.user.publicSlug;
    shopId = (reg.body.user && reg.body.user.shopId) || "";

    // 2. Products
    const barcode = "E2E" + stamp.toUpperCase();
    const serialProduct = await request("POST", "/api/products", {
      name: "E2E Serialized Charger", sku: "SER-" + stamp, barcode,
      category: "Electronics", unit: "piece", stock: 0, reorderAt: 1,
      cost: 400, price: 12000, leadTimeDays: 2, expiry: "2027-12-31", trackSerials: true
    });
    await expectStatus("create serialized product", serialProduct.status, 201);
    const serialId = serialProduct.body.product && serialProduct.body.product.id;
    check("serialized product reports trackSerials", serialProduct.body.product && serialProduct.body.product.trackSerials === true);

    const normal = await request("POST", "/api/products", {
      name: "E2E Soap", sku: "SOAP-" + stamp, barcode: "S" + barcode,
      category: "Personal care", unit: "bar", stock: 20, reorderAt: 2,
      cost: 30, price: 45, leadTimeDays: 3, expiry: "2028-06-30"
    });
    await expectStatus("create ordinary product", normal.status, 201);
    const normalId = normal.body.product && normal.body.product.id;

    const fractional = await request("POST", "/api/products", {
      name: "Bad serial product", sku: "BAD-" + stamp, stock: 1.5, trackSerials: true, price: 10, cost: 5
    });
    await expectStatus("serialized product rejects fractional opening stock", fractional.status, 400);

    // 3. Alternate identifier lookup
    const alt = "ALT-" + stamp.toUpperCase();
    const idAdd = await request("POST", `/api/products/${serialId}/identifiers`, { kind: "barcode", value: alt });
    await expectStatus("add alternate barcode identifier", idAdd.status, 201);
    const lookup = await request("GET", `/api/products/lookup?code=${encodeURIComponent(alt)}`);
    await expectStatus("lookup by alternate identifier", lookup.status, 200);
    check("lookup returns the linked product", lookup.body.product && lookup.body.product.id === serialId);

    const openingReceipt = await request("POST", "/api/stock/receipts", {
      reference: "OPEN-" + stamp,
      items: [{ productId: serialId, quantity: 3, unitCost: 400, serials: ["E2E-S1", "E2E-S2", "E2E-S3"] }]
    });
    await expectStatus("serialized opening units are received with serials", openingReceipt.status, 201);

    // 4. Serialized sales validation
    const wrongQty = await request("POST", "/api/sales", { items: [{ productId: serialId, quantity: 2, serials: ["E2E-S1"] }] });
    await expectStatus("serialized sale rejects wrong serial count", wrongQty.status, 409);
    const duplicateInCart = await request("POST", "/api/sales", { items: [{ productId: serialId, quantity: 2, serials: ["E2E-S1", "E2E-S1"] }] });
    await expectStatus("serialized sale rejects duplicate serials in one sale", duplicateInCart.status, 409);

    const saleKey = "e2e-sale-" + stamp;
    const sale1 = await request("POST", "/api/sales", {
      items: [{ productId: serialId, quantity: 1, serials: ["E2E-S1"] }], customerName: "E2E Buyer"
    }, { idempotencyKey: saleKey });
    await expectStatus("serialized sale succeeds with one serial", sale1.status, 201);
    check("sale awards server-calculated coins", sale1.body.coinsEarned === 120, JSON.stringify(sale1.body));
    const saleReplay = await request("POST", "/api/sales", {
      items: [{ productId: serialId, quantity: 1, serials: ["E2E-S1"] }], customerName: "E2E Buyer"
    }, { idempotencyKey: saleKey });
    await expectStatus("idempotent sale replay succeeds", saleReplay.status, 201);
    check("idempotent replay returns the same sale", saleReplay.body.sale && sale1.body.sale && saleReplay.body.sale.id === sale1.body.sale.id);
    const afterReplay = await request("GET", "/api/products");
    const serialAfterReplay = afterReplay.body.products.find((p) => p.id === serialId);
    check("idempotent replay decrements stock only once", serialAfterReplay && serialAfterReplay.stock === 2, JSON.stringify(serialAfterReplay));
    const reused = await request("POST", "/api/sales", { items: [{ productId: serialId, quantity: 1, serials: ["E2E-S1"] }] });
    await expectStatus("sold serial cannot be sold again", reused.status, 409);

    // 5. Stocking receipt
    const receiptKey = "e2e-receipt-" + stamp;
    const receipt = await request("POST", "/api/stock/receipts", {
      reference: "GRN-" + stamp, note: "E2E delivery",
      items: [{ productId: serialId, quantity: 2, unitCost: 410, serials: ["E2E-S4", "E2E-S5"] }]
    }, { idempotencyKey: receiptKey });
    await expectStatus("stocking receipt adds serialized units", receipt.status, 201);
    const receiptReplay = await request("POST", "/api/stock/receipts", {
      reference: "GRN-" + stamp, note: "E2E delivery",
      items: [{ productId: serialId, quantity: 2, unitCost: 410, serials: ["E2E-S4", "E2E-S5"] }]
    }, { idempotencyKey: receiptKey });
    check("stock receipt replay returns the same receipt", receiptReplay.body.receipt && receipt.body.receipt && receiptReplay.body.receipt.id === receipt.body.receipt.id);
    const stockAfterReceipt = await request("GET", "/api/products");
    check("stock receipt increments stock once", stockAfterReceipt.body.products.find((p) => p.id === serialId).stock === 4);
    const dupReceipt = await request("POST", "/api/stock/receipts", {
      items: [{ productId: serialId, quantity: 1, serials: ["E2E-S3"] }]
    });
    await expectStatus("receipt rejects an already-recorded serial", dupReceipt.status, 409);

    // 6. Loyalty redemption
    const customers = await request("GET", "/api/customers");
    const buyer = customers.body.customers.find((c) => c.name === "E2E Buyer");
    check("named sale creates customer wallet", !!buyer && buyer.coins >= 120, JSON.stringify(buyer));
    const rewards = await request("GET", "/api/loyalty/rewards");
    check("reward catalogue is server supplied", rewards.status === 200 && rewards.body.rewards.length === 3);
    const redeemKey = "e2e-redeem-" + stamp;
    const redemption = await request("POST", "/api/loyalty/redeem", {
      customerId: buyer.id, rewardCode: "SAVE50", idempotencyKey: redeemKey
    }, { idempotencyKey: redeemKey });
    await expectStatus("redeem fixed voucher", redemption.status, 201);
    const redeemReplay = await request("POST", "/api/loyalty/redeem", {
      customerId: buyer.id, rewardCode: "SAVE50", idempotencyKey: redeemKey
    }, { idempotencyKey: redeemKey });
    check("redemption replay returns the same voucher", redeemReplay.body.redemption && redemption.body.redemption && redeemReplay.body.redemption.voucherCode === redemption.body.redemption.voucherCode);
    const customerAfter = await request("GET", "/api/customers");
    const buyerAfter = customerAfter.body.customers.find((c) => c.id === buyer.id);
    check("coins deducted exactly once", buyerAfter.coins === buyer.coins - 100, `${buyer.coins} -> ${buyerAfter.coins}`);
    const overRedeem = await request("POST", "/api/loyalty/redeem", {
      customerId: buyer.id, rewardCode: "SAVE350", idempotencyKey: "e2e-redeem2-" + stamp
    });
    await expectStatus("insufficient coins cannot be redeemed", overRedeem.status, 409);

    // 7. Customer order and status flow
    const catalog = await request("GET", `/api/customer/catalog/${encodeURIComponent(slug)}`);
    check("public catalogue hides costs", catalog.status === 200 && catalog.body.products.every((p) => p.cost === undefined));
    const phone = "+91 98765 4" + String(Date.now()).slice(-4);
    const order = await request("POST", "/api/customer/orders", {
      shopSlug: slug, name: "E2E Customer", phone, email: `customer-${stamp}@example.test`,
      address: "12 E2E Street, Test City", notes: "Leave at the counter",
      items: [{ productId: normalId, quantity: 2 }]
    });
    await expectStatus("customer order is accepted as a request", order.status, 201);
    if (order.status !== 201) results.push("DEBUG order body :: " + JSON.stringify(order.body));
    const reference = order.body.order && order.body.order.reference;
    check("order returns a reference", !!reference);
    check("order starts requested and not confirmed", order.body.order.status === "requested");
    const tracked = await request("GET", `/api/customer/orders/${encodeURIComponent(reference)}?phone=${encodeURIComponent(phone)}`);
    check("tracking by reference and phone works", tracked.status === 200 && tracked.body.order.reference === reference);
    check("tracking includes an event history", Array.isArray(tracked.body.order.events) && tracked.body.order.events.length === 1);
    const wrongPhone = await request("GET", `/api/customer/orders/${encodeURIComponent(reference)}?phone=9000000000`);
    await expectStatus("tracking rejects the wrong phone", wrongPhone.status, 404);
    const shopOrders = await request("GET", "/api/customer-orders");
    const orderId = shopOrders.body.orders.find((o) => o.reference === reference).id;
    const invalidJump = await request("PUT", `/api/customer-orders/${orderId}/status`, { status: "fulfilled" });
    await expectStatus("invalid status transition is blocked", invalidJump.status, 409);
    for (const status of ["accepted", "ready", "fulfilled"]) {
      const moved = await request("PUT", `/api/customer-orders/${orderId}/status`, { status });
      await expectStatus(`order moves to ${status}`, moved.status, 200);
    }
    const finalOrders = await request("GET", "/api/customer-orders");
    const finalOrder = finalOrders.body.orders.find((o) => o.id === orderId);
    check("order records the fulfilled state", finalOrder.status === "fulfilled");
    check("email status is truthful when no provider is configured", ["queued", "failed", "not_sent"].includes(finalOrder.emailStatus), finalOrder.emailStatus);
    const outbox = await pool.query("SELECT kind,status,dedupe_key FROM email_outbox WHERE shop_id=$1 AND dedupe_key LIKE $2 ORDER BY kind", [shopId, "order:" + orderId + ":%"]);
    check("order emails are deduplicated in the outbox", outbox.rows.length >= 1 && new Set(outbox.rows.map((r) => r.dedupe_key)).size === outbox.rows.length, JSON.stringify(outbox.rows));

    // 8. Expiry recycle bin and waste report
    const expiredSku = "EXP-" + stamp;
    const expired = await request("POST", "/api/products", {
      name: "E2E Expired Yogurt", sku: expiredSku, category: "Dairy", unit: "cup",
      stock: 4, reorderAt: 1, cost: 50, price: 70, expiry: "2026-09-15"
    });
    await expectStatus("past-expiry product is accepted then swept", expired.status, 201);
    check("past-expiry response says it was recycled", expired.body.recycledImmediately === true, JSON.stringify(expired.body));
    const bin = await request("GET", "/api/recycle-bin");
    const wasteRow = bin.body.items.find((r) => r.product && r.product.sku === expiredSku);
    check("expired product appears in the recycle bin", !!wasteRow);
    const waste = await request("POST", `/api/recycle-bin/${wasteRow.id}/waste`, {
      quantity: 3, loss: 150, method: "Disposed as general waste", note: "E2E recorded waste"
    });
    await expectStatus("record actual waste once", waste.status, 200);
    const wasteAgain = await request("POST", `/api/recycle-bin/${wasteRow.id}/waste`, { quantity: 1, method: "Retry" });
    await expectStatus("second waste record is blocked", wasteAgain.status, 409);

    // restored and deleted rows must be excluded from the report
    const restoredSku = "RES-" + stamp;
    const deletedSku = "DEL-" + stamp;
    await request("POST", "/api/products", { name: "E2E Restored", sku: restoredSku, stock: 2, cost: 10, price: 20, expiry: "2026-09-10" });
    await request("POST", "/api/products", { name: "E2E Deleted", sku: deletedSku, stock: 2, cost: 10, price: 20, expiry: "2026-09-11" });
    const bin2 = await request("GET", "/api/recycle-bin");
    const restoredRow = bin2.body.items.find((r) => r.product && r.product.sku === restoredSku);
    const deletedRow = bin2.body.items.find((r) => r.product && r.product.sku === deletedSku);
    const restored = await request("POST", `/api/recycle-bin/${restoredRow.id}/restore`, { expiryDate: "2027-12-31" });
    await expectStatus("restore with corrected future date", restored.status, 200);
    const deleted = await request("DELETE", `/api/recycle-bin/${deletedRow.id}`, {});
    await expectStatus("delete recycle-bin row", deleted.status, 200);

    const report = await request("GET", "/api/reports/expiry-waste?from=2026-09-01&to=2026-09-30");
    await expectStatus("load expiry waste report", report.status, 200);
    check("report counts only the recorded expired batch", report.body.summary.expiredRecords === 1, JSON.stringify(report.body.summary));
    check("report quantity matches the expiry snapshot", report.body.summary.quantity === 4, JSON.stringify(report.body.summary));
    check("report estimated loss is separate from recorded waste", report.body.summary.estimatedLoss === 200 && report.body.summary.recordedLoss === 150, JSON.stringify(report.body.summary));
    check("report records the actual disposed quantity", report.body.summary.recordedRecords === 1 && report.body.summary.recordedQuantity === 3, JSON.stringify(report.body.summary));
    check("monthly section uses the same range", report.body.monthly.length === 1 && report.body.monthly[0].month === "2026-09", JSON.stringify(report.body.monthly));
    check("product section carries recorded loss", report.body.products[0] && report.body.products[0].recordedLoss === 150, JSON.stringify(report.body.products));
    const emptyReport = await request("GET", "/api/reports/expiry-waste?from=2026-01-01&to=2026-01-31");
    check("report excludes dates outside the range", emptyReport.body.summary.expiredRecords === 0, JSON.stringify(emptyReport.body.summary));
    const invalidRange = await request("GET", "/api/reports/expiry-waste?from=2026-10-01&to=2026-09-01");
    await expectStatus("report rejects a reversed range", invalidRange.status, 400);

    // 9. Server-side demo isolation: no demo endpoint may touch this shop
    const countBeforeDemo = await pool.query("SELECT COUNT(*)::int AS n FROM products WHERE shop_id=$1 AND is_active=TRUE", [shopId]);
    const demoQr = await request("POST", "/api/demo-product-qr", { demoMode: true });
    await expectStatus("demo QR issue does not need shop inventory", [200, 201].includes(demoQr.status) ? 200 : demoQr.status, 200);
    const countAfterDemo = await pool.query("SELECT COUNT(*)::int AS n FROM products WHERE shop_id=$1 AND is_active=TRUE", [shopId]);
    check("demo QR creation leaves shop products untouched", countAfterDemo.rows[0].n === countBeforeDemo.rows[0].n, `${countBeforeDemo.rows[0].n} -> ${countAfterDemo.rows[0].n}`);

    // 10. Bootstrap carries the new server-authoritative fields
    const boot = await request("GET", "/api/bootstrap");
    check("bootstrap exposes loyalty redemptions", Array.isArray(boot.body.loyaltyRedemptions) && boot.body.loyaltyRedemptions.length === 1);
    check("bootstrap exposes stock receipts", Array.isArray(boot.body.stockReceipts) && boot.body.stockReceipts.length === 2);
  } catch (err) {
    failures++;
    results.push("FAIL unexpected error :: " + (err && err.stack ? err.stack : err));
  } finally {
    if (shopId && !process.env.E2E_KEEP) {
      await pool.query("DELETE FROM shops WHERE id=$1", [shopId]).catch((e) => results.push("WARN cleanup failed: " + e.message));
    } else if (shopId) {
      results.push(`WARN test shop kept: ${shopId}`);
    }
    await pool.end();
    console.log(results.join("\n"));
    console.log(`\n${results.filter((r) => r.startsWith("PASS")).length} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  }
})();
