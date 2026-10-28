#!/usr/bin/env node
/**
 * Fast structural verification of the bundled Easy Gateway web app and Android
 * configuration. This does not replace `npm test`; it catches missing assets,
 * unhandled buttons and accidental insecure defaults before a Gradle build.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const checks = [];

function check(name, condition, detail = '') {
  checks.push({ name, ok: !!condition, detail });
  if (!condition) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

const required = [
  'package.json',
  'capacitor.config.ts',
  'www/index.html',
  'www/core.js',
  'www/retail-core.js',
  'www/app-features.js',
  'www/manifest.webmanifest',
  'www/icons/icon-192.png',
  'www/icons/icon-512.png',
  'android/app/src/main/AndroidManifest.xml',
  'android/app/src/main/java/com/easygateway/app/EasyGatewayNativePlugin.java',
  'android/app/src/main/java/com/easygateway/app/MainActivity.java',
  'android/app/src/main/res/xml/network_security_config.xml',
  'android/app/src/debug/res/xml/network_security_config.xml'
];
for (const path of required) check(`required file ${path}`, existsSync(join(root, path)));

const html = read('www/index.html');
const capacitor = read('capacitor.config.ts');
const manifest = read('android/app/src/main/AndroidManifest.xml');
const releaseNetwork = read('android/app/src/main/res/xml/network_security_config.xml');
const plugin = read('android/app/src/main/java/com/easygateway/app/EasyGatewayNativePlugin.java');

check('app id', /appId: 'com\.easygateway\.app'/.test(capacitor));
check('bundled web directory', /webDir: 'www'/.test(capacitor));
check('secure WebView scheme', /androidScheme: 'https'/.test(capacitor));
check('release blocks cleartext', /cleartextTrafficPermitted="false"/.test(releaseNetwork));
check('native camera permission', /android\.permission\.CAMERA/.test(manifest));
check('native HTTP bridge', /class EasyGatewayNativePlugin/.test(plugin));

const actions = [...html.matchAll(/data-action="([^"]+)"/g)].map(match => match[1]);
const handlers = new Set([...html.matchAll(/action==="([^"]+)"/g)].map(match => match[1]));
const unhandled = [...new Set(actions)].filter(action => !handlers.has(action));
check('all UI actions are handled', unhandled.length === 0, unhandled.join(', '));

check('shared core loaded before app', /<script src="core\.js"><\/script>/.test(html));
check('shop tools loaded after the app bundle', /<script src="retail-core\.js"><\/script>/.test(html) && /<script src="app-features\.js"><\/script>/.test(html) && html.indexOf('app-features.js') > html.lastIndexOf('})();'));
check('standard barcodes route to Quick Sale', /handleScannedCode/.test(html) && /hint:17/.test(html));
check('product forms capture an optional barcode', /name="barcode"/.test(html) && /barcode:fd\.get\("barcode"\)\|\|""/.test(html));
check('screen back navigation', /data-action="page-back"/.test(html));
check('native scanner is wired', /scanBarcode\(\{hint:17/.test(html));
check('CSV export shares natively', /nativeBridge\.saveCsv/.test(html));
check('QR image saves natively', /nativeBridge\.savePng/.test(html));
check('Demo import stays sandboxed', /importEndpoint\(demoMode\)/.test(html));
check('live import is never hard-coded beside the demo route', !/"\/product-import\/consume"/.test(html));
check('mobile cards are generated', /table\.classList\.add\("mobile-cards"\)/.test(html));
check('customer portal has a back control', /data-action="customer-exit"/.test(html));
check('settings can verify the backend', /data-action="test-connection"/.test(html));
check('manifest icon assets exist', existsSync(join(root, 'www/icons/icon-maskable-512.png')));

// Never embed a development server as the production default.
check('no localhost production default in web bundle', !/localhost:3000/.test(html));

for (const item of checks) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok || !item.detail ? '' : ` (${item.detail})`}`);
}
console.log(`\n${checks.length - failures.length}/${checks.length} checks passed.`);
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
