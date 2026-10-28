# Easy Gateway

**Easy Gateway** is a retail-management website prototype for independent shops across categories such as grocery, clothing, electronics, household goods, and stationery.

The current repository release is a responsive, single-file HTML/CSS/JavaScript frontend. It is a demo, not yet a production retail system: business records are stored in the browser's `localStorage`, and no backend, account system, shared database, real payment/POS integration, or supplier connection is active.

## Current features

- **Retail dashboard:** sample sales metrics, graphs, low-stock indicators, and example sales-variance records.
- **Inventory:** add and search products, set stock/reorder thresholds and costs/prices, and export inventory as CSV.
- **Sales demo:** record a sale, reduce active stock, update the local sales history, and earn customer loyalty coins on named customer purchases.
- **Loyalty coins:** configurable spending threshold; by default, a named customer earns 1 coin per ₹100 of product-line value, rounded down.
- **Purchase planner:** estimates basic replenishment quantities using current stock and reorder thresholds; it creates drafts only and does not contact suppliers.
- **Expiry monitoring:** enter an expiry date per product; show products due within seven days and prioritize stock rotation.
- **Recycle bin:** when the app detects an expiry date earlier than the retailer's local date, it removes that product from active inventory, stores its record in the recycle bin, and records a notification. Expired product stock is not available for new demo sales.
- **Retailer alerts:** expiry notification history in the UI; optional browser desktop notifications when the retailer grants permission.
- **Restore guard:** a recycled item can only be restored after its expiry date is corrected to a valid date today or later.
- **Supplier/customer/automation/settings views:** planning screens with clear labels for mock or disconnected integrations.

## Expiry workflow

1. Add a product and enter its expiry date.
2. Easy Gateway checks the expiry dates on page load, when the product list is rendered, and approximately once per minute while the page remains open.
3. If an expiry date is in the past, the item is moved out of active inventory and put in the recycle bin. A notification is logged; if desktop notifications are already allowed, the browser also shows an alert.
4. The retailer can review upcoming expiry dates and notification history in **Expiry & recycle bin**.
5. Restoring an item requires entering a valid current or future expiry date. Do not restore goods that are genuinely expired; follow local food/product safety and disposal requirements.

**Prototype limitation:** checks run in an open browser tab or when the site is next opened. Browser-local notifications are not equivalent to server-side email, mobile push, or guaranteed background alerts. For production, expiry checks must run in a backend scheduler against a shared database, with authenticated retailer notifications and an auditable inventory ledger. Products are currently tracked at product level, not with batch/lot-level quantities.

## Run locally

No package installation is required.

### Option A: Open the page

Open `index.html` in a modern browser.

### Option B: Run a local HTTP server

Python is required for this option:

```bash
python -m http.server 8000
```

Then visit [http://localhost:8000](http://localhost:8000).

## Deploy to Render

A `render.yaml` Blueprint is included for a Render Static Site.

1. Push the repository to GitHub.
2. Open [Render Blueprints](https://dashboard.render.com/blueprint/new) and connect `Shrishant1cog/TripleThreat01`.
3. Review the proposed service and click **Apply**.
4. Render runs the configured build command, publishes the generated `public/` directory, and deploys from `main` on new commits.

The site is static, so the current release does not need a server process, secret keys, database, or paid compute instance. This deployment hosts only the frontend prototype; it does not add the missing production backend.

## Development checks

A GitHub Actions workflow checks the inline JavaScript syntax and confirms important expiry/loyalty controls remain present on pushes to `main` and pull requests.

## Known limitations before using this for a real shop

- No login, roles, tenant isolation, or server-side persistence. Data exists only in the current browser profile and does not synchronize between devices.
- Dashboard graphs, sales anomaly rows, opening revenue/order counts, customers, and supplier examples are illustrative demo data.
- Forecasting is not trained AI. The purchase planner uses a basic reorder rule.
- No live supplier ordering, payment gateway, POS, barcode camera, OCR, SAP integration, or customer-facing online storefront.
- Loyalty coin earning is a local demo calculation. Redemption, returns/refunds, and tamper-resistant points ledgers require a backend.
- Expiry alerts do not run when all browsers are closed; production needs server-side scheduled processing and actual delivery channels.
- No production security, accounting/tax compliance, disaster-recovery, or audit guarantees should be inferred from this prototype.

## Planned architecture

The intended production architecture is a web frontend backed by a TypeScript API, PostgreSQL inventory/sales ledger, durable background jobs, and a separate Python forecasting service. Optional POS, supplier, payment, and SAP integrations should be added only when the retailer's systems and APIs are known. Android/iOS clients can be added later against the same API.

## Repository layout

```text
.
├── index.html                    # Current website prototype
├── render.yaml                   # Render static-site Blueprint
├── README.md                     # Project status and instructions
└── .github/
    └── workflows/
        └── validate.yml          # Lightweight source checks
```
