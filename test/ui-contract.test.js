const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// These are static contract checks: they catch frontend/backend wiring regressions
// without needing a PostgreSQL instance.

test("every data-action in the markup has a click handler", () => {
  const actions = new Set([...html.matchAll(/data-action="([a-z-]+)"/g)].map(m => m[1]));
  const handled = new Set([...html.matchAll(/action===?"([a-z-]+)"/g)].map(m => m[1]));
  const unhandled = [...actions].filter(action => !handled.has(action));
  assert.deepEqual(unhandled, [], "unhandled data-action values: " + unhandled.join(", "));
  assert.ok(actions.size >= 20, "expected the full navigation/action set to still be present");
});

test("generate-qr is handled exactly once so one click cannot fire the handler twice", () => {
  assert.equal([...html.matchAll(/action===?"generate-qr"/g)].length, 1);
});

test("the unreachable product-QR branch stays removed", () => {
  assert.equal(html.includes("generateQrToken("), false);
  assert.equal(html.includes("qrSelectedProductId"), false);
});

test("the auto-purchase cycle is scheduled by the server, not only by scripts/maintenance.js", () => {
  assert.match(server, /async function scheduledAutoPurchaseCycle\(\)/);
  assert.match(server, /timers\.push\(setTimeout\(scheduledAutoPurchaseCycle,/);
  assert.match(server, /timers\.push\(setInterval\(scheduledAutoPurchaseCycle,/);
});

test("the auth rate limiter applies to login and register only", () => {
  const limited = [...server.matchAll(/app\.post\("\/api\/auth\/([a-z]+)",\s*authLimiter/g)].map(m => m[1]).sort();
  assert.deepEqual(limited, ["login", "register"]);
  assert.equal(/app\.use\("\/api\/auth",\s*rateLimit/.test(server), false);
});

test("notify accepts a transaction client so notifications can be atomic", () => {
  assert.match(server, /async function notify\(shopId,kind,title,message,payload=\{\},client=pool\)/);
});

test("the production session secret cannot fall back to the development constant on Render", () => {
  assert.match(server, /const ALLOW_DEV_SECRET = NODE_ENV === "development" && !process\.env\.RENDER;/);
  assert.match(server, /SESSION_SECRET is required outside local development\./);
});

test("the website loads the shared retail rules and shop tools after the main bundle", () => {
  assert.match(html, /<script src="\/retail-core\.js"><\/script>/);
  assert.match(html, /<script src="\/app-features\.js"><\/script>/);
  assert.ok(html.indexOf("/app-features.js") > html.lastIndexOf("})();"), "feature script should load after the app IIFE");
  assert.match(server, /app\.get\("\/retail-core\.js"/);
  assert.match(server, /app\.get\("\/app-features\.js"/);
});

test("the product form captures an optional barcode and sends it to the API", () => {
  assert.match(html, /name="barcode"/);
  assert.match(html, /barcode:fd\.get\("barcode"\)\|\|""/);
  assert.match(server, /app\.get\("\/api\/products\/lookup"/);
  assert.match(server, /ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode TEXT NOT NULL DEFAULT ''/);
  assert.match(server, /products_shop_barcode_unique/);
});

test("quick sale keeps the legacy single-line API shape while accepting a cart", () => {
  assert.match(server, /Array\.isArray\(req\.body\.items\)/);
  assert.match(server, /req\.body\.productId/);
  assert.match(server, /sale_group_id/);
  assert.match(server, /COUNT\(DISTINCT COALESCE\(sale_group_id,id\)\)/);
  assert.match(html, /window\.EGApp=\{api,toast,state,refresh,loadDemoData,saveDemoData/);
});

test("the action center and daily summary use server-side shop data", () => {
  assert.match(server, /app\.get\("\/api\/action-center"/);
  assert.match(server, /app\.get\("\/api\/daily-summary"/);
  assert.match(server, /buildStockActions/);
  assert.match(server, /buildSummaryText/);
  const features = fs.readFileSync(path.join(__dirname, "..", "app-features.js"), "utf8");
  assert.match(features, /handleScannedCode/);
  assert.match(features, /data-feature="quick-sale"/);
  assert.match(features, /action-center/);
  assert.match(features, /daily-summary/);
});

test("demo validation errors reject as promises so busy forms can recover", () => {
  const features = fs.readFileSync(path.join(__dirname, "..", "app-features.js"), "utf8");
  assert.match(
    features,
    /if \(isDemo\(\)\) \{\s*try \{\s*return demoRequest\(path, options\);\s*\}\s*catch \(error\) \{\s*return Promise\.reject\(error\);\s*\}\s*\}/
  );
});

test("demo mode seeds at least two products and two customers and guards a stale cache", () => {
  assert.match(html, /id:"demo-p1"/);
  assert.match(html, /id:"demo-p2"/);
  assert.match(html, /id:"demo-c1"/);
  assert.match(html, /id:"demo-c2"/);
  assert.match(html, /saved\.products\.length>=2&&Array\.isArray\(saved\.customers\)&&saved\.customers\.length>=2/);
  assert.match(html, /Demo Mode · sample data/);
});

test("the customer store has a clear tracking button, status refresh and quantity controls", () => {
  assert.match(html, /data-action="customer-track"/);
  assert.match(html, /Track Order Status/);
  assert.match(html, /data-action="customer-track-refresh"/);
  assert.match(html, /id="customerTrackPanel"/);
  assert.match(html, /data-customer-inc=/);
  assert.match(html, /data-customer-delete=/);
  assert.match(html, /const CUSTOMER_STATUS_LABELS=\{requested:"Awaiting retailer approval",accepted:"Confirmed",declined:"Declined"/);
  assert.match(html, /customerTrackQuery&&customerTrackQuery\.phone/);
});

test("customer order checkout is idempotent and validates contact details", () => {
  assert.match(html, /clientRequestId:customerOrderKey/);
  assert.match(html, /customerOrderKey=null/);
  assert.match(server, /client_request_id TEXT/);
  assert.match(server, /customer_orders_client_request_unique/);
  assert.match(server, /const clientRequestId=text\(req\.body\.clientRequestId\|\|req\.get\("Idempotency-Key"\)\)/);
});
