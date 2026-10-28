const test = require("node:test");
const assert = require("node:assert/strict");
const { buildStockActions, buildSummaryText, daysUntil, isBarcodeValue, money } = require("../lib/retail-core");

const products = [
  { id: "p-out", name: "Milk", sku: "MILK-1", unit: "pack", stock: 0, reorderAt: 5, cost: 20, price: 30 },
  { id: "p-low", name: "Dal", sku: "DAL-1", unit: "kg", stock: 2, reorderAt: 5, cost: 80, price: 100 },
  { id: "p-exp", name: "Curd", sku: "CURD-1", unit: "cup", stock: 4, reorderAt: 2, cost: 15, price: 25, daysToExpiry: 2 },
  { id: "p-slow", name: "Old soap", sku: "SOAP-1", unit: "bar", stock: 20, reorderAt: 5, cost: 15, price: 30, soldLast30Days: 0, ageDays: 45 },
  { id: "p-over", name: "Festival box", sku: "BOX-1", unit: "box", stock: 40, reorderAt: 5, cost: 50, price: 80, soldLast30Days: 2 },
  { id: "p-ok", name: "Rice", sku: "RICE-1", unit: "bag", stock: 12, reorderAt: 4, cost: 90, price: 120, soldLast30Days: 10, ageDays: 20 }
];

test("buildStockActions flags stockouts, low stock, expiry, slow movers and overstock", () => {
  const result = buildStockActions(products, new Date("2026-10-28T12:00:00Z"));
  const byId = Object.fromEntries(result.actions.map(action => [action.id, action]));
  assert.equal(byId["p-out"].type, "out_of_stock");
  assert.equal(byId["p-low"].type, "low_stock");
  assert.equal(byId["p-exp"].type, "expiring_urgent");
  assert.equal(byId["p-slow"].type, "slow_mover");
  assert.equal(byId["p-over"].type, "overstock");
  assert.equal(byId["p-ok"], undefined);
  assert.equal(result.summary.total, 5);
  assert.equal(result.summary.outOfStock, 1);
  assert.equal(result.summary.lowStock, 1);
  assert.equal(result.summary.expiring, 1);
  assert.equal(result.summary.slowMovers, 1);
  assert.equal(result.summary.overstock, 1);
  assert.equal(result.summary.cashTiedUp, 300 + 2000);
});

test("buildStockActions sorts the most urgent actions first", () => {
  const result = buildStockActions(products, new Date("2026-10-28T12:00:00Z"));
  assert.deepEqual(result.actions.slice(0, 3).map(action => action.type), [
    "out_of_stock",
    "expiring_urgent",
    "low_stock"
  ]);
  assert.ok(result.actions.every((action, index, list) => index === 0 || list[index - 1].priority >= action.priority));
});

test("buildStockActions handles an empty catalogue", () => {
  assert.deepEqual(buildStockActions([]), {
    actions: [],
    summary: { total: 0, outOfStock: 0, lowStock: 0, expiring: 0, slowMovers: 0, overstock: 0, cashTiedUp: 0 }
  });
});

test("buildSummaryText includes revenue, orders, top products and stock watch", () => {
  const text = buildSummaryText({
    shopName: "Local Test Shop",
    date: "2026-10-28",
    revenue: 114,
    orders: 1,
    itemsSold: 2,
    averageOrder: 114,
    coinsAwarded: 0,
    newCustomers: 0,
    topProducts: [{ name: "Notebook A4", quantity: 1, revenue: 84 }],
    lowStockCount: 2,
    expiringSoonCount: 1
  });
  assert.match(text, /Local Test Shop/);
  assert.match(text, /Revenue: .*114\.00/);
  assert.match(text, /Orders: 1/);
  assert.match(text, /Top products:/);
  assert.match(text, /Notebook A4/);
  assert.match(text, /2 low stock/);
  assert.match(text, /1 expiring within 7 days/);
});

test("barcode detection accepts standard codes and SKUs but rejects URLs and prose", () => {
  assert.equal(isBarcodeValue("8901234567890"), true);
  assert.equal(isBarcodeValue("LOCAL-SYNC-001"), true);
  assert.equal(isBarcodeValue("ABC_123.4"), true);
  assert.equal(isBarcodeValue("https://easy-gateway.onrender.com/scan/abc"), false);
  assert.equal(isBarcodeValue("easygateway://shop/demo"), false);
  assert.equal(isBarcodeValue("hello world"), false);
  assert.equal(isBarcodeValue("abc"), false);
  assert.equal(isBarcodeValue(""), false);
});

test("daysUntil uses calendar-day arithmetic", () => {
  assert.equal(daysUntil("2026-10-28", new Date(2026, 9, 28, 23, 0)), 0);
  assert.equal(daysUntil("2026-10-29", new Date(2026, 9, 28, 1, 0)), 1);
  assert.equal(daysUntil("2026-10-27", new Date(2026, 9, 28, 1, 0)), -1);
  assert.equal(daysUntil("", new Date()), null);
});

test("money formats Indian rupees without throwing on invalid input", () => {
  assert.match(money(1234.5), /1,234\.50/);
  assert.match(money("not a number"), /0\.00/);
});
