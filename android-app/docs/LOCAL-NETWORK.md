# Private-LAN development

Use this procedure to run the backend on a development PC and connect an Android
device on the same private network. Use a disposable local database; do not download
production customer or inventory data for this test.

## 1. Configure the backend

Create a local `.env` file in the repository root from `.env.example`. Set a local
database URL, a strong local session secret, and the PC's current private IPv4 address:

```dotenv
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/easy_gateway
SESSION_SECRET=replace-with-a-long-random-secret
DATABASE_SSL=false
PUBLIC_APP_URL=http://192.168.1.20:3000
```

Replace the example address with the address assigned to the development PC. Keep the
`.env` file and all database credentials local; never add them to Git. Use a separate,
empty database rather than importing a production database.

Start PostgreSQL and the backend from the repository root:

```powershell
npm ci
npm start
```

Confirm that the backend listens on an interface reachable from the phone and that the
PC firewall permits the development port on the private network profile. From the phone,
open `http://<PC_LAN_IP>:3000/healthz`. Do not expose this development server to a public
network.

## 2. Build the Android LAN app

From `android-app/`, build with the same private address:

```powershell
node scripts/build-android.mjs --env lan --lan-ip 192.168.1.20 --port 3000
```

Substitute the current PC address in both backend `PUBLIC_APP_URL` and the Android build
command. The build script supports `--lan-ip auto` to select a private LAN address. Install
the generated debug APK from `dist/` on a device connected to the same network.

LAN builds permit HTTP only for debug builds and only to a validated private address.
Production builds must use the HTTPS production API. Do not distribute a LAN debug APK.

## 3. Return to production settings

Restore the backend's production HTTPS `PUBLIC_APP_URL` and build Android for production:

```powershell
npm run android:build:prod
```

Release builds must use HTTPS. The build rejects localhost as a production endpoint.

## Troubleshooting

- Confirm the PC and device are on the same private network.
- Check that the selected private IP has not changed and is reachable from the device.
- Check the local firewall and confirm the backend is listening on the required port.
- Confirm `PUBLIC_APP_URL` and `--lan-ip` use the same address.
- Use `10.0.2.2` for an Android emulator connecting to a backend on its host PC; do not
  use `localhost` from the emulator or a phone.
