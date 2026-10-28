# Easy Gateway

**Easy Gateway** is a full-stack retail-management MVP for independent retailers across grocery, clothing, electronics, household goods, stationery, and general retail.

The repository contains a browser-based web app, an Express API, PostgreSQL-backed business records, and server-side authentication. The default Render Blueprint uses free resources for prototype/testing. It is a functional MVP, not a production-hardened commercial retail platform.

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

### Sales and customer loyalty
- Record a sale against active stock.
- A sale checks and decrements stock inside a database transaction.
- Add the customer name to create or update a customer record.
- Award loyalty coins per product line according to the shop's configured threshold. Default: **1 coin per ₹100 spent on a line**, rounded down.
- Sale, stock decrement, customer balance, and loyalty-ledger write are transactionally coupled.
- View customer balances, order count, lifetime spend, and recent sales.

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
- The free Blueprint does not create a paid cron job. Expiry checks also run when API requests arrive, but background timers pause when the free web service sleeps. Continuous purchase-cycle automation is not enabled in this free configuration.

**Current data model limitation:** expiry is attached to a product record, not separate supplier lots/batches. Retailers receiving the same SKU in multiple batches need batch-level inventory before relying on this for food or regulated-product safety processes.

### Expiry waste and loss reporting
- A date-filtered report reads historical recycle-bin snapshots, groups losses by expiry month, and lists the highest-cost expired products.
- Estimated loss is the saved quantity at expiry multiplied by the saved unit cost; records restored after an expiry-date correction are excluded.
- Values are estimates of inventory cost written off, not missed revenue or guaranteed lost profit. A product with zero remaining stock contributes zero cost loss.
- Export the monthly breakdown to CSV. The report uses existing real records and does not fabricate samples.

### Single-use product QR codes
- Generate a random QR code for any active product in the signed-in shop.
- Each code opens a product-details page and can be consumed once; codes expire after two minutes. The generator detects a scan and automatically issues a fresh QR.
- The QR scan page shows shop, product name, SKU, category, available stock, selling price, and expiry date. It never exposes unit cost or private purchasing settings.
- Tokens are generated with cryptographically secure randomness, stored as SHA-256 hashes, and scoped to the shop. Product lookup is constrained to the owning shop.
- The QR generator is a one-time product-detail lookup flow, not a retail checkout or payment barcode.

### Daily sales reporting
- Show actual recorded sales by calendar day.
- Calculate a basic sales-variance baseline by comparing a day's revenue with the prior two to three non-zero days.
- Display large deviations for retailer review.

**This is not trained AI forecasting.** It is a transparent baseline, and it needs enough actual transaction history to be useful. Advanced demand forecasts should be added after real store data is available and tested.

### Notifications
- Save expiry, stock-adjustment, purchase-order, and automation-limit notifications to PostgreSQL.
- Display unread notifications in the website.
- The web app can poll for new notifications while open.

Email, SMS, and native mobile push are not configured yet.

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

\`\`\`bash
npm run dev
npm run check
npm test
\`\`\`

The database schema is initialized by the application on startup. For a production deployment, move schema changes to versioned migrations before making frequent schema changes.

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

This Blueprint uses the **Free** web service and **Free** PostgreSQL. The free database expires 30 days after creation; after expiry, it becomes inaccessible and Render deletes it after the documented 14-day grace period unless upgraded. This database was created on **October 28, 2026** and is scheduled to expire on **November 27, 2026**. Free web services can sleep after 15 minutes without inbound traffic, so the first request after sleep may be slow. The free setup does not include a scheduled maintenance job.

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
| \`GET/POST /api/products\` | List and create inventory records |
| \`PUT /api/products/:id\` | Update active product details |
| \`POST /api/products/:id/stock-adjustments\` | Adjust stock with an audit notification |
| \`GET/POST /api/sales\` | Record sales and award loyalty coins |
| \`GET/POST /api/suppliers\` | Supplier directory |
| \`GET /api/purchase-plan\` | Calculate suggested purchases |
| \`GET/POST /api/purchase-orders\` | Read/create purchase orders |
| \`POST /api/purchase-orders/:id/receive\` | Receive stock against a purchase order |
| \`GET /api/recycle-bin\` | List active recycle-bin records |
| GET /api/reports/expiry-waste?from=YYYY-MM-DD&to=YYYY-MM-DD | Shop-scoped expiry-loss report from historical snapshots |
| POST /api/qr-tokens | Create a short-lived one-time QR token and PNG data URL |
| GET /api/qr-tokens/:token/status | Check whether a QR token was used or expired |
| GET /scan/:token | Public one-time scan page with safe product details |
| \`POST /api/recycle-bin/:id/restore\` | Restore after expiry-date correction |
| \`GET /api/notifications\` | View in-app notifications |
| \`PUT /api/settings\` | Update coin rule, timezone, and automatic-purchase policy |

Mutating requests require JSON and same-origin requests. The frontend already sends the expected same-origin API calls.

## CI checks

GitHub Actions checks:
- JavaScript syntax for the API and inline browser script.
- Core expiry, waste-report, QR-token, loyalty, and scheduler feature markers.
- Unit tests for ISO date validation.

See [the workflow](.github/workflows/validate.yml).

## Repository layout

\`\`\`text
.
├── index.html
├── server.js
├── package.json
├── render.yaml
├── scripts/
│   └── maintenance.js
├── test/
│   └── validation.test.js
└── .github/
    └── workflows/
        └── validate.yml
\`\`\`

## Not implemented yet / production gaps

- No Android or iOS application yet; mobile apps should use the same API.
- No supplier-side API, payment gateway, live POS, SAP, accounting, or tax integration.
- No CSV import wizard, camera scanning directly inside Easy Gateway, OCR invoice capture, or customer-facing online storefront. Product QR links can be opened by a phone camera and scanned once.
- No lot/batch-level expiry model or product recall workflow.
- Loyalty refunds, coin redemption, expiry, and reversal policies need ledger flows before launch.
- No email/SMS push provider; current notifications are in-app.
- No password reset, email verification, MFA, account recovery, or staff invitation workflow.
- No dedicated database migration tool, automated backup policy configured in this repo, external penetration test, or load test.
- Forecasting is currently a simple rule-based baseline, not a trained model.

**Do not treat this MVP as production-ready for financial, tax, food-safety, or other regulated workflows until the remaining controls and integrations are implemented and tested.**
