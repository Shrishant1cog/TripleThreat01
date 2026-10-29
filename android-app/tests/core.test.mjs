import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../www/core.js', import.meta.url), 'utf8');
const context = createContext({ window: {}, URL, console });
runInContext(source, context, { filename: 'www/core.js' });
const core = context.EGCore || context.window.EGCore;

const token = 'A'.repeat(43);
const hosts = ['easy-gateway.onrender.com'];
const options = { allowedHosts: hosts, allowHttp: false };
const PRODUCTION_HTTP = "This QR uses an HTTP link, which the production app doesn't allow. Scan the HTTPS QR code or use the configured local-development app.";

test('accepts live import and scan links with a 43-character token', () => {
  const imported = core.parseLink(`https://easy-gateway.onrender.com/import-product/${token}`, options);
  assert.equal(imported.kind, 'import');
  assert.equal(imported.token, token);
  assert.equal(imported.error, undefined);

  const scanned = core.parseLink(`https://easy-gateway.onrender.com/scan/${token}`, options);
  assert.equal(scanned.kind, 'scan');
  assert.equal(scanned.token, token);
});

test('accepts the signed-in scanToken query link', () => {
  const parsed = core.parseLink(`https://easy-gateway.onrender.com/?scanToken=${token}`, options);
  assert.equal(parsed.kind, 'import');
  assert.equal(parsed.token, token);
});

test('accepts customer store links and decodes the slug', () => {
  const parsed = core.parseLink('https://easy-gateway.onrender.com/shop/Greenway%20General', options);
  assert.equal(parsed.kind, 'store');
  assert.equal(parsed.slug, 'Greenway General');
});

test('accepts the app custom scheme without requiring host verification', () => {
  const store = core.parseLink('easygateway://shop/greenway', options);
  assert.equal(store.kind, 'store');
  assert.equal(store.slug, 'greenway');

  const imported = core.parseLink(`easygateway://import-product/${token}`, options);
  assert.equal(imported.kind, 'import');
  assert.equal(imported.token, token);

  const scanned = core.parseLink(`easygateway://scan/${token}`, options);
  assert.equal(scanned.kind, 'scan');
});

test('rejects tokens of the wrong length and unsupported schemes', () => {
  assert.match(core.parseLink('https://easy-gateway.onrender.com/import-product/short', options).error, /invalid|43/i);
  assert.match(core.parseLink('javascript:alert(1)', options).error, /not an Easy Gateway link/i);
  assert.match(core.parseLink('not a url', options).error, /not an Easy Gateway link/i);
});

test('rejects a QR pointing at a different host', () => {
  assert.match(core.parseLink(`https://evil.example/import-product/${token}`, options).error, /unsupported address/i);
  assert.match(core.parseLink(`https://easy-gateway.onrender.com.evil.example/import-product/${token}`, options).error, /unsupported address/i);
  assert.match(
    core.parseLink(`https://user:secret@easy-gateway.onrender.com/import-product/${token}`, options).error,
    /embedded sign-in details/i
  );
  const debug = core.parseLink(`http://10.0.2.2:3000/import-product/${token}`, {
    allowedHosts: ['10.0.2.2:3000'],
    allowHttp: true
  });
  assert.equal(debug.kind, 'import');
});

test('the production build explains HTTP links with the exact required message', () => {
  for (const link of [
    `http://easy-gateway.onrender.com/import-product/${token}`,
    `http://10.27.244.13:3000/import-product/${token}`,
    `http://192.168.1.20:3000/scan/${token}`,
    `http://10.0.2.2:3000/?scanToken=${token}`
  ]) {
    assert.equal(core.parseLink(link, options).error, PRODUCTION_HTTP, link);
  }
  assert.match(
    core.parseLink(`http://evil.example/import-product/${token}`, options).error,
    /unsupported address/i
  );
});

test('a LAN debug build accepts only its exact configured host and port', () => {
  const lan = { allowedHosts: ['10.27.244.13:3000'], allowHttp: true };
  const accepted = core.parseLink(`http://10.27.244.13:3000/import-product/${token}`, lan);
  assert.equal(accepted.kind, 'import');
  assert.equal(accepted.error, undefined);
  assert.match(core.parseLink(`http://10.27.244.13:3001/import-product/${token}`, lan).error, /unsupported address/i);
  assert.match(core.parseLink(`http://10.27.244.14:3000/import-product/${token}`, lan).error, /unsupported address/i);
  assert.match(core.parseLink(`http://10.27.244.13.evil.example:3000/import-product/${token}`, lan).error, /unsupported address/i);
});

test('import routing never sends a demo token to the live consume endpoint', () => {
  const demo = core.importEndpoint(true);
  assert.equal(demo.path, '/demo-product-qr/consume-preview');
  assert.equal(demo.mode, 'demo');
  assert.equal(demo.touchesLiveData, false);
  const live = core.importEndpoint(false);
  assert.equal(live.path, '/product-import/consume');
  assert.equal(live.mode, 'live');
  assert.equal(live.touchesLiveData, true);
});

test('marks demo-only import links from the QR payload itself', () => {
  const demo = core.parseLink(`https://easy-gateway.onrender.com/import-product/${token}?mode=demo`, options);
  assert.equal(demo.kind, 'import');
  assert.equal(demo.demoOnly, true);

  const live = core.parseLink(`https://easy-gateway.onrender.com/import-product/${token}`, options);
  assert.equal(live.kind, 'import');
  assert.equal(live.demoOnly, false);

  const customDemo = core.parseLink(`easygateway://import-product/${token}?mode=demo`, options);
  assert.equal(customDemo.demoOnly, true);
  const customLive = core.parseLink(`easygateway://import-product/${token}`, options);
  assert.equal(customLive.demoOnly, false);

  const queryDemo = core.parseLink(`https://easy-gateway.onrender.com/?scanToken=${token}&mode=demo`, options);
  assert.equal(queryDemo.demoOnly, true);
  const queryLive = core.parseLink(`https://easy-gateway.onrender.com/?scanToken=${token}`, options);
  assert.equal(queryLive.demoOnly, false);
});

test('cross-mode token failures explain that no data changed', () => {
  const liveServerText = 'This live import QR has expired, is a demo-only code, or has already been scanned. Generate a fresh code.';
  const demoServerText = 'This demo-only QR has expired, is not a demo token, or has already been scanned. Generate a fresh code.';
  // The server sends one combined 410 message per route, so only the QR
  // marker can tell a cross-mode rejection from a same-mode dead code.
  assert.match(core.importErrorMessage(true, 410, liveServerText, false), /live import QR/i);
  assert.match(core.importErrorMessage(false, 410, demoServerText, true), /Demo Mode QR/i);
  assert.match(core.importErrorMessage(true, 410, demoServerText, true), /expired|already scanned/i);
  assert.match(core.importErrorMessage(false, 410, liveServerText, false), /expired|already scanned/i);
  assert.doesNotMatch(core.importErrorMessage(true, 410, liveServerText, false), /live inventory/i);
  assert.equal(core.importErrorMessage(false, 500, 'Server error', false), 'Server error');
});

test('CSV output quotes commas, quotes, newlines and nulls', () => {
  const csv = core.csv([
    ['Product', 'Note'],
    ['Rice, 5 kg', 'He said "fresh"'],
    ['Dal', 'line one\nline two'],
    ['Salt', null]
  ]);
  assert.equal(
    csv,
    '"Product","Note"\r\n"Rice, 5 kg","He said ""fresh"""\r\n"Dal","line one\nline two"\r\n"Salt",""'
  );
});

test('inventory filters combine search with stock, expiry and QR tags', () => {
  const products = [
    { name: 'Rice', sku: 'R1', category: 'Grocery', stock: 3, reorderAt: 5, expiry: '2026-11-01', qrImported: false },
    { name: 'Soap', sku: 'S1', category: 'Care', stock: 10, reorderAt: 5, expiry: '', qrImported: true },
    { name: 'Dal', sku: 'D1', category: 'Grocery', stock: 1, reorderAt: 4, expiry: '2027-01-01', qrImported: false }
  ];
  const expiryDays = value => (value ? Math.round((new Date(value + 'T00:00:00') - new Date('2026-10-28T00:00:00')) / 86400000) : null);
  assert.deepEqual(core.inventoryFilter(products, 'all', '', expiryDays).map(p => p.sku), ['R1', 'S1', 'D1']);
  assert.deepEqual(core.inventoryFilter(products, 'low', '', expiryDays).map(p => p.sku), ['R1', 'D1']);
  assert.deepEqual(core.inventoryFilter(products, 'expiring', '', expiryDays).map(p => p.sku), ['R1']);
  assert.deepEqual(core.inventoryFilter(products, 'qr', '', expiryDays).map(p => p.sku), ['S1']);
  assert.deepEqual(core.inventoryFilter(products, 'all', 'grocery', expiryDays).map(p => p.sku), ['R1', 'D1']);
  assert.deepEqual(core.inventoryFilter(products, 'low', 'rice', expiryDays).map(p => p.sku), ['R1']);
});

test('token validation mirrors the backend 43-character contract', () => {
  assert.equal(core.tokenIsValid(token), true);
  assert.equal(core.tokenIsValid('B'.repeat(42)), false);
  assert.equal(core.tokenIsValid('B'.repeat(44)), false);
  assert.equal(core.tokenIsValid('!'.repeat(43)), false);
});
