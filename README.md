# Easy Gateway

Easy Gateway is a web-based shop-management app for small, independent retailers such as grocery, stationery, household-goods, electronics and clothing stores. It keeps inventory, sales, expiry dates, purchase planning, customer orders and loyalty records in one place instead of relying on notebooks or spreadsheets.

This is a working MVP, not a finished commercial platform. It is suitable for learning, demos and controlled testing. Read the limitations before using it for real business or regulated data.

## Which branch is this?

The `main` branch contains the **website and backend only**:

- Browser UI served by Express (`index.html`).
- Express 5 API (`server.js`).
- PostgreSQL database.
- GitHub Actions validation.

The Android application lives only on the `feature/easy-gateway-android` branch. There is no `android-app/` directory on `main`, and the Android code has not been merged into this branch.

## The problem it solves

Small shops often struggle with the same four problems:

| Problem | How Easy Gateway helps |
|---|---|
| **Stockouts** | Tracks stock and reorder levels, shows low-stock products, and suggests purchase quantities from sales history and supplier lead time. |
| **Expired products** | Stores expiry dates, moves expired products to a recycle bin, and keeps a record of the estimated cost written off. |
| **Manual records** | Saves products, sales, customers, suppliers and purchase orders in PostgreSQL instead of paper or scattered spreadsheets. |
| **Lost customers** | Gives each shop a public catalogue link where customers can send order requests, and records customer purchase history and loyalty coins. |

## Features verified on this branch

### Accounts and shop isolation

- Retailer registration creates a shop workspace and an owner account.
- Sign-in and sign-out use server-side sessions stored in PostgreSQL.
- Passwords are stored as bcrypt hashes, never plaintext.
- API reads and writes are scoped to the signed-in shop.
- A new shop starts with an empty catalogue; demo data is not mixed into a live account.

### Inventory and low-stock alerts

- Add products with SKU, category, unit, stock, reorder level, unit cost, selling price, supplier lead time and an optional expiry date.
- Search inventory and export the current list to CSV.
- Record stock adjustments with a reason so changes are auditable.
- The dashboard lists products at or below their reorder level.
- Stock is stored in PostgreSQL, not only in the browser.

### Sales and loyalty coins

- Record a sale against active stock. The sale and stock decrement run in one database transaction.
- Add a customer name to create or update a customer record.
- Award loyalty coins per product line using the shop's threshold. The default is **1 coin per ₹100 spent on a line**, rounded down.
- View customer balances, order count, lifetime spend and recent sales.
- This branch awards coins but does **not** include a voucher catalogue or coin-redemption flow.

### Suppliers and purchase planning

- Keep a supplier directory with contact details, categories and lead times.
- Calculate suggested replenishment from current stock, reorder buffer, 30-day sales history, supplier lead time and outstanding purchase-order quantities.
- Fall back to the reorder level when a product has no sales history.
- Create internal purchase-order drafts and record receipts to update inventory.
- An optional server-side rule can prepare an approved internal order when automatic purchasing is enabled and the estimated total is within the configured limit.
- Orders above the limit create a notification for review.

**Supplier limitation:** Easy Gateway does not connect to a supplier network, send external purchase orders, collect payments, or email/WhatsApp suppliers. The automation creates an internal record only.

### Expiry management and recycle bin

- Save an expiry date on each product.
- Expiry sweeps run when the API is active and on a timer while the web service is awake.
- When the date has passed in the shop's configured timezone, the product is deactivated, its remaining stock is saved in a recycle-bin snapshot, and an in-app notification is created.
- Expired products are hidden from active inventory and cannot be sold.
- Restoring a product requires a corrected expiry date that is valid and not in the past.

Expiry is attached to a product record, not to separate supplier batches. Shops that receive the same SKU in multiple batches need batch-level inventory before relying on this for food-safety or regulated workflows.

### Expiry-waste reporting

- A date-filtered report reads historical recycle-bin snapshots and groups losses by expiry month.
- It lists the highest-cost expired products and can export the breakdown to CSV.
- Estimated loss is the saved quantity at expiry multiplied by the saved unit cost.
- Restored records are excluded.
- Values are estimates of inventory cost written off, not missed revenue or guaranteed lost profit.

### Sample-product QR import

- The Product QR screen generates a fictional product with a random demo SKU, quantity, prices, category, lead time and optional expiry date.
- Scanning the QR with a phone camera imports the sample into the signed-in shop. If the phone is not signed in, Easy Gateway asks the retailer to sign in and then completes the import.
- Imported samples are tagged **QR SAMPLE** and can be removed after the demonstration.
- SKU collisions are handled without overwriting existing products.
- QR tokens expire after 15 minutes or one successful import. The database stores token hashes.
- Demo Mode QR codes import into the local demo sandbox, never into the live database.
- The website itself does not open the camera; it displays the QR for another device to scan.

### Customer storefront and order requests

- Each shop has a public catalogue at `/shop/<shop-slug>`.
- Customers can search the catalogue, add products to a basket, and send an order request with name, phone number and optional notes.
- Retailers review requests in **Customer order requests** and mark each one **accepted** or **declined**.
- This is an order-request flow only. No payment is collected and stock is not reserved.
- The public catalogue does not expose unit cost or exact stock quantities.
- This branch does not provide customer-facing order tracking after the request is sent.

### Daily sales reporting

- Show recorded sales by calendar day.
- Compare a day's revenue with the prior two to three non-zero days and flag large deviations.
- This is a transparent rule-based baseline, not trained AI forecasting.

### Demo Mode

- Demo Mode is a browser-local sandbox. It does not read or write live PostgreSQL inventory, sales, customers or loyalty records.
- Open `http://localhost:3000/?mode=demo` for the retailer demo, or add `?mode=demo` to a shop page for the customer demo.
- Demo changes disappear when the demo data is reset.

### Notifications

- Expiry, stock-adjustment, purchase-order and automation-limit notifications are saved to PostgreSQL.
- The website shows unread notifications and can poll for new ones while open.
- Email, SMS and native push are **not** configured on this branch.

## Technologies used

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS and plain JavaScript in `index.html`; no bundler or build step |
| Backend | Node.js 24 and Express 5 |
| Database | PostgreSQL 18 |
| Authentication | `bcryptjs`, `express-session`, `connect-pg-simple` |
| Security | `helmet`, `express-rate-limit`, same-origin mutation checks, parameterized SQL |
| QR codes | `qrcode` |
| Hosting | Render Blueprint (`render.yaml`) with a free web service and free PostgreSQL |
| CI | GitHub Actions (`.github/workflows/validate.yml`) |

## Prerequisites

- **Git** to clone the repository.
- **Node.js 24.x** and the npm version bundled with it. The `package.json` engine field requires Node 24.
- **PostgreSQL 18** running locally or reachable over the network. A compatible recent PostgreSQL version will usually work, but 18 is what the project is configured for.
- A database role that can create tables in the target database.
- **PowerShell 5.1 or newer** on Windows for the commands below. macOS and Linux work with equivalent shell commands.
- No Docker setup is included in this repository.

Check the tools:

```powershell
git --version
node --version
npm --version
```

## Easy local setup on Windows

### 1. Get the project

```powershell
git clone https://github.com/Shrishant1cog/TripleThreat01.git
cd TripleThreat01
```

If you already have the project, open its folder instead of cloning a second copy.

### 2. Install dependencies

```powershell
npm install
```

### 3. Create the database

Use the PostgreSQL command-line tool. If `psql` is not on `PATH`, call it by its full path:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "CREATE DATABASE easy_gateway;"
```

If the database already exists, do not drop it. Continue with the existing database. The application adds missing tables and columns on startup; it does not reset or erase existing records.

### 4. Create your environment file

```powershell
Copy-Item .env.example .env
notepad .env
```

Set at least `DATABASE_URL` and a long random `SESSION_SECRET`. Example values:

```dotenv
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/easy_gateway
SESSION_SECRET=replace-with-a-long-random-secret
DATABASE_SSL=false
PUBLIC_APP_URL=
```

Never commit `.env` or a real secret. The repository ignores `.env`.

### 5. Start the server

```powershell
npm start
```

For automatic restart while editing:

```powershell
npm run dev
```

### 6. Check that it works

In a second PowerShell window:

```powershell
curl.exe http://127.0.0.1:3000/healthz
```

Expected response:

```json
{"ok":true,"service":"easy-gateway","database":"connected","time":"..."}
```

Open [http://localhost:3000](http://localhost:3000) and create a shop account. The database schema is created automatically during startup under a PostgreSQL advisory lock.

## Environment configuration

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | **Yes** | PostgreSQL connection string. Startup fails without it. |
| `SESSION_SECRET` | **Yes** in production | Signs session cookies. A development fallback is used only when `NODE_ENV=development` and `RENDER` is unset. |
| `NODE_ENV` | Recommended | Use `development` locally and `production` on a hosted deployment. |
| `PORT` | No | HTTP port. Default `3000`. |
| `DATABASE_SSL` | No | Set `true` when the database requires TLS. |
| `PG_POOL_MAX` | No | Maximum PostgreSQL pool connections. Default `8`. Lower it for small free-tier databases. |
| `PUBLIC_APP_URL` | No | Base URL used to build QR scan links. For phone testing use a phone-reachable origin such as `http://192.168.1.20:3000` or the HTTPS deployment. Loopback addresses are rejected by the QR endpoints. |

`RENDER` is set automatically by Render and is not something you normally configure. If your database password contains special characters, URL-encode it in `DATABASE_URL`.

## How to use Easy Gateway

1. **Register a shop.** Enter your name, shop name, email and a password of at least 10 characters. This creates the owner account and empty workspace.
2. **Add products.** Open **Inventory → Add product** and enter SKU, category, unit, stock, reorder level, unit cost, selling price, lead time and expiry date where relevant.
3. **Record a sale.** Open **Sales → Record sale**, choose products and quantities, and optionally add a customer name. Stock is reduced in the same transaction.
4. **Watch low stock.** The dashboard shows products at or below their reorder level, and the purchase planner suggests quantities.
5. **Create a purchase draft.** Review the suggested plan, create an internal purchase order, then use **Receive** when stock arrives.
6. **Manage expiry.** Check **Expiry & recycle bin** for expired products. Correct the date before restoring an item.
7. **Review waste.** Open **Expiry waste report**, choose a date range, review estimated loss, and export CSV if needed.
8. **Share the storefront.** Open the customer storefront link for your shop (`/shop/<slug>`) and send it to customers. Review incoming requests under **Customer order requests**.
9. **Try a QR sample.** Open **Product QR generator**, generate a sample and scan it with a signed-in phone. Remove the tagged sample afterwards.
10. **Explore Demo Mode.** Add `?mode=demo` to the website URL to test screens without touching live data.

## Testing and validation

```powershell
npm run check
npm test
node scripts/maintenance.js
```

- `npm run check` checks the syntax of `server.js`.
- `npm test` runs the Node test suite in `test/` and does not need a database.
- `node scripts/maintenance.js` runs one expiry sweep and one automatic-purchase cycle, then exits. The running server already schedules both while it is awake.

The GitHub Actions workflow also extracts the inline browser JavaScript, checks its syntax, verifies required feature markers and runs the unit tests.

This branch has no live end-to-end API test script. Test against a disposable local database and never point a test at production data.

## Production and security

Before exposing Easy Gateway to real users:

- Set `NODE_ENV=production`.
- Set a long, random `SESSION_SECRET`; never use the development fallback.
- Use a dedicated PostgreSQL role with only the permissions the app needs.
- Set `DATABASE_SSL=true` when your provider requires TLS.
- Serve the app over HTTPS through a reverse proxy or platform load balancer.
- Keep `.env`, database dumps, logs and backups out of Git.
- Review the Render plan and database expiry terms before storing business data.
- Restrict who can reach the admin/retailer interface.
- Test a restore from backup before relying on the database.

Built-in controls include Helmet security headers, request body limits, authentication rate limiting, same-origin checks for mutating requests, parameterized SQL and shop-scoped queries. These reduce common risks but are not a substitute for a security review, backups, monitoring or a penetration test.

The schema is created by the application at startup with additive statements. There is no versioned migration tool and no automated backup policy in this repository.

## Deploy on Render

`render.yaml` defines:

- `easy-gateway`: a Node web service on the Free plan.
- `easy-gateway-db`: a Free PostgreSQL 18 database.

To deploy:

1. Open [Render Blueprints](https://dashboard.render.com/blueprint/new) or use the [one-click flow](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2FShrishant1cog%2FTripleThreat01).
2. Connect `Shrishant1cog/TripleThreat01` and select the `main` branch.
3. Confirm the web service and database are created with the Free plan.
4. Apply the Blueprint and wait for the first deployment.
5. Open the service URL, register a shop and add products.
6. Check that `/healthz` reports `database:"connected"`.

### Free-tier warning

Render's free PostgreSQL database expires after 30 days. The free web service can also sleep after a period without traffic, so the first request after sleep may be slow and in-process timers pause while it sleeps. A free web service plus a free database is suitable for trying the MVP, not for business-critical data. Export or migrate the database before it expires, and do not keep the only copy of real records there.

## Troubleshooting

| Symptom | Check |
|---|---|
| `DATABASE_URL is missing` | `.env` must exist in the project root and contain `DATABASE_URL`. Restart after editing it. |
| `ECONNREFUSED` on startup | PostgreSQL is not running, or the host/port in `DATABASE_URL` is wrong. |
| `password authentication failed` | Check the username, password and database name. URL-encode special characters in the password. |
| `database "easy_gateway" does not exist` | Create it with `psql`, or correct the database name in `DATABASE_URL`. |
| SSL/TLS connection error | Set `DATABASE_SSL=true` if the provider requires TLS; otherwise leave it `false` for local PostgreSQL. |
| `EADDRINUSE` / port already in use | Another process is using port 3000. Stop it or set a different `PORT`. Check with `Get-NetTCPConnection -LocalPort 3000`. |
| QR generation returns HTTP 412 | `PUBLIC_APP_URL` is a loopback address. Use the PC's private LAN address or the public HTTPS URL. |
| Sign-in succeeds but API calls return 401 | Cookies are blocked or the request comes from a different origin. Use the app at the same host and port that served it. |
| `permission denied for schema public` | The database role cannot create tables. Grant the required permissions or use the owner role. |
| npm warns about the Node version | Install Node 24.x; `package.json` requires it. |
| Tables are missing after an upgrade | Restart the server and check the startup log. The app only applies additive schema changes; inspect errors manually. |

## API overview

All shop endpoints require a signed-in session unless marked public.

| Method and path | Purpose |
|---|---|
| `GET /healthz` | Public health and database check |
| `POST /api/auth/register` | Public retailer registration |
| `POST /api/auth/login` | Public sign-in |
| `POST /api/auth/logout` | Sign out |
| `GET /api/auth/me` | Current session |
| `GET /api/bootstrap` | Load shop data and dashboard |
| `GET/POST /api/products` | List and create products |
| `PUT /api/products/:id` | Update an active product |
| `POST /api/products/:id/stock-adjustments` | Audited stock adjustment |
| `GET/POST /api/sales` | List and record sales |
| `GET /api/customers` | Customer balances and history |
| `GET/POST /api/suppliers` | Supplier directory |
| `GET /api/purchase-plan` | Suggested replenishment |
| `GET/POST /api/purchase-orders` | List and create purchase drafts |
| `POST /api/purchase-orders/:id/receive` | Receive stock against a draft |
| `GET /api/recycle-bin` | Expired-product snapshots |
| `POST /api/recycle-bin/:id/restore` | Restore after correcting the date |
| `GET /api/reports/expiry-waste?from=YYYY-MM-DD&to=YYYY-MM-DD` | Expiry-loss report |
| `POST /api/qr-tokens` | Create a one-time product QR |
| `GET /scan/:token` | Public one-time scan page |
| `POST /api/demo-product-qr` | Generate a sample-product QR |
| `POST /api/product-import/consume` | Import a scanned sample |
| `GET /shop/:slug` | Public customer storefront |
| `GET /api/customer/catalog/:slug` | Public catalogue data |
| `POST /api/customer/orders` | Public order request |
| `GET /api/customer-orders` | Shop order-request queue |
| `PUT /api/customer-orders/:id/status` | Accept or decline a request |
| `GET /api/notifications` | In-app notifications |
| `PUT /api/settings` | Coin rule, timezone and purchasing policy |

Mutating requests require JSON and same-origin requests. The bundled frontend already sends the expected calls.

## Repository layout

```text
.
├── index.html                  # Website UI and browser code
├── server.js                   # Express API, schema and background jobs
├── package.json
├── render.yaml
├── .env.example
├── scripts/
│   └── maintenance.js          # One-shot expiry and purchase cycle
├── test/
│   └── validation.test.js
└── .github/
    └── workflows/
        └── validate.yml
```

## Limitations and production gaps

- **Android app is not on this branch.** It exists only on `feature/easy-gateway-android`.
- No Sell/Stocking cart, stock-receipt workflow or serialized-unit tracking on this branch.
- No loyalty voucher redemption, voucher ledger or coin-expiry rules.
- No email, SMS or native push provider; notifications are in-app only.
- No customer order tracking, fulfilment, ready-for-pickup or cancellation flow; requests can only be accepted or declined.
- No supplier API, payment gateway, live POS, ERP, accounting or tax integration.
- No batch/lot-level expiry, FEFO picking or product-recall workflow.
- No CSV import wizard, in-browser camera scanning, OCR invoice capture or hardware scanner integration.
- No password reset, email verification, MFA, account recovery or staff invitations.
- No versioned migration tool, automated backup policy, external penetration test or load test.
- Forecasting is a simple rule-based baseline, not a trained model.
- The app has not been hardened for financial, tax, medical or food-safety compliance.

Do not treat this MVP as production-ready for regulated or business-critical workflows until the missing controls and integrations are implemented and tested.
