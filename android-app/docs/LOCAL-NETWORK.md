# Easy Gateway on a private local network

This guide runs the existing Easy Gateway website and Express backend on a Windows PC,
connects a physical Android device over private Wi-Fi, and switches the Android build back
to production HTTPS when testing is finished.

It documents the setup verified on **2026-10-28**. The test used disposable local data, not
production customer records.

---

## Architecture

```text
Android app (Capacitor WebView)
  |  HTTP + native bridge + server session cookie
  v
Windows PC: Express API on 0.0.0.0:3000  --->  PostgreSQL 18.6 (easy_gateway)
  ^
  |  browser at http://10.43.232.32:3000
```

- The website and Android app talk only to the Express API.
- Only the backend talks to PostgreSQL. The app never receives database credentials and
  never opens a database connection.
- The backend must be reachable from the phone over the private LAN. It is not deployed or
  exposed to the internet for this setup.

---

## Verified environment

| Item | Value |
| --- | --- |
| PC | Windows, Node.js `v24.20.0`, PostgreSQL `18.6` |
| Local database | `easy_gateway`, local `postgres` role |
| PC Wi-Fi | SSID `Oppo`, address `10.43.232.32/24`, gateway `10.43.232.60` |
| Android device | Lenovo `TB310FU`, Android 13 (API 33), serial `HA2183XS` |
| Device Wi-Fi | `10.43.232.31/24` on the same `Oppo` network |
| App package | `com.easygateway.app`, version `1.0.0` |
| LAN build | debug, API `http://10.43.232.32:3000`, cleartext allowed (debug only) |
| APK | `dist/EasyGateway-lan-debug.apk`, 35,632,507 bytes |
| APK SHA-256 | `713F7C868F74C343F0D64330E65A48B2F4793843A3C904D3DEA86F36F94D93C6` |

The LAN address and the test account are disposable. Do not treat the test account,
password, or local database as production data. Do not commit `.env`.

---

## 1. Prepare the local PostgreSQL database (non-destructive)

These steps assume PostgreSQL 18 is already installed and the Windows service
`postgresql-x64-18` is running.

### Create an empty database if one does not exist

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "CREATE DATABASE easy_gateway;"
```

If the database already exists, **do not drop it**. Continue with the existing database.

### Configure `.env`

```dotenv
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://postgres:YOUR_LOCAL_PASSWORD@localhost:5432/easy_gateway
SESSION_SECRET=replace-with-a-long-random-local-secret
DATABASE_SSL=false
PUBLIC_APP_URL=http://10.43.232.32:3000
```

Use a strong local database password and a random session secret. Keep `.env` out of Git.

### Start the backend

```powershell
npm install
npm start
```

On startup the application runs the schema in `SCHEMA_SQL` under a PostgreSQL advisory
lock. The statements are additive (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD
COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`); startup does not drop or reset the
database. It does not migrate an old schema to a new shape beyond those additive changes.

Check the service and database:

```powershell
curl.exe http://127.0.0.1:3000/healthz
```

Expected:

```json
{"ok":true,"service":"easy-gateway","database":"connected","time":"..."}
```

### Existing database or real data

- Back up the database before importing anything:

  ```powershell
  & "C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" -U postgres -Fc -f .\easy_gateway-backup.dump easy_gateway
  ```

- If you need to test a cloud export without touching the current local data, restore it
  into a separate database and point `DATABASE_URL` at that database for the test.
- Do not import real customer data into this PC without the shop owner's permission.

---

## 2. Bring data down from the hosted deployment (only if needed)

The cloud data was **not** present on this PC and was **not** migrated during this setup.
No Render credentials were available, and the local database contains only disposable test
data. A local database is not automatically a copy of the cloud database.

### Full database copy

1. In the Render dashboard, open the PostgreSQL instance and copy the **External Database
   URL**. The internal URL only works inside Render.
2. From the Windows PC, dump the hosted database:

   ```powershell
   & "C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" `
     --no-owner --no-privileges --format=custom `
     --file .\easy-gateway-cloud.dump `
     "postgres://USER:PASSWORD@HOST:5432/DATABASE"
   ```

3. Restore into a separate local database first:

   ```powershell
   & "C:\Program Files\PostgreSQL\18\bin\createdb.exe" -U postgres easy_gateway_import
   & "C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" `
     --no-owner --no-privileges `
     --dbname easy_gateway_import .\easy-gateway-cloud.dump
   ```

4. Start the backend once with `DATABASE_URL` pointing at `easy_gateway_import` and verify
   the shop, products, sales, customers, orders, and settings before switching the real
   `easy_gateway` database over.

If the External Database URL is unavailable, run `pg_dump` from a Render shell and download
the dump over a secure channel.

### CSV is not a full backup

The website's **Export CSV** covers inventory rows only. It does not include sales,
customers, loyalty balances, suppliers, purchase orders, customer orders, shop settings, or
the recycle bin. Do not use inventory CSV as a disaster-recovery backup.

### Data handling

- The local PostgreSQL instance is not encrypted at rest by this project. Use disk
  encryption or a protected Windows account if the data is sensitive.
- Delete or archive local dumps after the test.
- Keep the database on the private PC. Do not expose PostgreSQL port 5432 to the network.

---

## 3. Put the backend on the private LAN

### Confirm a private address

```powershell
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' } |
  Select-Object InterfaceAlias, IPAddress, PrefixLength
```

Use an address in `10.0.0.0/8`, `172.16.0.0/12`, or `192.168.0.0/16`. Do not use
`localhost`, `127.0.0.1`, a public address, or the Android emulator address `10.0.2.2` in a
physical-device build.

### Set the QR origin

`PUBLIC_APP_URL` must be the address the **phone** can open:

```dotenv
PUBLIC_APP_URL=http://10.43.232.32:3000
```

Restart the server after changing it. A QR generated while `PUBLIC_APP_URL` is a loopback
address is rejected with HTTP `412`:

```json
{"error":"QR links cannot point at localhost because a phone cannot open them. Set PUBLIC_APP_URL to this PC's LAN address, for example http://192.168.1.20:3000, then restart the server."}
```

This guard is intentional. Without it, the website would print a QR that the phone could
never open.

### Start and test

```powershell
npm start
```

The server logs `Easy Gateway listening on port 3000`. From the phone browser, open:

```text
http://10.43.232.32:3000/healthz
```

A successful JSON response proves TCP reachability. ICMP ping may fail because Windows
Firewall blocks it even when TCP works; use the HTTP check instead.

### Firewall

This PC already had Windows Firewall inbound **allow** rules named
`Node.js JavaScript Runtime` for `C:\Program Files\nodejs\node.exe`, TCP and UDP, any port,
on the **Public** profile. Those existing rules are why the phone could reach TCP 3000.
No new firewall rule and no router port forwarding were added for this test.

That existing rule is broader than necessary. With administrator rights, the safer setup is:

1. Classify the trusted home/hotspot Wi-Fi as **Private**.
2. Add an inbound rule limited to `node.exe`, TCP, local port `3000`, Private profile.
3. Disable the broad `Node.js JavaScript Runtime` any-port rules.
4. Never enable router port forwarding or UPnP for this development server.

Until that is done, keep the PC on a trusted Wi-Fi network and do not run the dev server on
public Wi-Fi.

### If the phone cannot connect

- Confirm both devices are on the same subnet and the hotspot has client isolation off.
- Confirm the PC address is still `10.43.232.32`; DHCP may change it.
- Confirm the server listens on `0.0.0.0:3000` and `PUBLIC_APP_URL` uses the same address.
- Check Windows Firewall and any third-party security software.
- Disable VPNs or virtual adapters that could change routing.
- On Android, a saved network with internet may steal the connection back from a hotspot
  without internet. If the app suddenly times out, reopen Wi-Fi settings and reconnect to
  the shared hotspot. This happened during the test: the tablet rejoined
  `VVIT-ACA-BDORM55` until it was manually reconnected to `Oppo`. Auto-connect was then
  turned off for the saved `VVIT-ACA-BDORM55` and `VVIT-ACA-BDORM56` networks
  (**Wi-Fi -> Saved networks -> network -> Auto-connect**) so the tablet stayed on the
  test hotspot. Re-enable those switches if the device should join the campus networks
  automatically again.

---

## 4. Build and install the LAN debug APK

```powershell
cd C:\Users\hosam\Desktop\Shri\TT1\EasyGatewayAndroid
npm install
npm test
npm run android:build:lan
adb install -r dist\EasyGateway-lan-debug.apk
```

`android:build:lan` runs `node scripts/build-android.mjs --env lan --lan-ip auto`. The
script auto-detects the Wi-Fi IPv4 and prints it, for example:

```text
Auto-detected LAN address: 10.43.232.32 (Wi-Fi)
  API base:   http://10.43.232.32:3000
  Environment:Physical phone on the same LAN
  Cleartext:  allowed (debug only)
```

You can also pass an explicit address:

```powershell
node scripts/build-android.mjs --env lan --lan-ip 10.43.232.32 --port 3000
```

The build rejects `localhost`, public addresses, credentials in the URL, and paths or query
strings in the API base URL. Debug cleartext is limited to the configured private host.
Production builds remain HTTPS-only.

Open the app's **Settings** page and confirm:

- API base URL: `http://10.43.232.32:3000`
- Environment: `Physical phone on the same LAN`
- Cleartext: allowed (debug only)
- Version: `1.0.0`

The LAN APK uses the same application id as the production debug APK. Installing it
replaces the other debug build but keeps app data. Uninstalling clears app data and the
native session cookie jar; sign in again afterward.

---

## 5. Verification performed

| Check | Result |
| --- | --- |
| PC `/healthz` | `200`, `database: connected` |
| Phone Chrome `/healthz` | `200`, `database: connected` over `10.43.232.32:3000` |
| Live sample QR generation | `scanUrl` used `http://10.43.232.32:3000/import-product/...` |
| Product QR generation | `scanUrl` used `http://10.43.232.32:3000/scan/...` |
| Loopback QR guard | HTTP `412` with the configuration message |
| Product QR scan page on the phone | Opened in Chrome; showed product, SKU, stock, price; no unit cost |
| Live sample QR import in the app | Imported `Toor Dal 1 kg` (`DEMO-217925`), tagged `QR SAMPLE` |
| Website inventory after import | Same product present via `/api/bootstrap` and the inventory page |
| Audited stock adjustment from the app | `Local Sync Test Product` `12 -> 11`, reason recorded |
| Website after adjustment | Same product shows stock `11`; active products `3`; stock value `₹3,270` |
| Demo Mode isolation | Backend and Android test suites pass; no live writes from Demo Mode |
| Backend tests | `19/19` |
| Android tests | `35/35` |
| APK build | `BUILD SUCCESSFUL`, APK present and installed on `HA2183XS` |

Evidence files are in [`docs/evidence/`](evidence/):

| File | Shows |
| --- | --- |
| `device-chrome-health.png` | Phone Chrome opening the LAN `/healthz` endpoint |
| `device-scan-page.png` | Phone opening a one-time product QR scan page over the LAN |
| `device-app-inventory-sync.png` | Android inventory after the import and stock adjustment |
| `website-inventory-sync.png` | Website inventory with the same stock value and product count |
| `product-qr-lan.json` | Server response showing the LAN `scanUrl` for a product QR |
| `sample-import-qr-lan.json` | Sample QR response showing the LAN import URL |

### Physical camera scan caveat

The native scanner activity opened and the camera permission was granted. The tablet's
rear camera was aimed at a dark surface/ceiling during the test and could not be aimed at
the PC screen remotely, so a literal optical QR decode was not captured on the physical
device.

The same server-issued payload was delivered through the app's real
`easygateway://import-product/<token>` deep-link path. That path uses the same token
validation, pending-token storage, import-route selection, and consume call as a camera
result. The imported product then appeared on both clients.

To complete the optical check manually:

1. Keep the website QR page open on the PC.
2. On the tablet, open **Inventory -> Scan QR**.
3. Point the tablet at the QR on the PC screen.
4. Confirm the toast and the `QR SAMPLE` row in both the app and the website.

---

## 6. Switch back to production HTTPS

### Backend

Set the public origin back to the hosted HTTPS URL, or remove the variable to fall back to
the incoming request host:

```dotenv
PUBLIC_APP_URL=https://easy-gateway.onrender.com
```

Restart the server. Keep the local database configuration separate; do not point a
production deployment at the local PC database.

### Android

Production debug build:

```powershell
npm run android:build
adb install -r dist\EasyGateway-production-debug.apk
```

Release build (unsigned until a signing config is added):

```powershell
node scripts/build-android.mjs --env production --release
```

The production build:

- uses `https://easy-gateway.onrender.com`;
- blocks cleartext HTTP in the release network security config;
- rejects HTTP API base URLs at build time;
- does not contain the LAN IP.

Sign in again after switching. The LAN session cookie is for the HTTP development origin
and is not reused for the HTTPS production origin.

### Do not ship the LAN APK

`dist/EasyGateway-lan-debug.apk` is a debug build that embeds a private IP and permits
cleartext HTTP to that host. Keep it for local testing only. If the PC's LAN address
changes, regenerate `PUBLIC_APP_URL` and rebuild the LAN APK.

---

## 7. Security notes

- HTTP on the LAN is unencrypted. Anyone who can observe the hotspot traffic could capture
  credentials or session cookies. Use only a trusted, WPA2-protected hotspot and avoid
  public Wi-Fi.
- For real shop data on a local network, put the backend behind HTTPS (for example a
  reverse proxy with a trusted certificate) instead of plain HTTP.
- The Android app never connects to PostgreSQL directly and never exposes the session
  cookie to JavaScript.
- Keep `.env`, database dumps, and test credentials out of Git and out of shared folders.
- The local server binds `0.0.0.0` so the phone can reach it. It is reachable by devices on
  the same LAN; do not port-forward it or place it on a public network.
- The existing Windows firewall rule allows all ports for `node.exe` on the Public profile.
  Narrow it as described above when administrator access is available.
