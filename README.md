# Easy Gateway

**Easy Gateway** is a full-stack retail-management MVP for independent retailers across grocery, clothing, electronics, household goods, stationery, and general retail.

The repository contains a browser-based web app, an Express API, PostgreSQL-backed business records, server-side authentication, and an Android shell in `android-app/` that uses the same API. The default Render Blueprint uses free resources for prototype/testing. It is a functional MVP, not a production-hardened commercial retail platform.

## Current stack

- **Frontend:** responsive HTML, CSS, and JavaScript.
- **Backend:** Node.js 24 and Express 5.
- **Database:** PostgreSQL 18.
- **Authentication:** bcrypt password hashing and PostgreSQL-backed server sessions with HTTP-only cookies.
- **Security baseline:** Helmet security headers, request size limits, authentication rate limiting, same-origin mutation checks, parameterized SQL, and shop-scoped data access.
- **Hosting:** Render Free web service + Free PostgreSQL for testing; the database expires after 30 days.

## Implemented features

### Accounts and shop isolation
- Retailer registration creates a shop workspace and owner account.
- Sign-in and sign-out with server-side sessions.
- Passwords are stored as bcrypt hashes, not plaintext.
- API reads and writes are scoped to the authenticated shop.
- A new shop begins with an empty product catalogue; it does not mix fake demo data into a real account.

### Inventory
- Add products with SKU, category, unit, stock, reorder level, unit cost, selling price, supplier lead time, and optional expiry date.
- Search inventory and export its current contents to CSV.
- Record auditable stock adjustments with a reason.
- Product records and stock live in PostgreSQL, not only in browser storage.
- Use **Sell** for cart checkout and **Stocking** for supplier deliveries. Both are available in the website and the Android app.
- **Stocking** records a receipt with supplier reference, unit cost, optional expiry, and an idempotency key so a retried submit does not add stock twice.
- Products can track individual serial numbers. Serialized products start at zero stock; every unit is received with its own serial and sold by scanning that serial. Duplicate serials are rejected both inside one receipt and across the shop.

### Serialized units and duplicate detection
- Barcode/SKU lookup returns either a product that does not track serials or a specific in-stock serialized unit.
- A serialized sale requires exactly one in-stock serial per unit and rejects duplicates in the same cart.
- Already-sold, returned-to-stock, and unknown serials are rejected with a clear message; stock only changes when the serial is valid.
- The shared rules live in `lib/retail-core.js` and are loaded by both web clients, so the website and Android app apply the same normalisation and validation.

### Sales and customer loyalty
- Record a sale against active stock from the Sell tool.
- A sale checks and decrements stock inside a database transaction.
- Add the customer name to create or update a customer record.
- Award loyalty coins per product line according to the shop's configured threshold. Default: **1 coin per ₹100 spent on a line**, rounded down.
- Sale, stock decrement, serial state, customer balance, and loyalty-ledger write are transactionally coupled.
- View customer balances, order count, lifetime spend, and recent sales.
- Redeem coins for a fixed shop voucher from the server-side catalogue: `SAVE50` (100 coins / ₹50), `SAVE150` (250 / ₹150), `SAVE350` (500 / ₹350). Redemption is idempotent and guarded against spending the same coins twice.
- Loyalty is not awarded for pending, declined, failed, or Demo Mode transactions. Vouchers are counter-redemption records only; Easy Gateway does not process payments or refunds.

### Purchase planning
- Calculate replenishment quantities from stock, reorder buffer, 30-day sales history, supplier lead time, and outstanding purchase-order quantities.
- Use a conservative reorder-level baseline when a product has no sales history.
- Create purchase-order drafts in the database and record receipts to update inventory.
- An optional server-side rule can prepare an internal approved order when the configured purchasing policy is enabled and the estimated total is within the spending limit.
- Orders above the limit create a notification requiring review.

**Supplier limitation:** Easy Gateway does not yet connect to a supplier network, submit external purchase orders, charge payments, or email/WhatsApp suppliers. The automated process creates an internal order record only. External ordering requires the specific supplier's API or authorized integration.

### Expiry management and recycle bin
- Save an expiry date on each product.
- Server-side expiry sweeps run on API activity and periodically while the web service is awake.
- When the date is earlier than the shop's configured local date, the product is deactivated, its remaining stock is preserved in a recycle-bin snapshot, and an in-app notification is written to PostgreSQL.
- Expired products are not returned by active inventory APIs and cannot be sold.
- Restoring a product requires a corrected expiry date that is valid and not in the past.
- The free Blueprint does not create a paid cron job. Expiry checks also run when API requests arrive, but background timers pause when the free web service sleeps. The automatic purchase cycle is scheduled in-process and runs about every 15 minutes while the service is awake, so on the free plan it can be delayed until the next request wakes the service.

**Current data model limitation:** expiry is attached to a product record, not separate supplier lots/batches. Retailers receiving the same SKU in multiple batches need batch-level inventory before relying on this for food or regulated-product safety processes.

### Expiry waste and loss reporting
- A date-filtered report reads historical recycle-bin snapshots, groups losses by expiry month, and lists the highest-cost expired products.
- The selected from/to range applies to every section: summary, monthly trend, product table, CSV, and recorded waste.
- Estimated loss is the saved quantity at expiry multiplied by the saved unit cost. Recorded waste appears only when the shop entered what was actually disposed of, with its own quantity and cost.
- Records restored after an expiry-date correction, reversed, or deleted from the recycle bin are excluded.
- Values are estimates of inventory cost written off, not missed revenue or guaranteed lost profit. A product with zero remaining stock contributes zero cost loss.
- The report uses real recorded data and does not fabricate samples; Demo Mode has its own sample snapshots.

### Random sample-product QR import
- Generate a fictional product with random demo SKU, quantity, prices, category, lead time, and optional expiry date.
- Scan the QR from a phone camera to import the sample into the currently signed-in retailer's inventory. If the phone isn't signed in, Easy Gateway asks the retailer to sign in and completes the import afterward.
- Imported items are marked **QR SAMPLE** and can be removed after the demonstration. SKU collisions are handled without overwriting existing products.
- Codes expire after 15 minutes or one successful import. Tokens are cryptographically random; the database stores token hashes. Live QR tokens cannot be used as demo-only tokens, or vice versa.
- QR links are built from `PUBLIC_APP_URL`. If it points at `localhost`, `127.0.0.1` or another loopback address, the QR routes return HTTP 412 with a configuration message instead of generating a QR the phone cannot open.
- Demo Mode uses local browser session data; scanning a demo-only QR adds the product to the demo sandbox, not the live database.

### Customer-facing shop
- Each shop gets a public catalogue URL at `/shop/<shop-slug>`.
- Customers can search the catalogue, add products to a basket, and send an order request with name, phone number, email address, delivery or pickup address, and optional notes.
- Orders start as **requested** / **Awaiting shop confirmation**. The website and app describe an order as confirmed only after the shop accepts it.
- Retailers review incoming requests in **Customer order requests**, then accept, decline, mark ready, fulfil, or cancel them. Invalid status jumps are rejected by the server.
- Customers can track an order with the order reference **and** the phone number used on the request. The phone number alone is not sufficient.
- This is an order-request flow only: no payment is collected and stock is not reserved. The customer-facing catalogue does not expose unit cost or exact stock quantities.
- Optional confirmation/status emails are queued transactionally in an email outbox. Without `SMTP_URL` or `RESEND_API_KEY`, the UI reports `not_sent`/`queued` instead of pretending an email was delivered.

### Daily sales reporting
- Show actual recorded sales by calendar day.
- Calculate a basic sales-variance baseline by comparing a day's revenue with the prior two to three non-zero days.
- Display large deviations for retailer review.

**This is not trained AI forecasting.** It is a transparent baseline, and it needs enough actual transaction history to be useful. Advanced demand forecasts should be added after real store data is available and tested.

### Demo Mode
- Demo Mode is a browser-local sandbox. It never reads or writes live PostgreSQL inventory, sales, customers, or loyalty ledgers.
- The demo seed includes near-expiry, normal, expired/recycle-bin, historical waste-report, customer-order, and loyalty examples so the new screens can be evaluated without changing real data.
- Open `http://<host>:3000/?mode=demo` for the retailer demo, or open a shop page with `?mode=demo` for the customer demo.
- Demo stock receipts, sales, loyalty redemptions, orders, and waste records are labelled as sample data and disappear when the demo data is reset.

### Notifications and email
- Save expiry, stock-adjustment, purchase-order, and automation-limit notifications to PostgreSQL.
- Display unread notifications in the website and Android app.
- Order confirmation and status emails use a transactional outbox with retry, deduplication, and HTML escaping.
- Delivery requires `SMTP_URL` (nodemailer) or `RESEND_API_KEY` (HTTP fallback). Without a provider, email remains queued/not_sent; the app does not claim a message was delivered.
- SMS and native push are not configured.

## Run locally

Requirements: Node.js 24 and a PostgreSQL database.

1. Clone this repository.
2. Install dependencies:

   \`\`\`bash
   npm install
   \`\`\`

3. Create a local PostgreSQL database and set environment variables. For example, create a \`.env\` file:

   \`\`\`dotenv
   NODE_ENV=development
   PORT=3000
   DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/easy_gateway
   SESSION_SECRET=replace-this-with-a-long-random-secret
   \`\`\`

   Use your own local database password. Never commit a real \`.env\` file or secret.

4. Start the application:

   \`\`\`bash
   npm start
   \`\`\`

5. Open [http://localhost:3000](http://localhost:3000). Register a shop account to create the workspace tables and start adding inventory.

Useful development commands:

```bash
npm run dev
npm run check
npm test
npm run test:e2e
node scripts/maintenance.js
```

`npm run dev` restarts the server on file changes. `npm test` runs the unit and static contract suites without a database. `npm run test:e2e` needs a running server plus the same `DATABASE_URL`; it creates a disposable shop, exercises register, Sell/Stocking, serials, loyalty, customer order/email outbox, expiry waste/report, and demo isolation, then deletes the shop. Set `E2E_BASE` if the server is not on `http://127.0.0.1:3000`; set `E2E_KEEP=1` only when you intentionally want to inspect the test shop. `node scripts/maintenance.js` runs one expiry sweep plus one auto-purchase cycle and exits; the running web process already schedules both itself.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| \`DATABASE_URL\` | Yes | PostgreSQL connection string. Startup fails fast without it. |
| \`SESSION_SECRET\` | Yes outside local development | Signs session cookies. A development fallback is used only when \`NODE_ENV=development\` and \`RENDER\` is unset. |
| \`NODE_ENV\` | Recommended | \`production\` on hosted deployments; controls the development secret fallback. |
| \`PORT\` | No | HTTP port, default \`3000\`. |
| \`DATABASE_SSL\` | No | \`true\` when the database requires TLS. |
| \`PG_POOL_MAX\` | No | Maximum pool connections, default \`8\`. Lower it for small free-tier databases. |
| `PUBLIC_APP_URL` | No | Base URL used to build QR scan links. Defaults to the incoming request host. For phone testing it must be a phone-reachable origin such as `http://192.168.1.20:3000` or the HTTPS deployment; loopback values are rejected with HTTP 412. |
| `SMTP_URL` | No | SMTP connection string for order emails, for example `smtps://user:pass@smtp.example.com:465`. Tried before the Resend fallback. |
| `EMAIL_FROM` | No | From header for order emails. Defaults to a generic Easy Gateway sender when the provider accepts it. Use a verified sender. |
| `RESEND_API_KEY` | No | Enables the Resend HTTP fallback when `SMTP_URL` is unset. |

The database schema is initialized by the application on startup. For a production deployment, move schema changes to versioned migrations before making frequent schema changes.

### Local network (PC + phone)

To use the website and Android app on the same private Wi-Fi without public hosting:

1. Keep PostgreSQL on the PC and run the API on all interfaces:

   ```dotenv
   NODE_ENV=development
   PORT=3000
   DATABASE_URL=postgres://postgres:YOUR_LOCAL_PASSWORD@localhost:5432/easy_gateway
   SESSION_SECRET=replace-with-a-long-random-secret
   DATABASE_SSL=false
   PUBLIC_APP_URL=http://192.168.1.20:3000
   ```

2. Find the PC's private IPv4 address (`10.x`, `172.16-31.x`, or `192.168.x`) and put it in
   `PUBLIC_APP_URL`. Do not use `localhost` or `127.0.0.1`: the phone cannot open those
   addresses, so the QR endpoints return HTTP 412 instead of generating a broken QR.

3. Start the server and check it from the phone browser:

   ```powershell
   npm start
   curl.exe http://127.0.0.1:3000/healthz
   # from the phone: http://<pc-lan-ip>:3000/healthz
   ```

4. The phone and PC must be on the same subnet. Windows may already have an inbound
   `Node.js JavaScript Runtime` firewall rule; no router port forwarding is needed. Keep
   the server off public Wi-Fi, and prefer a private-network rule limited to TCP 3000.

5. Build the Android app against the LAN address. The source lives in `android-app/`; see its
   `docs/LOCAL-NETWORK.md` for the full build, QR, firewall, database-export and
   production-HTTPS switch procedure. Run `npm run android:build:lan` to auto-detect the
   PC's Wi-Fi address and produce a debug APK for a phone on the same network.

The local database is not automatically a copy of the hosted database. To copy cloud data,
use `pg_dump` with the Render **External Database URL** and restore into a separate local
database first; inventory CSV export is not a full backup. Do not drop or reset an existing
local database to make the export fit. No cloud database credentials are required to run
the app locally with fresh test data.

## Deploy on Render

A \`render.yaml\` Blueprint describes two free resources:

- \`easy-gateway\`: Node web service.
- \`easy-gateway-db\`: Free PostgreSQL 18 database, with private networking.

To deploy:

1. [Open the one-click Render deployment flow](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2FShrishant1cog%2FTripleThreat01) or open [Render Blueprints](https://dashboard.render.com/blueprint/new).
2. Connect \`Shrishant1cog/TripleThreat01\`.
3. Confirm the web service and the existing \`easy-gateway-db\` database are selected, with the Free plan for both. The Blueprint connects \`DATABASE_URL\` to the database automatically.
4. Apply the Blueprint and wait for the first deployment.
5. Open the web service URL, register a shop account, and add your products.
6. Verify the \`/healthz\` endpoint reports that the database is connected.

### Hosting cost warning

This Blueprint uses the **Free** web service and **Free** PostgreSQL. The free database expires 30 days after creation; after expiry, it becomes inaccessible and Render deletes it after the documented 14-day grace period unless upgraded. This database was created on **October 28, 2026** and is scheduled to expire on **November 27, 2026**. Free web services can sleep after 15 minutes without inbound traffic, so the first request after sleep may be slow. The web process itself runs the expiry sweep and the automatic purchase cycle; `scripts/maintenance.js` is an optional one-shot equivalent for external cron setups, not a replacement for the in-process timers.

A free web tier plus a free database is suitable for trying the MVP, not for business-critical production data. Export or migrate the database before November 27, 2026, and do not rely on this temporary database as the only copy of real inventory or sales records.

## API overview

All shop endpoints require a signed-in session unless noted.

| Endpoint | Purpose |
|---|---|
| \`GET /healthz\` | Check service and database connectivity |
| \`POST /api/auth/register\` | Register a retailer and create a shop |
| \`POST /api/auth/login\` | Sign in |
| \`POST /api/auth/logout\` | Sign out |
| \`GET /api/auth/me\` | Current session |
| \`GET /api/bootstrap\` | Load shop data and dashboard |
| `GET/POST /api/products` | List and create inventory records |
| `GET /api/products/lookup?code=...` | Resolve a barcode, SKU, or serialized unit |
| `PUT /api/products/:id` | Update active product details |
| `POST /api/products/:id/stock-adjustments` | Adjust stock with an audit notification |
| `POST /api/stock/receipts` | Stocking: receive units with cost, expiry, reference, and optional serials |
| `GET/POST /api/sales` | Record sales (optionally serialized) and award loyalty coins |
| `GET /api/loyalty/rewards` | Read the server-side voucher catalogue |
| `POST /api/loyalty/redeem` | Redeem coins for a fixed voucher (idempotent) |
| \`GET/POST /api/suppliers\` | Supplier directory |
| \`GET /api/purchase-plan\` | Calculate suggested purchases |
| \`GET/POST /api/purchase-orders\` | Read/create purchase orders |
| \`POST /api/purchase-orders/:id/receive\` | Receive stock against a purchase order |
| `GET /api/recycle-bin` | List active recycle-bin records |
| `POST /api/recycle-bin/:id/waste` | Record actual disposed quantity and cost once |
| GET /api/reports/expiry-waste?from=YYYY-MM-DD&to=YYYY-MM-DD | Shop-scoped expiry-loss report from historical snapshots |
| `GET /api/customer/catalog/:slug` | Public product catalogue without internal costs |
| `POST /api/customer/orders` | Customer order request with contact, address, and items |
| `GET /api/customer/orders/:reference?phone=...` | Customer tracking with reference plus phone |
| `GET /api/customer-orders` | Shop-side order queue with email state |
| `PUT /api/customer-orders/:id/status` | Accept/decline/ready/fulfil/cancel with transition checks |
| POST /api/qr-tokens | Create a short-lived one-time QR token and PNG data URL (API only: no screen in the current UI) |
| GET /api/qr-tokens/:token/status | Check whether a QR token was used or expired (API only) |
| GET /scan/:token | Public one-time scan page with safe product details |
| POST /api/demo-product-qr | Generate a random sample-product QR used by the Product QR screen |
| POST /api/demo-product-qr/consume-preview | Preview a demo-only QR in Demo Mode without touching PostgreSQL |
| \`POST /api/recycle-bin/:id/restore\` | Restore after expiry-date correction |
| \`GET /api/notifications\` | View in-app notifications |
| \`PUT /api/settings\` | Update coin rule, timezone, and automatic-purchase policy |

Mutating requests require JSON and same-origin requests. The frontend already sends the expected same-origin API calls.

## CI checks

GitHub Actions checks:
- JavaScript syntax for the API, shared retail rules, shop tools, and inline browser script.
- Core expiry, waste-report, QR-token, loyalty, serial, order-status, and scheduler feature markers.
- Unit tests for ISO date handling, the PostgreSQL `DATE` parsing behaviour behind the restore check, public DTO field filtering, and shared helpers (`normalizeCode`, `validEmail`, `nextOrderStatus`).
- Frontend contract tests: every `data-action` in the markup has a handler, the removed dead QR branch stays removed, and Demo Mode errors reject as promises so forms cannot hang.
- Android contract checks in `android-app/` for the native bridge, camera scanner, demo isolation, release HTTPS policy, and shared UI markers.

See [the workflow](.github/workflows/validate.yml). The live API end-to-end check is not run in CI because it needs PostgreSQL and a running server; run `npm run test:e2e` locally.

## Repository layout

```text
.
├── index.html
├── server.js
├── app-features.js
├── lib/
│   └── retail-core.js
├── package.json
├── render.yaml
├── scripts/
│   ├── maintenance.js
│   └── e2e-api.js
├── test/
│   ├── retail-core.test.js
│   ├── ui-contract.test.js
│   └── validation.test.js
├── android-app/
│   ├── www/                 # bundled website adapted for the WebView
│   ├── android/             # Capacitor Android project
│   └── docs/
└── .github/
    └── workflows/
        └── validate.yml
```

## Not implemented yet / production gaps

- The Android app is a Capacitor shell around the same web UI and API, not a separately written native app. It is debug-buildable; release signing, Play Store packaging, and device-specific QA are not done.
- No iOS application.
- No supplier-side API, payment gateway, live POS, SAP, accounting, or tax integration.
- No CSV import wizard, OCR invoice capture, or POS integration. Camera barcode scanning is available in the Android app through the Capacitor barcode scanner; the website relies on the device keyboard or a hardware scanner. The sample QR import flow is intended for demonstration; verify product values before treating them as operational stock.
- No lot/batch-level expiry model, FEFO picking, or product recall workflow. Expiry remains product-level; Stocking receipts carry batch metadata but do not split a product into independently expiring lots.
- Loyalty vouchers are recorded shop vouchers only. There is no payment/refund integration, voucher expiry, or accounting reconciliation.
- Email requires an external SMTP or Resend account and a verified sender. Delivery, bounce handling, and provider webhooks are not verified in this repository.
- UHF RFID is not implemented. There is no RFID hardware integration; barcode/QR scanning is the only supported scan input, and camera/NFC support depends on the device and libraries actually bundled.
- No password reset, email verification, MFA, account recovery, or staff invitation workflow.
- No dedicated database migration tool, automated backup policy configured in this repo, external penetration test, or load test.
- Forecasting is currently a simple rule-based baseline, not a trained model.

**Do not treat this MVP as production-ready for financial, tax, food-safety, or other regulated workflows until the remaining controls and integrations are implemented and tested.**
