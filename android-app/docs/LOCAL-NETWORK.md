# Easy Gateway on a private local network

This guide runs the Easy Gateway website and Express backend on a Windows PC, connects a physical Android device over private Wi-Fi, and switches the Android build back to production HTTPS when testing is finished.

Use disposable test data. Do not copy production customer records onto an unmanaged PC, and never commit `.env` or database dumps.

## Architecture

```text
Android app (Capacitor WebView)
  │  HTTP + native bridge + server session cookie
  ▼
Windows PC: Express API on 0.0.0.0:3000  ──────►  PostgreSQL (easy_gateway)
  ▲
  │  browser at http://192.168.1.20:3000
Phone browser
```

- The website and Android app talk only to the Express API.
- Only the backend talks to PostgreSQL. The app never receives database credentials.
- The backend must be reachable from the phone over the private LAN. It is not exposed to the internet for this setup.

## 1. Prepare PostgreSQL (non-destructive)

These steps assume PostgreSQL 18 is installed and its Windows service is running. Adjust the install path if yours differs.

### Create the database if it does not exist

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "CREATE DATABASE easy_gateway;"
```

If the database already exists, **do not drop it**. Continue with the existing database.

### Configure `.env`

From the project root:

```dotenv
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://postgres:YOUR_LOCAL_PASSWORD@localhost:5432/easy_gateway
SESSION_SECRET=replace-with-a-long-random-local-secret
DATABASE_SSL=false
PUBLIC_APP_URL=http://192.168.1.20:3000
```

Replace `192.168.1.20` with the PC's private IPv4 address. Keep `.env` out of Git.

On startup the application applies additive schema statements (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`) under a PostgreSQL advisory lock. It does not drop or reset the database, and it does not migrate an old schema to a new shape beyond those additive changes.

### Start the backend

```powershell
npm install
npm start
```

Check the service and database:

```powershell
curl.exe http://127.0.0.1:3000/healthz
```

Expected:

```json
{"ok":true,"service":"easy-gateway","database":"connected","time":"..."}
```

### Existing database or real data

Back up before importing anything:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" -U postgres -Fc -f .\easy_gateway-backup.dump easy_gateway
```

If you need to test a cloud export without touching current local data, restore it into a separate database and point `DATABASE_URL` at that database for the test. Do not import real customer data without the shop owner's permission.

## 2. Copy hosted data down (only if needed)

The local database is **not** automatically a copy of the hosted database.

### Full database copy

1. In the Render dashboard, open the PostgreSQL instance and copy its **External Database URL**.
2. Take a backup from the hosted database into a local dump file. Keep the URL out of shell history, screenshots and Git:

   ```powershell
   & "C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" `
     --dbname "<external-database-url>" --format=custom --file .\hosted-easy-gateway.dump
   ```

3. Create a separate local database for the restored copy:

   ```powershell
   & "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "CREATE DATABASE easy_gateway_copy;"
   ```

4. Restore into that database:

   ```powershell
   & "C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" `
     --dbname "postgres://postgres:YOUR_LOCAL_PASSWORD@localhost:5432/easy_gateway_copy" `
     --clean --if-exists .\hosted-easy-gateway.dump
   ```

5. Point `DATABASE_URL` at `easy_gateway_copy` for the test. Keep the original local database untouched.

### CSV is not a full backup

Inventory CSV export contains the product list only. It does not include sales, customers, suppliers, loyalty ledgers, purchase orders, recycle-bin snapshots or settings. Use `pg_dump` for a real backup.

### Data handling

- Do not commit dumps, `.env` files or exported customer data.
- Delete temporary dumps when finished.
- Use a disposable test shop where possible.

## 3. Put the backend on the private LAN

### Confirm a private address

Run:

```powershell
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' } |
  Select-Object InterfaceAlias, IPAddress
```

Use the Wi-Fi adapter's address. Ignore virtual adapters, VPNs and loopback addresses.

### Set the QR origin

Put the chosen address in `.env`:

```dotenv
PUBLIC_APP_URL=http://192.168.1.20:3000
```

Replace the example with your address. Do not use `localhost` or `127.0.0.1`: the phone cannot open those, and the QR endpoints return HTTP 412 rather than issuing a broken QR.

### Start and test

```powershell
npm start
curl.exe http://127.0.0.1:3000/healthz
```

From the phone browser:

```text
http://192.168.1.20:3000/healthz
```

Expected: the same `database:"connected"` response.

### Firewall

- Windows may already have an inbound rule for `Node.js JavaScript Runtime`.
- If not, allow TCP 3000 on the **private** network profile only.
- Do not expose the port to public Wi-Fi or the internet.
- No router port forwarding is required.

Check existing rules:

```powershell
Get-NetFirewallRule -DisplayName "*Node*" | Select-Object DisplayName, Enabled, Direction, Profile
```

### If the phone cannot connect

- Confirm the phone and PC are on the same subnet.
- Confirm the backend is listening on `0.0.0.0`, not only `127.0.0.1`.
- Check the Windows network profile is **Private**.
- Check the firewall rule allows TCP 3000.
- Use the phone browser first; if `/healthz` fails there, the Android build cannot work yet.

## 4. Build and install the LAN debug APK

From `android-app`:

```powershell
npm install
npm run android:build:lan
```

`npm run android:build:lan` reads `PUBLIC_APP_URL` from the backend `.env`, so
the APK trusts exactly the origin the website prints. To let the build detect a
private Wi-Fi address instead:

```powershell
node scripts/build-android.mjs --env lan --lan-ip auto
```

To pin a different address explicitly:

```powershell
node scripts/build-android.mjs --env lan --lan-ip 192.168.1.20 --port 3000
```

If `PUBLIC_APP_URL` names an address that is no longer assigned to this PC, the
build stops with an error. Update `.env`, restart the backend and rebuild.

Output:

```text
dist/EasyGateway-lan-debug.apk
```

Install:

```powershell
adb devices
adb install -r dist/EasyGateway-lan-debug.apk
```

If `adb devices` shows `unauthorized`, unlock the phone and accept the USB debugging prompt.

### Emulator alternative

If no physical phone is available:

```powershell
npm run android:build:emulator
adb install -r dist/EasyGateway-emulator-debug.apk
```

The emulator reaches the host at `http://10.0.2.2:3000`.

## 5. Verify the LAN app

1. Open the app and confirm the Settings screen shows the expected API URL and environment.
2. Sign in with a disposable shop account.
3. Check that inventory matches the website for the same account.
4. Generate a sample QR on the website and scan it in the app. The imported row should appear in both the app and the website.
5. Make an audited stock adjustment in the app and confirm the website shows the same stock.
6. Open `/healthz` in the phone browser to confirm the network path independent of the app.

The app uses the same backend session and database, so live records should be visible from both clients. Demo Mode changes must remain local and must not create server records.

A physical camera scan requires pointing the phone at the QR on the PC screen. If the camera cannot be aimed during testing, the same QR payload can be opened through the app's `easygateway://` deep link; this exercises the same token validation and import route.

## 6. Switch back to production HTTPS

### Backend

For a hosted deployment, set:

```dotenv
NODE_ENV=production
DATABASE_URL=<hosted-postgres-url>
SESSION_SECRET=<long-random-production-secret>
DATABASE_SSL=true
PUBLIC_APP_URL=https://<your-public-host>
```

Do not leave `PUBLIC_APP_URL` pointing at a private LAN address in production.

### Android

```powershell
cd android-app
npm run android:build
```

This embeds `https://easy-gateway.onrender.com`, labels the build `Production`, and blocks cleartext HTTP.

For a different HTTPS origin:

```powershell
node scripts/build-android.mjs --env production --api-base-url https://staging.example.com
```

Release builds must use `--env production`. The build script rejects release + HTTP.

### Do not ship the LAN APK

`EasyGateway-lan-debug.apk` contains a private HTTP address and allows cleartext for that host. It is a development artifact only. Delete it or keep it out of release uploads.

## 7. Security notes

- Keep the backend off public Wi-Fi.
- Use a firewall rule limited to the private network and TCP 3000.
- Do not reuse a production database password locally.
- Do not commit `.env`, dumps, keystores or signing passwords.
- Do not disable TLS verification to make a local build work.
- Production builds must use HTTPS.
- A debug APK is not a production release and must not be represented as one.
