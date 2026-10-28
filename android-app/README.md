# Easy Gateway Android

Native Android app for the existing **Easy Gateway** retail manager. The app bundles the
current web UI in a Capacitor WebView, keeps the original look, flows and business logic,
and can talk to the production backend at `https://easy-gateway.onrender.com` or to the
same local API used by the website during development.

The Android bundle keeps the source web UI and business logic. The only backend change made
for local-network testing is a QR-origin guard that refuses to generate a QR pointing at
`localhost`; it is documented in [`docs/LOCAL-NETWORK.md`](docs/LOCAL-NETWORK.md). No
database content, credentials or cloud data are included in this repository.

---

## What is included

| Area | Status |
| --- | --- |
| Login / signup / logout, server-side sessions | Preserved |
| Dashboard, inventory, product add/edit/adjust, deleting products | Preserved |
| Sell \| Stocking modes, cart checkout, stock receipts | Synced with the website |
| Serialized products, serial scanning, duplicate detection | Synced with the website |
| Expiry tracking, recycle bin, notifications | Preserved |
| Waste reports (date range, estimated vs recorded, CSV) | Preserved, CSV now saved through Android |
| Sales, purchasing, suppliers, customers, loyalty coins | Preserved |
| Loyalty vouchers: fixed catalogue, redeem, ledger | Synced with the website |
| Customer storefront, orders, email state, reference+phone tracking | Synced with the website |
| Demo Mode (isolated local sandbox, sample expiry/waste examples) | Preserved, never writes to the live database |
| QR sample generator and QR import | Preserved, plus native camera scanning |
| Camera QR scanning | Added (native, ZXing) |
| Save / share QR image and CSV | Added (Android MediaStore + share sheet) |
| Mobile-first layout | Added: table rows become labelled cards, bottom tab bar, safe areas |
| Deep links for storefront / import / scan links | Added (`easygateway://` plus HTTPS App Link intent filters) |

No fake metrics, reviews or placeholder screens were added. Screens that need a live
account still require a real login; the app does not invent a shop or bypass authentication.

---

## Requirements

- Node.js 22 or newer (verified with Node 24.20.0)
- JDK 17 or newer (verified with Eclipse Temurin 21.0.12)
- Android SDK Platform 36 and Build Tools 36
- Android device or emulator with Android 8.0+ (`minSdk 26`)
- `adb` for install and device verification

Capacitor 8.5.3, Gradle 8.14.x, `compileSdk`/`targetSdk` 36, `minSdk` 26.

If JDK 17 or newer is not found automatically, point the build at it (any installed JDK
17+ works; this repository was verified with 21.0.12):

```powershell
$env:EASY_GATEWAY_JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot'
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
```

---

## Quick start

```powershell
npm install
npm test
npm run verify:web
npm run android:build          # production API, debug APK
npm run android:install        # installs dist/EasyGateway-production-debug.apk
```

Build output:

```text
dist/EasyGateway-production-debug.apk     ~34 MB, signed with the debug key
dist/EasyGateway-production-release.apk   ~31 MB, unsigned (see Release build and signing)
```

The debug variant is signed with the standard Android debug key so it can be installed
immediately. It is **not** a Play Store upload.

### Build for the emulator

```powershell
npm run android:build:emulator
adb install -r dist/EasyGateway-emulator-debug.apk
```

Uses `http://10.0.2.2:3000` and is only for a backend running on the host machine.
Cleartext HTTP is allowed only in this debug build.

### Build for a physical phone on the same LAN

```powershell
npm run android:build:lan
# equivalent to:
node scripts/build-android.mjs --env lan --lan-ip auto --port 3000
adb install -r dist/EasyGateway-lan-debug.apk
```

`--lan-ip auto` picks the Wi-Fi IPv4 address and prints it. To pin an address explicitly:

```powershell
node scripts/build-android.mjs --env lan --lan-ip 192.168.1.20 --port 3000
```

Replace the IP with the development PC address. The phone and PC must share the network,
and the backend must listen on all interfaces. `localhost`, public addresses and
credentials in the URL are rejected on purpose. See
[`docs/LOCAL-NETWORK.md`](docs/LOCAL-NETWORK.md) for the full PC, database, firewall, QR,
verification and production-switch procedure.

---

## API configuration

API endpoints are compiled into the APK as `BuildConfig` values. They cannot be changed
from the UI.

| Build | API base URL | Cleartext | Intended use |
| --- | --- | --- | --- |
| `production` | `https://easy-gateway.onrender.com` | blocked | Normal app / release |
| `emulator` | `http://10.0.2.2:3000` | debug only | Local backend via Android emulator |
| `lan` | `http://<lan-ip>:3000` | debug only | Local backend from a real phone |
| custom | `--api-base-url https://...` | must stay HTTPS for production | Staging endpoint |

Validation lives in `config/environments.mjs` and fails closed:

- production must be HTTPS;
- HTTP is accepted only for a debug build, only when the build explicitly opts in;
- HTTP hosts must be private LAN/emulator addresses;
- credentials, paths, query strings and fragments in the base URL are rejected;
- `localhost` / `127.0.0.1` are rejected as app endpoints.

`android/app/src/main/res/xml/network_security_config.xml` blocks cleartext for normal
builds. Only `android/app/src/debug/res/xml/network_security_config.xml` permits it.

### Why there is a native HTTP bridge

The Capacitor WebView runs at `https://localhost`; the API is a different origin.
The existing Express backend intentionally has no CORS configuration and its session
cookie is `HttpOnly` + `SameSite=Lax`. A normal `fetch()` from the WebView would therefore
fail, and simply weakening the cookie or adding permissive CORS would reduce security.

Instead, `EasyGatewayNativePlugin` (`android/app/src/main/java/com/easygateway/app/`) performs
requests with `HttpURLConnection`:

- keeps the server session cookie in the app-private SharedPreferences cookie jar;
- never exposes `Set-Cookie` values to JavaScript;
- sends no `Origin` header, which the existing backend accepts;
- enforces HTTPS in non-debug builds and never disables TLS verification;
- never retries a mutation automatically.

No backend CORS or cookie change is required for the app to work.

The page CSP keeps `connect-src 'self'` because the page never makes cross-origin requests
itself; API calls go through the native bridge.

---

## Demo Mode isolation

Demo Mode is still the original browser-local sandbox:

- demo data lives in `sessionStorage`, keyed per app session;
- demo mutations are handled by the local `demoApi()` implementation;
- the only live endpoint used by Demo Mode is the sample-QR issuing endpoint
  `/api/demo-product-qr`, because sample products are generated on the server;
- importing a demo QR calls `/api/demo-product-qr/consume-preview`, never the live import
  route;
- every demo QR link generated by the backend carries `?mode=demo`; the app records that
  marker with the pending token and refuses to send a live QR to the demo route or a demo
  QR to the live route, so a mixed-mode scan never consumes the token or changes data;
- scanning a demo QR while Live Mode is on switches to Demo Mode automatically, while
  scanning a live QR in Demo Mode is refused with an explanation and no request;
- a demo token rejected by the live consume route, and a live token rejected by the demo
  preview route, leave inventory unchanged;
- the imported sample is tagged `qrImported` and is removable without touching real stock;
- toggling Demo Mode off clears the demo QR state and returns to the real account.

Verified on the emulator: a demo scan added one tagged product to a 6-product demo shop,
the inventory count became 7, the toast confirmed "Demo Mode only", and the live account
was not signed in or modified. In the final build, scanning a live QR while Demo Mode was
on showed the "nothing was changed" message, stored no pending token, and the server still
reported that live token as `consumed:false`; a demo QR scanned while logged out switched
to Demo Mode and imported into the local sandbox only.

---

## QR workflow

1. Open **Product QR generator**.
2. Press **Generate random product QR**. Details are generated by the backend.
3. Scan with **Scan QR with camera** in the app, or with another device.
4. In Live Mode the product is added to the signed-in shop. In Demo Mode it stays local.
5. Imported samples are marked **QR SAMPLE** and offer **Remove sample**.

The app accepts these payloads:

- `https://easy-gateway.onrender.com/import-product/<43-char-token>`
- `https://easy-gateway.onrender.com/import-product/<43-char-token>?mode=demo`
- `https://easy-gateway.onrender.com/scan/<token>`
- `...?scanToken=<token>` (optionally with `&mode=demo`)
- `easygateway://import-product/<token>` and `easygateway://scan/<token>`

The `mode=demo` marker is read from the QR payload, not guessed from a server error text.
It selects the sandbox import route and blocks cross-mode imports before any request is
made. Links with an embedded username/password, a non-configured host or plain HTTP are
rejected, so a QR cannot redirect the app to another site or send session data elsewhere.

The scanner sends only the token to the backend. It never trusts product name, price or
stock embedded in a QR payload.

When an import is refused, the message matches the real cause:

- a live QR in Demo Mode: "This is a live import QR. Demo Mode is on, so nothing was changed...";
- a demo QR in Live Mode: "This is a Demo Mode QR. Turn Demo Mode on to import it...";
- an expired, already-scanned or unknown token: "This QR has expired or was already scanned.
  Generate a fresh QR code and try again."

If a live QR is scanned while signed out, the token is kept as a pending scan and the app
asks the operator to sign in; the token is only sent to the consume route after a
successful sign-in, and it is not consumed while the app waits.

QR images are saved to:

```text
Pictures/Easy Gateway/easy-gateway-sample-product.png
```

CSV exports are saved to:

```text
Download/Easy Gateway/easy-gateway-inventory.csv
Download/Easy Gateway/easy-gateway-waste-report-<from>-to-<to>.csv
```

A share sheet opens after saving, so the file can also be sent to another app. The saved
PNG was byte-for-byte identical to the QR shown on screen during verification.

---

## Data-safety behaviour

Sales, stock receipts, and loyalty redemptions now accept an idempotency key on the backend.
The bundled app sends a key with those mutations, so an ambiguous retry cannot duplicate a
sale or receipt when the server already processed it. The app still follows conservative
client rules:

- it does not retry POST/PUT/DELETE requests automatically;
- buttons use busy guards to prevent accidental double taps;
- request timeouts return an explicit message asking the operator to check whether the
  operation completed **before** retrying;
- an ambiguous failure is shown to the user instead of silently replaying the request.

This is deliberate: an idempotency key protects the server, but unrelated mutations (for
example an order status change) are not automatically safe to replay without checking.

---

## Project layout

```text
EasyGatewayAndroid/
  package.json                  npm scripts and Capacitor dependencies
  capacitor.config.ts           app id, bundled web dir, HTTPS WebView scheme
  config/environments.mjs       API environment resolution and validation
  www/
    index.html                  bundled Easy Gateway UI + Android adaptations
    core.js                     testable QR/CSV/filter/import-route helpers
    app-features.js             shared Sell/Stocking/loyalty/waste/order tools
    retail-core.js              shared pure retail rules (byte-identical to server copy)
    manifest.webmanifest        PWA metadata
    icons/                      launcher/web icons and maskable icon
  android/                      Capacitor Android project
    app/src/main/AndroidManifest.xml
    app/src/main/java/com/easygateway/app/
      MainActivity.java
      EasyGatewayNativePlugin.java
    app/src/main/res/xml/network_security_config.xml
    app/src/debug/res/xml/network_security_config.xml
  scripts/
    build-android.mjs           env-aware sync + Gradle build + APK copy
    verify-web.mjs              structural/security checks before building
  tests/
    core.test.mjs               QR parsing, CSV, filters, import routes
    config.test.mjs             environment validation
    app-invariants.test.mjs     UI wiring, native/config invariants
  docs/
    LOCAL-NETWORK.md            PC + phone LAN setup, database and HTTPS switch
    BACKEND-CHANGES.md          optional backend assetlinks change (not applied)
    evidence/                   emulator and physical-device verification screenshots
  dist/                         built APKs
```

### Android-specific UI changes

The bundled `www/index.html` is the original UI plus documented adaptations:

- viewport/safe-area handling and a bottom tab bar for phones;
- wide tables rendered as labelled cards below 760 px, without dropping columns;
- inventory filter chips (all / low stock / expiring in 7 days / QR samples);
- product edit modal using the existing `PUT /api/products/:id`;
- stock stays read-only in the edit form so audited stock adjustments remain the only
  way to change quantity;
- QR generator back button and native scan/save/share actions;
- settings card showing API base URL, environment, app version and a connection test;
- customer storefront back/share controls and a checkout busy guard;
- customer order email/address fields, order tracking and status actions;
- loyalty reward catalogue, redeem action and voucher ledger;
- date-range expiry waste report with estimated vs recorded loss and native CSV sharing;
- Sell | Stocking switcher with serial entry, duplicate feedback, and stock receipts;
- Android hardware-back handling.

The single delegated click handler covers every `data-action`. `verify-web.mjs` fails the
build if a button has no handler.

---

## Tests and verification

```powershell
npm test                       # 38 tests
npm run verify:web             # 36 structural/security checks
npm run android:build          # runs verify + cap sync + Gradle
```

Covered by tests:

- QR token/host parsing, including rejection of look-alike hosts, embedded-credential URLs
  and wrong token lengths;
- the `mode=demo` marker on HTTPS and `easygateway://` links;
- same-mode versus cross-mode import errors (a combined server 410 must not be guessed);
- CSV quoting and formula-injection protection;
- inventory filter semantics;
- demo vs live import route selection;
- API environment validation (production HTTPS, emulator/LAN HTTP, localhost rejection);
- all UI actions handled;
- native scanner, CSV and PNG bridges wired;
- release cleartext blocked, camera permission present;
- shared shop tools load after the app bundle and Demo Mode errors reject as promises;
- source copy does not contain a development server default.

### Local debug build verification (29 Oct 2026)

- `npm test`: 38/38 passed.
- `npm run verify:web`: 36/36 passed.
- Java build with JDK 21.0.12, compileSdk 36, targetSdk 36, minSdk 26.
- Built `dist/EasyGateway-lan-debug.apk` (35,615,724 bytes) with
  `API_BASE_URL=http://10.150.56.13:3000`, `ALLOW_CLEARTEXT=true`, environment `LAN`.
- `apksigner verify` reports the standard `CN=Android Debug` signer; this is a debug APK,
  not a Play Store upload.
- The APK's `assets/public/app-features.js` was extracted and checked for the Demo Mode
  promise-rejection fix.
- No Android device was attached to `adb` at build time, so installation and on-device
  execution of this exact APK were not performed.

### Emulator verification performed

Device: `emulator-5554`, Android 13, app `com.easygateway.app` 1.0.0 (minSdk 26,
targetSdk 36). Build under test: `dist/EasyGateway-production-debug.apk`
(SHA-256 `422B6F03575083196F8AC0E2558798965B05F6ADFC841442F9AFB30E2DA3035C`); the bundled
`assets/public/index.html` and `core.js` were extracted from the APK and checked for the
new QR-mode and credential checks. The release APK
(SHA-256 `F4E16DBCA806E8C40320EB80AB9962929A6C7873E9377FA51FF5233F7E2936E7`) contains the
same bundled assets.

- Verified `apiBaseUrl=https://easy-gateway.onrender.com`, environment `Production`,
  cleartext blocked, version `1.0.0`; release APK rebuilt and confirmed unsigned with
  `apksigner verify` ("Missing META-INF/MANIFEST.MF").
- Verified native `/healthz`: HTTP 200, `ok: true`, `database: connected`.
- Walked Demo Mode dashboard, inventory cards, filter chips, edit modal, QR generator,
  settings connection test and customer storefront.
- Launched the real native scanner four times (open → cancel → reopen → cancel): the
  `OSBARCScannerActivity` opened each time, `dumpsys media.camera` showed
  `CONNECT device 0 client for package com.easygateway.app`, cancelling returned silently
  and Demo Mode was preserved.
- Revoked `android.permission.CAMERA` and started a scan: the plugin showed
  "Camera Access Not Enabled"; after **Ok** the app showed
  "Couldn't scan because camera access wasn't provided. Check your camera permissions and
  try again." Permission was then restored.
- Decoded a genuine server QR PNG (`POST /api/demo-product-qr`) with ZXing core 3.5.3 —
  the same jar/version the scanner plugin resolves — which produced
  `QR_CODE` → `https://easy-gateway.onrender.com/import-product/<token>?mode=demo`.
  The payload was then delivered to the running app through its real deep-link import
  path (`MainActivity` `VIEW` intent). The app switched to Demo Mode, imported
  `Premium Basmati Rice 1 kg` / `DEMO-8A54F9` as a `qrImported` demo product (demo count
  6 → 7), cleared the pending token, and the token then reported
  `{consumed:true,expired:false}`.
- Re-delivered the same consumed token: "This QR has expired or was already scanned.
  Generate a fresh QR code and try again." (the earlier build wrongly claimed it was a
  live QR). An unknown 43-character demo token produced the same message; the server
  was contacted, nothing was imported.
- Scanned a fresh live QR while Demo Mode was on: blocked with "This is a live import QR.
  Demo Mode is on, so nothing was changed...", no pending token was stored, and the token
  status endpoint still returned `{consumed:false,expired:false}` (proof that no consume
  request was made).
- Scanned a fresh demo QR while logged out in Live Mode: the app switched to Demo Mode,
  imported `Handwash 250 ml` (`DEMO-0F8919`) and the toast confirmed "Demo Mode only".
  Repeated as a cold start (`am start -W -a VIEW`): `LaunchState: COLD`, the QR was
  imported after launch and the pending token was cleared.
- Rejected unsafe links through the same real app path, each with no pending token:
  evil host and suffix host → "This QR points to a server that is not configured for this
  app."; HTTP trusted host → "This QR points to an insecure server. Use the HTTPS link
  instead."; `javascript:` → "This QR code is not an Easy Gateway link."; short token and
  wrong path → "This QR is not a supported Easy Gateway product link."; URL with
  `user:secret@` → "This QR link contains embedded sign-in details and cannot be opened."
- Exported inventory CSV and saved the QR PNG; confirmed both files and their contents.
- Checked logcat after interactions: no app-specific JavaScript or bridge errors.

Screenshots from these runs are in [`docs/evidence/`](docs/evidence/):

| File | Shows |
| --- | --- |
| `scanner-camera.png` | ZXing scanner activity with the live camera preview and scan frame |
| `demo-qr-import.png` | Demo QR imported into the sandbox with the "Demo Mode only" toast |
| `live-qr-blocked-in-demo.png` | Live QR refused in Demo Mode, nothing changed |
| `expired-token.png` | Expired/already-scanned token message |
| `camera-permission-denied.png` | Plugin "Camera Access Not Enabled" dialog |

#### Camera-frame limitation

No physical phone or webcam pointed at a printed QR was available. The emulator's
`virtualscene` camera was used instead, but in this emulator build (36.3.10.0, AVD
`Pixel_4`) the poster planes do not render: `-virtualscene-poster wall=…`,
`adb emu virtualscene-image wall/table …` and a temporary `Toren1BD.posters` override all
produced a room with no visible poster in a full 360° yaw sweep (gRPC
`rotateVirtualSceneCamera` confirmed working). The emulator resources were restored
byte-for-byte (`Toren1BD.posters` SHA-256
`76DF35D81794EB16636209D9D51759464A4FAE51E4A9A454061AB29E4CF3039F`).

The camera pipeline itself is proven (camera device opened by the scanner, permission
handling, cancel/reopen), and the decode path is proven with a real server-generated QR
image and the exact ZXing version used by the plugin. What could not be captured is a
literal photo of a QR inside the emulator camera frame; on a physical device the same
`scanBarcode()` call feeds the frame to that decoder.

Live login, sales and purchasing could not be tested without production credentials.
Those flows were preserved from the original frontend and are wired to the same API.

### Physical-device LAN verification performed

Device: Lenovo `TB310FU` (`HA2183XS`), Android 13 / API 33. PC: Windows, Node.js
`v24.20.0`, PostgreSQL `18.6`, Wi-Fi `Oppo` at `10.43.232.32/24`; tablet at
`10.43.232.31/24`. Build under test:
`dist/EasyGateway-lan-debug.apk` (SHA-256
`713F7C868F74C343F0D64330E65A48B2F4793843A3C904D3DEA86F36F94D93C6`), API base
`http://10.43.232.32:3000`, environment `LAN`, cleartext allowed (debug only).

- Phone Chrome loaded `http://10.43.232.32:3000/healthz` and received
  `{ok:true,database:"connected"}`. ICMP ping is blocked by Windows, so TCP/HTTP was the
  reachability check.
- The backend generated a live sample QR with
  `scanUrl=http://10.43.232.32:3000/import-product/<token>` (LAN host, not localhost).
  A product QR generated through `POST /api/qr-tokens` used
  `http://10.43.232.32:3000/scan/<token>`. Opening that scan URL in the tablet browser
  showed the real product, SKU, stock `11`, price `₹30.00`, and no unit cost.
- The live sample token was delivered through the app's real
  `easygateway://import-product/<token>` deep link. The app imported `Toor Dal 1 kg`
  (`DEMO-217925`) as a removable `QR SAMPLE`; the same row appeared in website inventory
  and in the website `/api/bootstrap` response for the same shop.
- An audited stock adjustment in the app (`Local Sync Test Product`, `-1`, reason
  `LAN sync verification`) changed stock from `12` to `11`. The website then showed the
  same product at `11`, 3 active products, and stock value `₹3,270.00`.
- A separate backend started with `PUBLIC_APP_URL=http://localhost:3000` returned HTTP
  `412` for QR generation with the clear "phone cannot open localhost" message. The
  running LAN server continued to generate LAN URLs.
- Backend tests `19/19`, Android tests `35/35`, and the build completed with
  `BUILD SUCCESSFUL`.

Screenshots from this run are in [`docs/evidence/`](docs/evidence/):

| File | Shows |
| --- | --- |
| `device-chrome-health.png` | Phone Chrome opening the LAN `/healthz` endpoint |
| `device-scan-page.png` | One-time product QR scan page opened on the phone over the LAN |
| `device-app-inventory-sync.png` | App inventory after the QR import and stock adjustment |
| `website-inventory-sync.png` | Website inventory with the matching 3 products and stock value |
| `product-qr-lan.json` | Server response containing the LAN `scanUrl` |
| `sample-import-qr-lan.json` | Sample import QR response with the LAN import URL |

#### Physical camera limitation

The native scanner activity opened and camera permission worked, but the tablet's rear
camera was aimed at a dark surface/ceiling and could not be aimed remotely at the QR on the
PC screen. A literal optical decode on the physical device therefore remains a manual check.
The exact server-issued QR payload was instead delivered through the app's real deep-link
import path, which uses the same token validation and consume route as a camera result.
To finish the optical check, open the QR on the PC, start **Inventory -> Scan QR** on the
tablet, and point the tablet at the screen.

The full local-network procedure, database export/import guidance, firewall notes and the
production-HTTPS switch are in [`docs/LOCAL-NETWORK.md`](docs/LOCAL-NETWORK.md).

---

## Release build and signing

Build an unsigned release APK to check release compilation:

```powershell
npm run android:build:release
```

Output: `dist/EasyGateway-production-release.apk` (unsigned unless signing is configured).

To distribute, create a keystore and add a signing config:

```powershell
keytool -genkeypair -v -keystore easy-gateway-release.jks -alias easy-gateway `
  -keyalg RSA -keysize 2048 -validity 10000
```

Then add a `signingConfigs.release` block in `android/app/build.gradle` and reference it
from `buildTypes.release`. Keep the keystore and passwords outside the repository.

Get the SHA-256 fingerprint for App Links:

```powershell
keytool -list -v -keystore easy-gateway-release.jks -alias easy-gateway
```

Release builds must use `--env production`. The build script rejects release + HTTP.

---

## Deep links and App Links

The custom scheme works immediately:

```text
easygateway://shop/<slug>
easygateway://import-product/<token>
easygateway://scan/<token>
```

HTTPS App Links (`https://easy-gateway.onrender.com/shop/...` and
`.../import-product/...`) additionally require the backend to serve
`https://easy-gateway.onrender.com/.well-known/assetlinks.json` with the app's signing
certificate SHA-256 fingerprint. Until that file exists, Android cannot verify the host
and HTTPS links may open in a browser instead of the app. The in-app scanner is unaffected.

This is an optional backend deployment step, documented separately in
[`docs/BACKEND-CHANGES.md`](docs/BACKEND-CHANGES.md). The original backend was not edited.

---

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Build cannot find SDK | Set `ANDROID_HOME` to the SDK with Platform 36 |
| Build cannot find a suitable JDK | Set `EASY_GATEWAY_JAVA_HOME` to a JDK 17+ |
| Emulator build cannot reach API | Start the backend on the host; use `10.0.2.2:3000`, not `localhost` |
| Phone build cannot reach API | Same Wi-Fi, correct `--lan-ip`, backend bound to `0.0.0.0`, firewall open |
| Login appears to do nothing | Check the in-app Settings connection test and logcat |
| HTTPS link opens browser | Expected until `assetlinks.json` is deployed; use the in-app scanner or `easygateway://` |
| "Check before retrying" | The request timed out; verify the record on the server before repeating a mutation |

Useful commands:

```powershell
adb devices
adb install -r dist/EasyGateway-production-debug.apk
adb logcat -s Capacitor/Console Capacitor/Plugin
adb shell am start -n com.easygateway.app/.MainActivity
```

---

## Known limitations

- A release APK is unsigned until a signing key is configured.
- App Links verification needs the optional backend `assetlinks.json`.
- Sales, stock receipts, and loyalty redemptions are idempotent, but the app still does not
  auto-retry an ambiguous mutation; the operator should verify the record before repeating
  an unrelated action.
- Production live-account mutations were not exercised because no production credentials
  were provided. A disposable local account was used for the LAN stock-adjustment test.
- A literal optical QR decode on the physical tablet was not captured because the camera
  could not be aimed at the PC screen remotely; the same payload was verified through the
  app's deep-link import path. See the physical-device section above.
- The original web project remains the source of truth for business logic; future UI
  changes must be re-applied to `www/index.html` and re-verified with `npm test`.
