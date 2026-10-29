# Easy Gateway Android

Android application for the Easy Gateway retail manager. It bundles the Easy Gateway web UI in a Capacitor WebView and connects to the same Express API and PostgreSQL database as the website.

- Package ID: `com.easygateway.app`
- Version: `1.0.0` (`versionCode` 1)
- Minimum Android: 8.0 (API 26)
- Target/compile SDK: 36
- Capacitor: 8.5.3
- Gradle: 8.14.3

The Android source lives only on the `feature/easy-gateway-android` branch.

## Architecture

```text
Android app (Capacitor WebView)
  │  HTTPS + native HTTP bridge + server session cookie
  ▼
Express API  ──────►  PostgreSQL (authoritative database)
```

- The app never connects to PostgreSQL directly and never receives database credentials.
- The website and app share the same API, business rules and database records.
- Live requests go through `EasyGatewayNativePlugin`, not WebView `fetch()`.

### Why a native HTTP bridge is used

The WebView runs at `https://localhost`, while the API is on another origin. The backend intentionally has no permissive CORS and uses an HTTP-only, `SameSite=Lax` session cookie, so a normal `fetch()` from the WebView would fail.

The native bridge:

- keeps the session cookie in app-private SharedPreferences;
- never exposes `Set-Cookie` values to JavaScript;
- sends no browser `Origin` header;
- enforces HTTPS outside debug builds;
- never disables TLS verification;
- never retries a mutation automatically.

No backend CORS or cookie change is required.

## Requirements

- Node.js 22 or newer (Node 24 verified).
- JDK 17 or newer; the build script prefers JDK 21 (Temurin 21 verified).
- Android SDK Platform 36 and Build Tools 36.
- Android device or emulator running Android 8.0+.
- `adb` from Android SDK Platform Tools.
- Android Studio is optional.

Set the toolchain if auto-detection fails:

```powershell
$env:EASY_GATEWAY_JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
```

Use your own installed JDK path.

## Quick start

```powershell
cd android-app
npm install
npm test
npm run verify:web
npm run android:build
npm run android:install
```

`npm run android:build` runs `verify:web`, runs `npx cap sync android`, builds with Gradle, and copies the APK to `dist/`.

Build outputs:

```text
dist/EasyGateway-production-debug.apk    Production API, debug-signed
dist/EasyGateway-emulator-debug.apk      Emulator and host backend
dist/EasyGateway-lan-debug.apk           Physical phone on the same LAN
dist/EasyGateway-production-release.apk  Release build; unsigned unless signing is configured
```

The debug APK is signed with the standard Android debug key. It is installable for testing, but it is not a Play Store artifact.

### Build for an emulator

```powershell
npm run android:build:emulator
adb install -r dist/EasyGateway-emulator-debug.apk
```

Uses `http://10.0.2.2:3000`, which maps to the host machine. `localhost` inside the emulator refers to the emulator itself. Cleartext HTTP is allowed only in this debug build.

### Build for a phone on the same LAN

```powershell
npm run android:build:lan
# equivalent to:
node scripts/build-android.mjs --env lan --lan-ip auto --port 3000
```

To pin the address:

```powershell
node scripts/build-android.mjs --env lan --lan-ip 192.168.1.20 --port 3000
```

Replace `192.168.1.20` with the development PC's private address. The phone and PC must share the network, and the backend must be reachable on TCP 3000. `localhost`, public HTTP hosts and credentials in the URL are rejected.

See [`docs/LOCAL-NETWORK.md`](docs/LOCAL-NETWORK.md) for the full local setup, firewall and production-switch procedure.

## API configuration

API endpoints are compiled into the APK as `BuildConfig` values. They cannot be changed from the UI.

| Build | API base URL | Cleartext | Intended use |
|---|---|---|---|
| `production` | `https://easy-gateway.onrender.com` | blocked | Normal app and release |
| `emulator` | `http://10.0.2.2:3000` | debug only | Local backend from the emulator |
| `lan` | `http://<lan-ip>:3000` | debug only | Local backend from a physical phone |
| custom | `--api-base-url https://...` | HTTPS only | Staging endpoint |

Validation lives in `config/environments.mjs` and fails closed:

- production must use HTTPS;
- HTTP is accepted only for a debug build that explicitly opts in;
- HTTP hosts must be private LAN or emulator addresses;
- credentials, paths, query strings and fragments in the base URL are rejected;
- `localhost` and `127.0.0.1` are rejected as app endpoints.

`android/app/src/main/res/xml/network_security_config.xml` blocks cleartext for normal builds. Only `android/app/src/debug/res/xml/network_security_config.xml` permits it for explicit LAN/emulator builds.

## Android features

- Login, registration, sessions, dashboard, inventory, product editing and audited stock adjustments.
- Sell | Stocking modes, cart checkout and supplier stock receipts.
- Serialized products, serial entry, duplicate detection and barcode/SKU lookup.
- Expiry tracking, recycle bin, notifications and date-filtered waste reports.
- Sales, purchasing, suppliers, customers and loyalty vouchers.
- Customer storefront, order requests, tracking and status updates.
- Demo Mode isolated from live data.
- Native camera QR scanning through `@capacitor/barcode-scanner` (ZXing).
- Save/share QR images and CSV files through Android storage and the share sheet.
- Mobile layout with safe areas, bottom navigation and table-to-card conversion.
- Deep links using `easygateway://`.

## Project layout

```text
android-app/
  package.json                  npm scripts and Capacitor dependencies
  capacitor.config.ts           app ID, bundled web directory, HTTPS WebView scheme
  config/environments.mjs       API environment resolution and validation
  www/
    index.html                  Bundled Easy Gateway UI with Android adaptations
    core.js                     Testable QR/CSV/filter/import helpers
    app-features.js             Shared Sell/Stocking/loyalty/waste/order tools
    retail-core.js              Shared retail rules
    manifest.webmanifest
    icons/
  android/                      Capacitor Android project
    app/src/main/AndroidManifest.xml
    app/src/main/java/com/easygateway/app/
      MainActivity.java
      EasyGatewayNativePlugin.java
    app/src/main/res/xml/network_security_config.xml
    app/src/debug/res/xml/network_security_config.xml
  scripts/
    build-android.mjs           Environment-aware sync, Gradle build and APK copy
    verify-web.mjs              Structural and security checks before building
  tests/
    core.test.mjs               QR parsing, CSV, filters, import routes
    config.test.mjs             Environment validation
    app-invariants.test.mjs     UI wiring, native/config invariants
  docs/
    LOCAL-NETWORK.md            PC + phone LAN setup and production switch
    BACKEND-CHANGES.md          Optional App Links backend change
  dist/                         Built APKs (ignored by Git)
```

## QR workflow

1. Open **Product QR generator**.
2. Press **Generate random product QR**. Details are generated by the backend.
3. Scan with **Scan QR with camera** in the app, or with another device.
4. In Live Mode the sample is added to the signed-in shop. In Demo Mode it stays local.
5. Imported samples are marked **QR SAMPLE** and can be removed.

Accepted payloads:

```text
https://easy-gateway.onrender.com/import-product/<token>
https://easy-gateway.onrender.com/import-product/<token>?mode=demo
https://easy-gateway.onrender.com/scan/<token>
...?scanToken=<token> (optionally with &mode=demo)
easygateway://import-product/<token>
easygateway://scan/<token>
```

The `mode=demo` marker comes from the QR payload, not from a server error message. It selects the sandbox route and blocks cross-mode imports before any request is made. Links with embedded credentials, an unexpected host or plain HTTP are rejected. The scanner sends only the token to the backend and never trusts product details embedded in a QR.

If a live QR is scanned while signed out, the token is kept as a pending scan and only consumed after a successful sign-in.

Saved files:

```text
Pictures/Easy Gateway/easy-gateway-sample-product.png
Download/Easy Gateway/easy-gateway-inventory.csv
Download/Easy Gateway/easy-gateway-waste-report-<from>-to-<to>.csv
```

## Demo Mode isolation

- Demo data lives in `sessionStorage`, keyed per app session.
- Demo mutations are handled by the local `demoApi()` implementation.
- The only live endpoints used while issuing/importing a demo sample are the sample-QR issue endpoint and the demo preview consume endpoint.
- Every demo QR carries `?mode=demo`; the app stores that marker with the pending token.
- A demo QR cannot be sent to the live consume route, and a live QR cannot be sent to the demo preview route.
- Scanning a demo QR in Live Mode switches to Demo Mode. Scanning a live QR in Demo Mode is refused with an explanation and no request.
- Imported samples are tagged and removable without touching real stock.
- Turning Demo Mode off clears demo QR state and returns to the real account.

## Data-safety behaviour

Sales, stock receipts and loyalty redemptions accept an idempotency key on the backend. The app sends a key with those mutations so an ambiguous retry cannot duplicate a completed operation.

The app still follows conservative client rules:

- no automatic retry of POST/PUT/DELETE requests;
- busy guards prevent accidental double taps;
- request timeouts ask the operator to check whether the operation completed before retrying;
- ambiguous failures are shown instead of silently replaying a request.

## Tests and verification

```powershell
npm test
npm run verify:web
npm run android:build
```

- `npm test` runs the Android unit and contract tests.
- `npm run verify:web` runs structural and security checks on the bundled UI.
- `npm run android:build` repeats `verify:web` before Gradle.

Covered by tests:

- QR token/host parsing, including look-alike hosts, embedded-credential URLs and wrong token lengths;
- `mode=demo` handling on HTTPS and `easygateway://` links;
- same-mode versus cross-mode import errors;
- CSV quoting and formula-injection protection;
- inventory filter semantics;
- demo vs live import route selection;
- API environment validation;
- UI action handlers;
- native scanner, CSV and PNG bridges;
- release cleartext blocking and camera permission;
- shared shop tools and Demo Mode error handling;
- absence of a development server default in the bundled source.

## Release build and signing

Build an unsigned release APK to check release compilation:

```powershell
npm run android:build:release
```

Output: `dist/EasyGateway-production-release.apk`. This is **unsigned** unless a signing configuration is added.

This repository does not contain a release keystore. To distribute a production app, the owner must:

1. Create a keystore outside the repository:

   ```powershell
   keytool -genkeypair -v -keystore easy-gateway-release.jks -alias easy-gateway `
     -keyalg RSA -keysize 2048 -validity 10000
   ```

2. Store the keystore and passwords in a secrets manager or CI secret store.
3. Add a `signingConfigs.release` block in `android/app/build.gradle`, read passwords from environment variables or Gradle properties, and reference it from `buildTypes.release`.
4. Build with `npm run android:build:release`.
5. Verify with `apksigner verify --print-certs`.
6. Keep the same signing identity for every update; losing it prevents Play Store updates.

Never commit the keystore, passwords or `google-services.json` with private credentials. Release builds must use `--env production`; the build script rejects release + HTTP.

## Deep links and App Links

The custom scheme works immediately:

```text
easygateway://shop/<slug>
easygateway://import-product/<token>
easygateway://scan/<token>
```

HTTPS App Links for the production host also require the backend to serve `/.well-known/assetlinks.json` with the app's signing certificate SHA-256 fingerprint. Until that file is deployed, HTTPS links may open in a browser instead of the app. The in-app scanner is unaffected.

This optional backend step is documented in [`docs/BACKEND-CHANGES.md`](docs/BACKEND-CHANGES.md).

## Troubleshooting

| Symptom | Check |
|---|---|
| Build cannot find the SDK | Set `ANDROID_HOME` to an SDK with Platform 36 and Build Tools 36. |
| Build cannot find a suitable JDK | Set `EASY_GATEWAY_JAVA_HOME` or `JAVA_HOME` to JDK 17+ (JDK 21 preferred). |
| Emulator cannot reach the API | Start the backend on the host and use `10.0.2.2:3000`. |
| Phone cannot reach the API | Same Wi-Fi, correct `--lan-ip`, backend listening on all interfaces, firewall allows TCP 3000. |
| `adb devices` is empty or unauthorized | Enable USB debugging and accept the prompt. |
| Install fails with a signature mismatch | Uninstall the previous copy: `adb uninstall com.easygateway.app`. |
| Login appears to do nothing | Use the in-app Settings connection test and check logcat. |
| Camera scan fails | Grant camera permission in Android settings. |
| HTTPS link opens a browser | Deploy `assetlinks.json`, or use the in-app scanner / `easygateway://`. |
| "Check before retrying" | The request timed out; verify the record on the server before repeating a mutation. |

Useful commands:

```powershell
adb devices
adb install -r dist/EasyGateway-production-debug.apk
adb logcat -s Capacitor/Console Capacitor/Plugin
adb shell am start -n com.easygateway.app/.MainActivity
```

## Known limitations

- Release APKs are unsigned until a signing key is configured.
- App Links verification needs the optional backend `assetlinks.json`.
- The app is a Capacitor WebView shell, not a separately written native UI.
- The app does not auto-retry ambiguous mutations; the operator must verify the record first.
- Email delivery depends on an external SMTP or Resend account and a verified sender.
- No UHF RFID hardware integration exists; barcode/QR scanning is the supported input.
- No iOS application is included.
- No Play Store listing or device-specific QA for every vendor is included.
- The website remains the source of truth for business logic. Future UI changes must be re-applied to `www/index.html` and re-verified with `npm test`.
