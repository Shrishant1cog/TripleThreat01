import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

const html = read('www/index.html');
const core = read('www/core.js');
const capacitor = read('capacitor.config.ts');
const manifest = read('android/app/src/main/AndroidManifest.xml');
const releaseNetwork = read('android/app/src/main/res/xml/network_security_config.xml');
const debugNetwork = read('android/app/src/debug/res/xml/network_security_config.xml');
const gradle = read('android/app/build.gradle');
const plugin = read('android/app/src/main/java/com/easygateway/app/EasyGatewayNativePlugin.java');
const mainActivity = read('android/app/src/main/java/com/easygateway/app/MainActivity.java');
const pkg = JSON.parse(read('package.json'));

test('the bundled app entry point and PWA assets exist', () => {
  for (const path of [
    'www/index.html',
    'www/core.js',
    'www/manifest.webmanifest',
    'www/icons/icon-192.png',
    'www/icons/icon-512.png',
    'www/icons/icon-maskable-512.png'
  ]) {
    assert.ok(existsSync(new URL(path, root)), `${path} should exist`);
  }
  assert.match(html, /<script src="core\.js"><\/script>/);
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /Content-Security-Policy/);
});

test('every declared UI action has a delegated handler', () => {
  const actions = [...html.matchAll(/data-action="([^"]+)"/g)].map(match => match[1]);
  const handlers = new Set([...html.matchAll(/action==="([^"]+)"/g)].map(match => match[1]));
  const missing = [...new Set(actions)].filter(action => !handlers.has(action));
  assert.deepEqual(missing, []);
});

test('native bridge is registered and exposes the required methods', () => {
  assert.match(mainActivity, /registerPlugin\(EasyGatewayNativePlugin\.class\)/);
  for (const method of ['getConfig', 'request', 'clearSession', 'saveCsv', 'savePng']) {
    assert.match(plugin, new RegExp(`public void ${method}\\(`));
  }
  assert.match(plugin, /BuildConfig\.API_BASE_URL/);
  assert.match(plugin, /BuildConfig\.DEBUG/);
  assert.match(plugin, /NETWORK_TIMEOUT/);
  assert.match(plugin, /never retried automatically|never retried|not retried/i);
});

test('native requests never expose the session cookie to JavaScript', () => {
  assert.match(plugin, /never expose HttpOnly session cookies to the WebView/);
  assert.match(html, /nativeBridge\.request/);
  assert.match(html, /credentials:"same-origin"/);
});

test('Demo Mode uses only the preview endpoint for imports', () => {
  assert.match(core, /demo-product-qr\/consume-preview/);
  assert.match(html, /const route=window\.EGCore\.importEndpoint\(demoMode\)/);
  assert.match(html, /await api\(route\.path,\{method:"POST",body:\{token\}\}\)/);
  assert.match(html, /if\(demoMode&&!path\.startsWith\("\/demo-product-qr"\)\)return demoApi\(path,opts\)/);
  // The live consume route is present exactly once, in the shared route helper call,
  // not as a second hard-coded request that could bypass demo isolation.
  assert.equal((html.match(/"\/product-import\/consume"/g) || []).length, 0);
});

test('the QR mode marker decides cross-mode imports before any request', () => {
  // A live QR must be refused while Demo Mode is on, and a demo QR must switch
  // to Demo Mode instead of hitting the live consume route.
  assert.match(html, /parsed\.demoOnly===false&&demoMode/);
  assert.match(html, /parsed\.demoOnly===true&&!demoMode/);
  assert.match(html, /setPendingScanToken\(parsed\.token,parsed\.demoOnly\)/);
  assert.match(html, /function pendingScanDemoOnly\(\)/);
  assert.match(html, /importErrorMessage\(demoMode,err\.status,err\.message,tokenDemoOnly\)/);
  assert.match(core, /isDemoOnlyLink\(url\)/);
});

test('camera scanning, QR saving and CSV sharing are wired to native capabilities', () => {
  assert.match(html, /scanBarcode\(\{hint:17/);
  assert.match(html, /scanningLibrary:"zxing"/);
  assert.match(html, /nativeBridge\.savePng/);
  assert.match(html, /nativeBridge\.saveCsv/);
  assert.match(html, /nativeShare\.share/);
  assert.match(manifest, /android\.permission\.CAMERA/);
  assert.match(manifest, /android\.permission\.INTERNET/);
});

test('mobile navigation and hardware back are handled natively', () => {
  assert.match(html, /data-action="toggle-nav"/);
  assert.match(html, /class="mobile-tabbar"/);
  assert.match(html, /initNativeBackButton/);
  assert.match(html, /addListener\("backButton"/);
  assert.match(html, /data-action="page-back"/);
});

test('release builds block cleartext while debug builds allow local development', () => {
  assert.match(releaseNetwork, /cleartextTrafficPermitted="false"/);
  assert.match(debugNetwork, /cleartextTrafficPermitted="true"/);
  assert.match(gradle, /easyGateway\.apiBaseUrl/);
  assert.match(gradle, /easyGateway\.allowCleartext/);
  assert.match(gradle, /buildConfigField "String", "API_BASE_URL"/);
  assert.match(plugin, /"http"\.equals\(protocol\) && BuildConfig\.DEBUG && BuildConfig\.ALLOW_CLEARTEXT/);
});

test('deep links cover the public store, import and custom scheme', () => {
  assert.match(manifest, /android:pathPrefix="\/shop\/"/);
  assert.match(manifest, /android:pathPrefix="\/import-product\/"/);
  assert.match(manifest, /android:scheme="easygateway"/);
  assert.match(html, /getLaunchUrl/);
  assert.match(html, /addListener\("appUrlOpen"/);
});

test('Capacitor and package versions are pinned with expected app id', () => {
  assert.match(capacitor, /appId: 'com\.easygateway\.app'/);
  assert.match(capacitor, /webDir: 'www'/);
  assert.match(capacitor, /androidScheme: 'https'/);
  assert.equal(pkg.dependencies['@capacitor/barcode-scanner'], '3.1.3');
  assert.equal(pkg.dependencies['@capacitor/android'], '8.5.3');
  assert.ok(pkg.scripts.test);
  assert.ok(pkg.scripts['android:build']);
});

test('mutations are guarded against duplicate taps and ambiguous retries', () => {
  assert.match(html, /async function withBusy/);
  assert.match(html, /if\(busy\)return/);
  assert.match(html, /storeCheckoutBusy/);
  assert.match(html, /before sending it again/);
  assert.match(plugin, /timeout is reported to the UI|Check the connection before retrying/);
});

test('inventory cards keep edit, audited stock adjustment and sample removal actions', () => {
  assert.match(html, /data-action="edit-product"/);
  assert.match(html, /data-action="adjust-stock"/);
  assert.match(html, /data-action="remove-demo-product"/);
  assert.match(html, /id="editProductForm"/);
  assert.match(html, /method:"PUT"/);
  assert.match(html, /Stock is read-only here so every quantity change keeps an audit notification/);
});

test('tables are converted to labelled mobile cards without deleting columns', () => {
  assert.match(html, /function decorateTables/);
  assert.match(html, /table\.classList\.add\("mobile-cards"\)/);
  assert.match(html, /cell\.setAttribute\("data-label"/);
  assert.match(html, /decorateTables\(\$\("content"\)\)/);
  assert.match(html, /decorateTables\(root\)/);
});

test('shop tools load after the app bundle and reuse the shared retail rules', () => {
  const retail = read('www/retail-core.js');
  const features = read('www/app-features.js');
  for (const path of ['www/retail-core.js', 'www/app-features.js']) {
    assert.ok(existsSync(new URL(path, root)), `${path} should exist`);
  }
  const retailTag = html.indexOf('<script src="retail-core.js"></script>');
  const featuresTag = html.indexOf('<script src="app-features.js"></script>');
  assert.ok(retailTag > 0, 'the retail rules script should be loaded');
  assert.ok(featuresTag > retailTag, 'feature tools must load after the retail rules');
  assert.ok(featuresTag > html.lastIndexOf('})();'), 'feature tools must load after the app IIFE');
  assert.match(retail, /EGRetail\s*=\s*api/);
  assert.match(retail, /buildStockActions/);
  assert.match(retail, /buildSummaryText/);
  assert.match(retail, /isBarcodeValue/);
  assert.match(features, /window\.EGFeatures\s*=/);
  assert.match(features, /handleScannedCode/);
  assert.match(
    features,
    /if \(isDemo\(\)\) \{\s*try \{\s*return demoRequest\(path, options\);\s*\}\s*catch \(error\) \{\s*return Promise\.reject\(error\);\s*\}\s*\}/,
    'demo validation errors must reject so the stocking and sale forms can clear their busy state'
  );
});

test('demo data persists under one key and keeps at least two products and customers', () => {
  assert.match(html, /sessionStorage\.getItem\("easyGatewayDemoDataV2"\)/);
  assert.match(html, /sessionStorage\.setItem\("easyGatewayDemoDataV2"/);
  assert.match(html, /saved\.products\.length>=2&&Array\.isArray\(saved\.customers\)&&saved\.customers\.length>=2/);
  assert.match(html, /id:"demo-p1"/);
  assert.match(html, /id:"demo-p2"/);
  assert.match(html, /id:"demo-c1"/);
  assert.match(html, /id:"demo-c2"/);
  assert.match(html, /Demo Mode · sample data/);
});

test('customer storefront keeps tracking, quantity controls and duplicate-order protection', () => {
  assert.match(html, /data-action="customer-track"/);
  assert.match(html, /Track Order Status/);
  assert.match(html, /data-action="customer-track-refresh"/);
  assert.match(html, /id="customerTrackPanel"/);
  assert.match(html, /data-customer-inc=/);
  assert.match(html, /data-customer-delete=/);
  assert.match(html, /clientRequestId:customerOrderKey/);
  assert.match(html, /CUSTOMER_STATUS_LABELS=\{requested:"Awaiting retailer approval",accepted:"Confirmed"/);
  assert.match(html, /value="'\+safe\(\(customerTrackQuery&&customerTrackQuery\.phone\)\|\|""\)\+'"/);
});

test('standard barcodes reach Quick Sale while URL codes keep the QR import path', () => {
  const features = read('www/app-features.js');
  assert.match(core, /\[product\.name, product\.sku, product\.barcode, product\.category\]/);
  assert.ok(html.includes('if(window.EGFeatures&&typeof window.EGFeatures.handleScannedCode==="function"&&window.EGFeatures.handleScannedCode(raw))return true;'));
  assert.match(html, /hint:17/);
  assert.match(html, /Scan code with camera/);
  assert.match(features, /handleScannedCode/);
  assert.match(features, /products\/lookup/);
});

test('product add and edit forms carry an optional barcode field', () => {
  assert.match(html, /<label class="field">Barcode \(optional\)<input name="barcode"/);
  assert.match(html, /barcode:fd\.get\("barcode"\)\|\|""/);
  assert.match(html, /barcode:String\(b\.barcode\|\|""\)/);
  assert.match(html, /barcode:b\.barcode\|\|""/);
  assert.match(html, /\(p\.barcode\?' · '\+safe\(p\.barcode\):''\)/);
  assert.match(html, /window\.EGApp=\{api,toast,state,refresh,loadDemoData,saveDemoData/);
  assert.match(html, /scanBarcode:scanQrCode/);
});
