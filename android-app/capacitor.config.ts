import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Easy Gateway Android shell.
 *
 * The web UI is bundled from `www/` so the app works offline for its shell.
 * Live business data is always read from and written to the existing Easy Gateway
 * backend through the native `EasyGatewayNative` HTTP bridge. The bridge is used
 * instead of WebView `fetch` because the production API is a different origin from
 * the Capacitor WebView (`https://localhost`) and the backend session cookie is
 * `SameSite=Lax`. A native cookie jar keeps the server-side session intact without
 * disabling CORS, cookies, authentication or TLS checks.
 */
const config: CapacitorConfig = {
  appId: 'com.easygateway.app',
  appName: 'Easy Gateway',
  webDir: 'www',
  server: {
    androidScheme: 'https'
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#f7f8f5'
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      backgroundColor: '#203d2b',
      showSpinner: false,
      androidScaleType: 'CENTER_CROP'
    },
    // The UI uses the native env(safe-area-inset-*) variables, so Capacitor does
    // not need to inject the optional --safe-area-inset-* CSS variables. Native
    // handling avoids a startup race where those variables are injected before
    // the document exists.
    SystemBars: {
      insetsHandling: 'native',
      initialViewportFitValueHint: 'cover'
    }
  }
};

export default config;
