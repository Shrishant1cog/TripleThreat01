# Optional backend changes

**Nothing in `../TripleTreat` was modified.** The Android app works against the existing
backend without CORS, cookie or API changes. This document lists the two optional
backend-side items that would improve the integration, plus one existing behaviour that
needs no change.

---

## 1. HTTPS App Links (`assetlinks.json`) — optional

### Why

`android/app/src/main/AndroidManifest.xml` declares verified HTTPS App Links for:

```text
https://easy-gateway.onrender.com/shop/...
https://easy-gateway.onrender.com/import-product/...
```

Android only opens these links in the app after the backend serves a matching
`/.well-known/assetlinks.json`. Without it:

- `easygateway://...` links still work;
- the in-app camera scanner still works;
- an HTTPS link tapped in another app may open in a browser instead of Easy Gateway.

This is a UX improvement, not a requirement for the app's features.

### What to deploy

The file must be publicly reachable at:

```text
https://easy-gateway.onrender.com/.well-known/assetlinks.json
```

with HTTP 200, no redirect, and `Content-Type: application/json`.

Replace the fingerprint with the SHA-256 of the **certificate used to sign the installed
APK** (the debug key for a debug build, the release key for a Play/standalone release):

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.easygateway.app",
      "sha256_cert_fingerprints": [
        "AA:BB:CC:...:99"
      ]
    }
  }
]
```

Get the fingerprint from the keystore:

```powershell
keytool -list -v -keystore easy-gateway-release.jks -alias easy-gateway
```

For the locally installed debug APK:

```powershell
keytool -list -v -keystore "$env:USERPROFILE\.android\debug.keystore" `
  -alias androiddebugkey -storepass android -keypass android
```

### Minimal Express route

`server.js` currently serves pages explicitly and does not use `express.static`, so the
file must be exposed. For example, store it at `assets/assetlinks.json` and add:

```js
app.get("/.well-known/assetlinks.json", (_req, res) => {
  res.type("application/json").sendFile(path.join(__dirname, "assets", "assetlinks.json"));
});
```

Place this route before the catch-all/404 handler. `path` is already imported by
`server.js`.

Do not put the file behind authentication, a redirect or a CDN rule that returns HTML.

### Verify on a device

After installing the APK:

```powershell
adb shell pm verify-app-links --re-verify com.easygateway.app
adb shell pm get-app-links com.easygateway.app
```

The host should eventually show `verified`. While testing locally, the debug keystore
fingerprint must be the one in `assetlinks.json`, because Android verifies the signing
certificate of the installed APK.

---

## 2. Idempotency for mutations — optional future work

The current API has no idempotency keys for sales, orders or other mutating requests.
The Android app is therefore deliberately conservative:

- no automatic retries for POST/PUT/DELETE;
- busy guards prevent double taps;
- timeouts tell the operator to verify the record before retrying.

No backend change is required for correctness, but if automatic retry is ever desired,
the backend should accept an `Idempotency-Key` header on mutation endpoints and return
the original result for a repeated key. Do not add client-side retries before that exists.

---

## 3. QR mode marker and 410 messages — no change required

The backend already adds `?mode=demo` to every demo-only import URL and returns one
combined 410 message per consume route (`"… expired, is a demo-only code, or has already
been scanned …"`). The app therefore:

- stores the `mode=demo` marker with the pending token instead of inferring the token type
  from the error text;
- refuses a live QR while Demo Mode is on, and switches to Demo Mode for a demo QR, before
  calling any consume endpoint;
- shows the same-mode message ("This QR has expired or was already scanned…") only when
  the QR marker matches the active mode.

Observed against production without changes:

- `POST /api/demo-product-qr` returns `scanUrl` with `mode=demo`; a non-demo request
  returns it without the marker;
- `POST /api/demo-product-qr/consume-preview` and `POST /api/product-import/consume`
  return the combined 410 text for expired, consumed, unknown or cross-mode tokens;
- after the app blocked a live QR in Demo Mode, `GET /api/demo-product-qr/<token>/status`
  still reported `{consumed:false, expired:false}`, proving the token was never consumed.

A cleaner API could split the 410 into distinct codes, but that is unnecessary for
correctness and was not requested, so no backend edit was made.

---

- **CORS:** not required. Requests are made by the native HTTP bridge, not by WebView
  `fetch`, so browser CORS does not apply.
- **Cookie policy change:** not required. The native cookie jar stores the existing
  `HttpOnly`, `SameSite=Lax` session cookie and sends it explicitly.
- **TLS relaxation:** not required and must not be added. The app verifies HTTPS normally.
- **Authentication bypass:** not added. Login, sessions and shop scoping are unchanged.
