# Easy Gateway

Easy Gateway is a shop-management app for small, independent retailers such as grocery, stationery, household-goods, electronics and clothing stores. It brings inventory, sales, expiry control, purchasing, customer orders and loyalty records into one place.

This branch contains **both** the website/backend and the Android application:

- Browser app served by Express (`index.html`, `app-features.js`).
- Shared retail rules in `lib/retail-core.js`.
- Express 5 API and PostgreSQL schema (`server.js`).
- Android app source in `android-app/`.
- Automated tests and GitHub Actions validation.

This is a working MVP, not a finished commercial platform. Read the limitations before using it for real business, financial or regulated data.

## Architecture

```text
Android app (Capacitor WebView)
  │  HTTPS + native HTTP bridge + server session cookie
  ▼
Express API (Node.js)  ──────►  PostgreSQL (authoritative database)
  ▲
  │  HTTPS / local HTTP
Browser (website)
```

- The website and Android app use the **same** Express API and the **same** PostgreSQL database.
- Only the backend connects to PostgreSQL. The app never receives database credentials.
- The Android app bundles the web UI in a Capacitor WebView but sends API requests through a native bridge (`EasyGatewayNativePlugin`). The bridge keeps the server session cookie in app-private storage, sends no browser `Origin` header, and never exposes `Set-Cookie` values to JavaScript.
- Production builds require HTTPS and block cleartext traffic.
- There is one backend, one database and one set of business rules; the app does not keep a separate copy of live shop data.

## The problem it solves

| Problem | How Easy Gateway helps |
|---|---|
| **Stockouts** | Tracks stock and reorder levels, highlights low stock, and suggests purchase quantities from sales history and lead time. |
| **Expired products** | Records expiry dates, moves expired stock to a recycle bin, and estimates the cost written off. |
| **Manual records** | Stores products, sales, customers, suppliers, orders and loyalty entries in PostgreSQL. |
| **Lost customers** | Provides a public shop catalogue, customer order requests, order status updates, and loyalty coins with redeemable vouchers. |

## Website features on this branch

### Accounts and shop isolation

- Registration creates a shop workspace and an owner account.
- Sign-in and sign-out use PostgreSQL-backed server sessions with HTTP-only cookies.
- Passwords are bcrypt hashes, not plaintext.
- Every API read and write is scoped to the signed-in shop.

### Inventory, Sell and Stocking

- Add products with SKU, category, unit, stock, reorder level, unit cost, selling price, supplier lead time and optional expiry.
- Search inventory, filter low-stock/expiring/QR-sample products, and export CSV.
- Record audited stock adjustments with a reason.
- **Sell** provides a cart checkout that decrements stock in a transaction.
- **Stocking** records supplier receipts with a supplier reference, unit cost, optional expiry and an idempotency key, so a retried submit does not add stock twice.
- Products can track individual serial numbers. Serialized products start at zero stock; each unit is received with its own serial and sold by scanning that serial.
- Duplicate serials are rejected within one receipt and across the shop.

### Barcode, SKU and serialized-unit lookup

- Product lookup resolves a barcode/SKU to a normal product or to a specific in-stock serialized unit.
- A serialized sale requires exactly one in-stock serial per unit and rejects duplicate serials in the same cart.
- Already-sold, returned-to-stock and unknown serials are rejected with a clear message; stock changes only for a valid serial.
- Shared rules live in `lib/retail-core.js` and are loaded by both the website and the Android app.

### Sales and loyalty vouchers

- Record sales against active stock inside a database transaction.
- Add a customer name to create or update a customer record.
- Award loyalty coins per product line using the shop threshold. Default: **1 coin per ₹100 spent on a line**, rounded down.
- Redeem coins from a fixed server-side voucher catalogue:
  - `SAVE50`: 100 coins for a ₹50 voucher.
  - `SAVE150`: 250 coins for a ₹150 voucher.
  - `SAVE350`: 500 coins for a ₹350 voucher.
- Redemption is idempotent and guarded against spending the same coins twice.
- Loyalty is not awarded for pending, declined, failed or Demo Mode transactions.
- Vouchers are counter-redemption records only. Easy Gateway does not process payments or refunds.

### Suppliers and purchase planning

- Maintain a supplier directory with contacts, categories, lead times and minimum order values.
- Calculate replenishment from stock, reorder buffer, 30-day sales, lead time and outstanding purchase orders.
- Create internal purchase-order drafts and receive stock against them.
- An optional rule prepares an approved internal order when automatic purchasing is enabled and the total is within the configured limit.
- Larger orders create a notification for review.

**Supplier limitation:** no supplier network, external purchase-order submission, supplier email/WhatsApp, or supplier payment integration exists. The automation creates an internal record only.

### Expiry management and recycle bin

- Save an expiry date on each product.
- Expiry sweeps run on API activity and on an in-process timer while the web service is awake.
- An expired product is deactivated, its remaining stock is snapshotted into the recycle bin, and a notification is created.
- Expired products cannot be sold and are hidden from active inventory.
- Restoring requires a corrected expiry date that is valid and not in the past.
- The recycle bin can also record the quantity and cost actually disposed of, once per record.

Expiry is still attached to a product, not to separate supplier batches. Shops that need batch-level tracking must add that data model before relying on this for food-safety or regulated workflows.

### Expiry-waste reporting

- A date-filtered report covers the summary, monthly trend, product table, CSV export and recorded waste.
- Estimated loss is the quantity at expiry multiplied by the saved unit cost.
- Recorded waste appears only when the shop entered what was actually disposed of, with its own quantity and cost.
- Restored, reversed or deleted recycle-bin records are excluded.
- Values are estimates of inventory cost written off, not missed revenue or guaranteed lost profit.
- The report uses real records; Demo Mode has its own sample snapshots.

### QR sample generation and import

- The Product QR screen generates a fictional product with a random demo SKU, quantity, prices, category, lead time and optional expiry.
- A phone camera scans the QR and imports the sample into the signed-in shop. If the phone is signed out, the token is held until sign-in succeeds.
- Imported samples are tagged **QR SAMPLE** and can be removed afterwards.
- SKU collisions do not overwrite existing products.
- Tokens expire after 15 minutes or one successful import. The database stores token hashes, not raw tokens.
- QR links are built from `PUBLIC_APP_URL`. If it points at `localhost`, `127.0.0.1` or another loopback address, the QR routes return HTTP 412 instead of issuing a QR the phone cannot open.
- Demo-only QR codes can only import into the local demo sandbox.
- The website displays the QR; camera scanning is provided by the Android app or the phone's camera app.

### Customer storefront and orders

- Each shop has a public catalogue at `/shop/<shop-slug>`.
- Customers can search the catalogue, add products to a basket, and send an order request with name, phone, email, delivery/pickup address and optional notes.
- Orders start as **requested** / **Awaiting shop confirmation**.
- Retailers can accept, decline, mark ready, fulfil or cancel an order. Invalid status jumps are rejected by the server.
- Customers can track an order with the order reference **and** the phone number used on the request.
- This is an order-request flow only: no payment is collected and stock is not reserved.
- The public catalogue does not expose unit cost or exact stock quantities.
- Order confirmation and status emails are written to a transactional outbox. Delivery requires `SMTP_URL` or `RESEND_API_KEY`. Without a provider, the UI reports `queued`/`not_sent` and does not claim the message was delivered.

### Daily sales reporting

- Show recorded sales by calendar day.
- Compare a day's revenue with the prior two to three non-zero days and flag unusual changes.
- This is a transparent rule-based baseline, not trained AI forecasting.

### Demo Mode

- Demo Mode is a browser-local sandbox stored in `sessionStorage`.
- It never reads or writes live PostgreSQL inventory, sales, customers, orders or loyalty ledgers.
- The demo seed includes near-expiry, normal, expired/recycle-bin, waste-report, customer-order and loyalty examples.
- Open `http://<host>:3000/?mode=demo` for the retailer demo, or add `?mode=demo` to a shop page for the customer demo.
- Demo receipts, sales, redemptions, orders and waste records are labelled as sample data and disappear when the demo data is reset.

### Notifications and email

- Expiry, stock-adjustment, purchase-order, loyalty and automation-limit notifications are saved to PostgreSQL.
- The website and Android app show unread notifications.
- Order email uses a transactional outbox with retry, deduplication and HTML escaping.
- Delivery requires `SMTP_URL` (nodemailer) or `RESEND_API_KEY` (HTTP fallback).
- Without a provider, email stays queued/not_sent. SMS and native push are not configured.

## Android app

The source is in **`android-app/`**. It is a Capacitor shell around the same web UI and API, with Android-specific adaptations.

### Included behaviour

- Login, registration, sessions, dashboard, inventory, product edit and stock adjustments.
- Sell | Stocking modes, cart checkout and stock receipts.
- Serialized products, serial entry, duplicate detection and barcode/SKU lookup.
- Expiry, recycle bin, notifications and date-filtered waste reports.
- Sales, purchasing, suppliers, customers and loyalty vouchers.
- Customer storefront, order requests, order tracking and status updates.
- Demo Mode with the same live-data isolation rules as the website.
- Native camera QR scanning through `@capacitor/barcode-scanner` (ZXing).
- Save/share QR images and CSV files through Android storage and the share sheet.
- Mobile layout with safe-area handling, a bottom tab bar and table-to-card conversion.
- Deep links: `easygateway://shop/<slug>`, `easygateway://import-product/<token>`, `easygateway://scan/<token>`.

### Why the app uses a native bridge

The Capacitor WebView runs at `https://localhost`, while the API is on another origin. The backend intentionally has no permissive CORS and uses an HTTP-only, `SameSite=Lax` session cookie. A normal WebView `fetch()` would fail. The native bridge:

- keeps the session cookie in app-private SharedPreferences;
- never exposes the cookie to JavaScript;
- sends no browser `Origin` header;
- enforces HTTPS outside debug builds;
- never disables TLS verification;
- never retries a mutation automatically.

No backend CORS or cookie weakening is required.

## Technologies used

| Layer | Technology |
|---|---|
| Website | HTML, CSS and plain JavaScript; no bundler |
| Backend | Node.js 24 and Express 5 |
| Database | PostgreSQL 18 |
| Authentication | `bcryptjs`, `express-session`, `connect-pg-simple` |
| Security | `helmet`, `express-rate-limit`, same-origin mutation checks, parameterized SQL, shop-scoped queries |
| QR codes | `qrcode` on the server; ZXing camera scanning on Android |
| Email | `nodemailer` SMTP or Resend HTTP fallback, with a transactional outbox |
| Android | Capacitor 8.5.3, Android SDK 36, Gradle 8.14.3, Java 17+ (JDK 21 verified) |
| Hosting | Render Blueprint (`render.yaml`) |
| CI | GitHub Actions (`.github/workflows/validate.yml`) |

## Prerequisites

### Website and backend

- Git.
- **Node.js 24.x** and its bundled npm. The root `package.json` requires Node 24.
- **PostgreSQL 18** running locally or reachable over the network, with a role that can create tables.
- PowerShell 5.1+ on Windows for the copyable commands below.
- No Docker setup is included.

### Android build

- **Node.js 22 or newer** in `android-app/` (Node 24 verified).
- **JDK 17 or newer**; the build script prefers JDK 21 and was verified with Eclipse Temurin 21.
- **Android SDK Platform 36** and **Build Tools 36**.
- **Android Studio** is optional; the Gradle wrapper and command-line SDK are enough.
- **Android 8.0 (API 26) or newer** on a device or emulator.
- `adb` from Android SDK Platform Tools for install and device checks.

Check the main tools:

```powershell
git --version
node --version
npm --version
java -version
adb version
```

## Easy local setup on Windows

### 1. Get the project

```powershell
git clone https://github.com/Shrishant1cog/TripleThreat01.git
cd TripleThreat01
git switch feature/easy-gateway-android
```

If the project already exists locally, open it and confirm the branch:

```powershell
git status
git branch --show-current
```

### 2. Install website dependencies

```powershell
npm install
```

### 3. Create the PostgreSQL database

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "CREATE DATABASE easy_gateway;"
```

If the database already exists, do not drop it. The server applies additive schema changes (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`) under a PostgreSQL advisory lock. It does not reset existing records.

### 4. Create the environment file

```powershell
Copy-Item .env.example .env
notepad .env
```

Minimum local configuration:

```dotenv
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/easy_gateway
SESSION_SECRET=replace-with-a-long-random-secret
DATABASE_SSL=false
PUBLIC_APP_URL=
```

Leave `SMTP_URL`, `EMAIL_FROM` and `RESEND_API_KEY` unset unless you have a real email provider. Never commit `.env`.

### 5. Start the website

```powershell
npm start
```

For automatic restart while editing:

```powershell
npm run dev
```

### 6. Verify

```powershell
curl.exe http://127.0.0.1:3000/healthz
```

Expected:

```json
{"ok":true,"service":"easy-gateway","database":"connected","time":"..."}
```

Open [http://localhost:3000](http://localhost:3000), register a shop and add products.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | **Yes** | PostgreSQL connection string. Startup fails without it. |
| `SESSION_SECRET` | **Yes** in production | Signs session cookies. A development fallback is used only when `NODE_ENV=development` and `RENDER` is unset. |
| `NODE_ENV` | Recommended | `development` locally, `production` on a hosted deployment. |
| `PORT` | No | HTTP port. Default `3000`. |
| `DATABASE_SSL` | No | Set `true` when the database requires TLS. |
| `PG_POOL_MAX` | No | Maximum PostgreSQL pool connections. Default `8`. |
| `PUBLIC_APP_URL` | No | Base URL for QR links. Must be phone-reachable for LAN testing, for example `http://192.168.1.20:3000`, or the public HTTPS URL. Loopback values are rejected by the QR routes. |
| `SMTP_URL` | No | SMTP connection string for order email, for example `smtps://user:pass@smtp.example.com:465`. Tried before the Resend fallback. |
| `EMAIL_FROM` | No | From header for order email. Use a sender your provider has verified. |
| `RESEND_API_KEY` | No | Enables the Resend HTTP fallback when `SMTP_URL` is unset. |

`RENDER` is set automatically by Render and is not normally configured by hand. URL-encode special characters in database or SMTP passwords.

## How to use Easy Gateway

1. **Register a shop.** Create the owner account with a password of at least 10 characters.
2. **Add inventory.** Use **Inventory → Add product** for SKU, category, unit, stock, reorder level, cost, price, lead time and expiry. Enable serial tracking where each unit needs its own identifier.
3. **Sell.** Open **Sell**, add products or scan a serial, choose quantities, optionally add a customer, and complete the sale. Stock and loyalty entries are written in one transaction.
4. **Receive stock.** Open **Stocking**, enter the supplier reference, unit cost, expiry and serials, and submit. Reusing the same idempotency key does not duplicate the receipt.
5. **Plan purchases.** Review the suggested plan, create an internal draft order and receive it when stock arrives.
6. **Manage expiry.** Use **Expiry & recycle bin** to review expired products, correct dates and restore items. Record actual disposal where known.
7. **Review waste.** Open **Expiry waste report**, select a date range, compare estimated and recorded loss, and export CSV.
8. **Reward customers.** Open **Loyalty coins**, review balances, and redeem a fixed voucher for a customer. The voucher is recorded in the ledger.
9. **Process customer orders.** Share `/shop/<slug>` with customers. In **Customer order requests**, accept or decline a request, mark it ready, fulfil it or cancel it.
10. **Generate a sample QR.** Open **Product QR generator**, generate a sample and scan it with the Android app or a phone camera. Remove the tagged sample when finished.
11. **Try Demo Mode.** Add `?mode=demo` to the site URL. Nothing in the live database changes.

## Android setup, build and install

All Android commands run from the `android-app` folder.

### 1. Install Android dependencies

```powershell
cd android-app
npm install
```

### 2. Point the build at Java and the Android SDK

The build script looks for `EASY_GATEWAY_JAVA_HOME`, `ANDROID_HOME` and the default SDK location. Set them explicitly if auto-detection fails:

```powershell
$env:EASY_GATEWAY_JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
```

Use your own installed JDK path. JDK 17 or newer is required; JDK 21 is preferred.

### 3. Run Android checks

```powershell
npm test
npm run verify:web
```

`npm test` runs the Android unit and contract tests. `npm run verify:web` checks the bundled UI for missing action handlers, unsafe release networking and Demo Mode regressions.

### 4. Build the production debug APK

```powershell
npm run android:build
```

This command:

1. Runs `verify:web`.
2. Runs `npx cap sync android`.
3. Builds with Gradle using `https://easy-gateway.onrender.com`.
4. Copies the APK to `android-app/dist/EasyGateway-production-debug.apk`.

The debug APK is signed with the standard Android debug key. It is installable for testing, but it is **not** a Play Store or production release.

### 5. Install on a device

```powershell
adb devices
adb install -r dist/EasyGateway-production-debug.apk
```

Or use the provided script:

```powershell
npm run android:install
```

If `adb devices` shows `unauthorized`, unlock the phone and accept the USB debugging prompt. If installation fails with a signature mismatch, uninstall the previous copy first (`adb uninstall com.easygateway.app`).

### 6. Open the app

The package ID is `com.easygateway.app`, version `1.0.0` (`versionCode` 1). The app opens the bundled UI and connects to the production API.

Useful checks:

```powershell
adb shell dumpsys package com.easygateway.app | Select-String versionName,versionCode
adb logcat -s Capacitor/Console Capacitor/Plugin
```

## Production HTTPS configuration

The production build embeds:

```text
API base URL: https://easy-gateway.onrender.com
Environment:  Production
Cleartext:    blocked
```

- `npm run android:build` and `npm run android:build:prod` both use production configuration.
- Release builds must use `--env production`; the build script rejects release builds with HTTP.
- `android/app/src/main/res/xml/network_security_config.xml` blocks cleartext for normal builds. Only the debug network-security config permits cleartext for explicit LAN/emulator builds.
- To test a different HTTPS staging server without changing source, pass an origin-only URL:

  ```powershell
  node scripts/build-android.mjs --env production --api-base-url https://staging.example.com
  ```

- To change the official production endpoint, update `PRODUCTION_API_BASE_URL` in `android-app/config/environments.mjs` and the default in `android-app/android/app/build.gradle`, then run the tests and rebuild. The QR host allow-list follows the production constant.

Never embed database credentials, SMTP passwords, API keys or signing passwords in the app. The APK contains only the API origin and build labels.

## Local-network development (PC + phone)

Use this only for testing. It is **not** the production configuration.

### 1. Put the backend on the private network

Set `PUBLIC_APP_URL` to the PC's private Wi-Fi address, not `localhost`:

```dotenv
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://postgres:YOUR_LOCAL_PASSWORD@localhost:5432/easy_gateway
SESSION_SECRET=replace-with-a-long-random-local-secret
DATABASE_SSL=false
PUBLIC_APP_URL=http://192.168.1.20:3000
```

Replace `192.168.1.20` with your PC's address (`10.x`, `172.16-31.x` or `192.168.x`).

### 2. Start the backend and check reachability

```powershell
npm start
curl.exe http://127.0.0.1:3000/healthz
```

From the phone browser, open `http://<pc-lan-ip>:3000/healthz`. The phone and PC must be on the same subnet. Allow TCP 3000 through Windows Firewall for the private network only. No router port forwarding is needed.

### 3. Build the LAN debug APK

Automatic address detection:

```powershell
cd android-app
npm run android:build:lan
```

Explicit address:

```powershell
node scripts/build-android.mjs --env lan --lan-ip 192.168.1.20 --port 3000
```

Output: `android-app/dist/EasyGateway-lan-debug.apk`.

```powershell
adb install -r dist/EasyGateway-lan-debug.apk
```

This build allows cleartext HTTP only for the private address compiled into it. It is a debug artifact.

### 4. Emulator option

```powershell
npm run android:build:emulator
adb install -r dist/EasyGateway-emulator-debug.apk
```

The emulator build uses `http://10.0.2.2:3000`, which maps to the host machine. `localhost` inside the emulator refers to the emulator itself.

The full LAN procedure, including firewall and database-copy guidance, is in [`android-app/docs/LOCAL-NETWORK.md`](android-app/docs/LOCAL-NETWORK.md).

## QR generation, scanning and import

1. Open **Product QR generator** on the website or in the app.
2. Press **Generate random product QR**. The server creates a random sample and returns a QR image.
3. Scan it with **Scan QR with camera** in the Android app, with the phone camera, or with another device.
4. In Live Mode the sample is added to the signed-in shop. In Demo Mode it is added only to the local sandbox.
5. Imported samples are tagged **QR SAMPLE** and can be removed.

The Android scanner accepts:

- `https://easy-gateway.onrender.com/import-product/<token>`
- `https://easy-gateway.onrender.com/import-product/<token>?mode=demo`
- `https://easy-gateway.onrender.com/scan/<token>`
- `...?scanToken=<token>` with an optional `&mode=demo`
- `easygateway://import-product/<token>` and `easygateway://scan/<token>`

The app reads the `mode=demo` marker from the payload, not from an error message. A live QR scanned in Demo Mode is refused without a request; a demo QR scanned in Live Mode switches to Demo Mode. URL credentials, unexpected hosts and plain HTTP links are rejected. The scanner sends only the token to the backend and never trusts product details embedded in a QR.

When an import is refused, the message reflects the real cause: wrong mode, expired/already-scanned token, unknown link or insecure link.

Files saved by the app:

```text
Pictures/Easy Gateway/easy-gateway-sample-product.png
Download/Easy Gateway/easy-gateway-inventory.csv
Download/Easy Gateway/easy-gateway-waste-report-<from>-to-<to>.csv
```

## Demo Mode isolation

- Demo data lives in `sessionStorage`, not PostgreSQL.
- Demo mutations are handled by a local `demoApi()` implementation.
- The only live endpoints used while seeding a demo QR are the sample-QR issue endpoint and the demo preview consume endpoint.
- A QR generated by the backend in demo mode carries `?mode=demo`; the app records that marker with the token.
- The app refuses to send a demo QR to the live import route or a live QR to the demo route, so a mixed-mode scan cannot consume the token or change inventory.
- Scanning a demo QR while Live Mode is on switches to Demo Mode. Scanning a live QR in Demo Mode is blocked with an explanation and no request.
- Imported demo samples are tagged and removable without touching real stock.
- Turning Demo Mode off clears demo QR state and returns to the real signed-in account.

## Testing and verification

### Website and backend

```powershell
npm test
npm run check
npm run test:e2e
node scripts/maintenance.js
```

- `npm test` runs the root unit and contract suites: date validation, shared retail rules, DTO filtering, order transitions and UI contract checks.
- `npm run check` checks `server.js` syntax. The CI workflow also checks `app-features.js`, `lib/retail-core.js` and the inline browser script.
- `npm run test:e2e` requires a running server and the same `DATABASE_URL`. It creates a disposable shop, exercises registration, Sell/Stocking, serials, loyalty, customer orders/email outbox, expiry waste/report and demo isolation, then deletes the test shop. Set `E2E_BASE` if the server is not on `http://127.0.0.1:3000`. Set `E2E_KEEP=1` only when you intentionally want to inspect the test shop. Never run it against production data.
- `node scripts/maintenance.js` runs one expiry sweep and one auto-purchase cycle, then exits.

### Android

```powershell
cd android-app
npm test
npm run verify:web
npm run android:build
```

Android tests cover QR token/host parsing, `mode=demo` handling, CSV quoting and formula-injection protection, inventory filters, demo/live route selection, environment validation, UI action wiring, native scanner/CSV/PNG bridges, release cleartext blocking and the shared shop tools. `verify:web` performs 36 structural and security checks. The build command repeats `verify:web` before Gradle.

GitHub Actions runs the website syntax checks, feature markers and root tests on pushes and pull requests to `main` and `feature/easy-gateway-android`. The live API test and Android Gradle build are local checks because they need PostgreSQL, a JDK and the Android SDK.

## APK outputs and installation

All APKs are written to `android-app/dist/` (ignored by Git):

| Command | Output | Use |
|---|---|---|
| `npm run android:build` | `EasyGateway-production-debug.apk` | Production API, debug-signed, testing |
| `npm run android:build:prod` | `EasyGateway-production-debug.apk` | Same as above |
| `npm run android:build:emulator` | `EasyGateway-emulator-debug.apk` | Emulator + host backend |
| `npm run android:build:lan` | `EasyGateway-lan-debug.apk` | Physical phone + PC on the same Wi-Fi |
| `npm run android:build:release` | `EasyGateway-production-release.apk` | Release compilation; unsigned unless signing is configured |

Install with `adb install -r <path>` or the npm scripts. Verify the package and signer:

```powershell
adb shell dumpsys package com.easygateway.app | Select-String versionName,versionCode
& "$env:ANDROID_HOME\build-tools\36.0.0\apksigner.bat" verify --print-certs dist\EasyGateway-production-debug.apk
```

A debug APK reports a `CN=Android Debug` certificate. That is expected for testing and is not a Play Store signing identity.

## Release signing requirements

This repository does **not** contain a release keystore or a `signingConfigs.release` block. `npm run android:build:release` therefore produces an **unsigned** release APK. Do not label an unsigned APK as installable or production-ready.

To create a signed release, the shop owner or release manager must:

1. Create a keystore **outside the repository**:

   ```powershell
   keytool -genkeypair -v -keystore easy-gateway-release.jks -alias easy-gateway `
     -keyalg RSA -keysize 2048 -validity 10000
   ```

2. Store the keystore and passwords in a secrets manager or CI secret store, never in Git.
3. Add a `signingConfigs.release` block in `android/app/build.gradle`, read passwords from environment variables or Gradle properties, and reference it from `buildTypes.release`.
4. Build with `npm run android:build:release`.
5. Verify with `apksigner verify --print-certs` and confirm the certificate fingerprint.
6. Keep the same signing identity for every future update. Losing it prevents Play Store updates.
7. For HTTPS App Links, publish `/.well-known/assetlinks.json` with the release certificate SHA-256 fingerprint. Until then, HTTPS links may open in a browser; the custom `easygateway://` scheme and the in-app scanner still work.

Never commit a keystore, signing password, service-account file or `google-services.json` with private credentials.

## Troubleshooting

### Website

| Symptom | Check |
|---|---|
| `DATABASE_URL is missing` | `.env` must be in the project root and contain `DATABASE_URL`. Restart after editing. |
| `ECONNREFUSED` | PostgreSQL is not running, or the host/port in `DATABASE_URL` is wrong. |
| `password authentication failed` | Check the role, password and database name; URL-encode special characters. |
| SSL/TLS error | Set `DATABASE_SSL=true` only if the provider requires TLS. |
| `EADDRINUSE` | Another process uses port 3000. Stop it or set a different `PORT`. |
| QR route returns HTTP 412 | `PUBLIC_APP_URL` is loopback. Use the PC's LAN address or the public HTTPS URL. |
| Sign-in works but API returns 401 | Cookies are blocked, or the page and API are on different origins. Use one host and port. |
| `permission denied for schema public` | The database role cannot create tables. Grant permissions or use the owner role. |
| Email shows `queued`/`not_sent` | No `SMTP_URL` or `RESEND_API_KEY` is configured, or the provider rejected the message. Check server logs. |
| Customer cannot track an order | The reference and the phone number must both match the request. |

### Android

| Symptom | Check |
|---|---|
| Build cannot find the SDK | Set `ANDROID_HOME` to an SDK with Platform 36 and Build Tools 36. |
| Build cannot find a suitable JDK | Set `EASY_GATEWAY_JAVA_HOME` or `JAVA_HOME` to JDK 17+ (JDK 21 preferred). |
| `adb devices` is empty or `unauthorized` | Enable USB debugging, accept the prompt, and install the device driver if needed. |
| Install fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | A copy signed with another key is installed. Uninstall it first. |
| Emulator cannot reach the API | Start the backend on the host and use `10.0.2.2:3000`, not `localhost`. |
| Phone cannot reach the API | Same Wi-Fi, correct `--lan-ip`, backend listening on all interfaces, firewall allows TCP 3000. |
| Login does nothing | Use the in-app Settings connection test and check `adb logcat -s Capacitor/Console Capacitor/Plugin`. |
| Camera scan fails | Grant camera permission in Android settings. The app cannot scan without it. |
| HTTPS link opens a browser | App Links need a deployed `assetlinks.json` with the signing fingerprint. Use the in-app scanner or `easygateway://`. |
| "Check before retrying" | The request timed out. Verify the record on the server before repeating a mutation. |

Useful Android commands:

```powershell
adb devices
adb install -r dist/EasyGateway-production-debug.apk
adb logcat -s Capacitor/Console Capacitor/Plugin
adb shell am start -n com.easygateway.app/.MainActivity
```

## Repository layout

```text
.
├── index.html                  # Website UI (desktop and mobile browser)
├── app-features.js             # Shared Sell/Stocking/loyalty/waste/order tools
├── lib/
│   └── retail-core.js          # Shared retail rules (website + Android)
├── server.js                   # Express API, schema, jobs and email outbox
├── package.json
├── render.yaml
├── .env.example
├── scripts/
│   ├── maintenance.js          # One-shot expiry and purchase cycle
│   └── e2e-api.js              # Disposable-shop API test
├── test/
│   ├── retail-core.test.js
│   ├── ui-contract.test.js
│   └── validation.test.js
├── android-app/
│   ├── package.json
│   ├── capacitor.config.ts
│   ├── config/environments.mjs
│   ├── www/                    # Bundled website adapted for the WebView
│   ├── android/                # Capacitor Android project
│   ├── scripts/
│   │   ├── build-android.mjs
│   │   └── verify-web.mjs
│   ├── tests/
│   └── docs/
│       └── LOCAL-NETWORK.md
└── .github/
    └── workflows/
        └── validate.yml
```

## Limitations and production gaps

- **The Android release is not production-signed.** Only debug APKs are installable out of the box; release signing must be configured by the owner.
- **No Play Store packaging or store listing** is included, and device-specific QA is not complete for every Android vendor.
- **Email delivery is provider-dependent and not verified in this repository.** SMTP/Resend credentials, sender verification, bounce handling and provider webhooks are external setup.
- No iOS application.
- No supplier API, external purchase-order submission, payment gateway, live POS, ERP, accounting or tax integration.
- No lot/batch-level expiry, FEFO picking or product-recall workflow. Expiry remains product-level.
- Loyalty vouchers are shop counter records only; there is no payment/refund integration, voucher expiry or accounting reconciliation.
- No UHF RFID. Barcode/QR scanning is the supported scan input; camera support depends on the device and bundled plugin.
- No CSV import wizard, OCR invoice capture or in-browser camera scanner on the website.
- No password reset, email verification, MFA, account recovery or staff invitation workflow.
- No versioned migration tool, automated backup policy, external penetration test or load test.
- Forecasting is a simple rule-based baseline, not a trained model.
- HTTPS App Links need an optional backend `assetlinks.json` deployment.
- The app is a Capacitor WebView shell, not a separately written native UI. The original web project remains the source of truth for business logic.

Do not treat this MVP as production-ready for financial, tax, food-safety or other regulated workflows until the remaining controls and integrations are implemented and tested.
