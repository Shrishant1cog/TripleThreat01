# Easy Gateway Android

Capacitor Android application for the Easy Gateway retail manager. The app bundles the
web UI from `www/` and connects to the existing backend; it does not include a separate
server or database.

## Requirements

- Node.js 24
- JDK 21
- Android SDK with the Android 36 platform and build tools
- `ANDROID_HOME` or `ANDROID_SDK_ROOT` pointing to the SDK
- `EASY_GATEWAY_JAVA_HOME` or `JAVA_HOME` pointing to JDK 21

The build script creates `android/local.properties` when needed. This is machine-specific,
ignored by Git, and must not be committed.

## Install and verify

From `android-app/`:

```powershell
npm ci
npm test
npm run verify:web
```

The tests cover QR parsing and safe host validation, Demo Mode isolation, inventory
filters, CSV escaping, API environment rules, UI action wiring, and native bridge
invariants. `verify:web` checks the bundled web app and Android security configuration.

Build a production-endpoint debug APK:

```powershell
npm run android:build
```

The build verifies the web bundle, runs `cap sync`, then invokes Gradle. The resulting
APK is written under `dist/`, which is generated and ignored.

## API environments

Build scripts select the API endpoint explicitly:

```powershell
npm run android:build:prod
npm run android:build:emulator
npm run android:build:lan
```

For a physical-device LAN build, use a private IPv4 address reachable from the phone:

```powershell
node scripts/build-android.mjs --env lan --lan-ip 192.168.1.20 --port 3000
```

`--lan-ip auto` prefers a Wi-Fi address and can be used when the PC has one. The LAN and
emulator configurations allow cleartext HTTP only in debug builds. Production builds
require HTTPS and reject localhost, URL credentials, and non-origin paths. See
[`docs/LOCAL-NETWORK.md`](docs/LOCAL-NETWORK.md) for backend and network setup.

The backend's `PUBLIC_APP_URL` must be a URL the phone can reach when generating QR
links. Put local values in the backend's ignored `.env` file; never commit credentials or
copy production data into a local test database.

## App behavior

- The native HTTP bridge communicates with the existing backend and keeps the session
  cookie in the native cookie jar rather than exposing it to web JavaScript.
- The app uses the shared web business rules for inventory actions, sales tools, QR
  workflows, and Demo Mode.
- Native capabilities include barcode scanning, deep links, QR image saving, CSV sharing,
  safe-area handling, and Android back navigation.
- Live and Demo Mode QR imports are kept separate; cleartext is not enabled for release
  builds.

The app id is `com.easygateway.app`. The web UI and retail rules in `www/` are bundled
sources and are checked by `npm test` and `npm run verify:web`.

## Release signing and links

`npm run android:build:release` builds an unsigned production release APK. To distribute
an APK, configure a signing key locally in the Android build setup and keep the keystore
and passwords outside this repository. Do not commit signing material.

The `easygateway://` scheme is available for app links. Verified HTTPS App Links also
require the backend to serve `/.well-known/assetlinks.json` with the release certificate
fingerprint. The optional backend change is described in
[`docs/BACKEND-CHANGES.md`](docs/BACKEND-CHANGES.md).

## Limitations

- A release APK is unsigned until signing is configured.
- HTTPS App Links are not verified until the asset links document is deployed.
- Physical-device camera scans and production-account mutations need separate device and
  account verification; they are not covered by the automated source checks.
- Mutations are not automatically retried after ambiguous failures; verify the server
  state before manually retrying.
