/**
 * Environment-specific API configuration.
 *
 * Production must be HTTPS. Cleartext HTTP is only accepted when the caller
 * explicitly enables it for a debug build (emulator or LAN development).
 */

export const PRODUCTION_API_BASE_URL = 'https://easy-gateway.onrender.com';
export const PRODUCTION_HOST = new URL(PRODUCTION_API_BASE_URL).host;

export const ENVIRONMENTS = {
  production: {
    label: 'Production',
    defaultBaseUrl: PRODUCTION_API_BASE_URL,
    allowCleartext: false
  },
  emulator: {
    label: 'Android emulator (host machine)',
    defaultBaseUrl: 'http://10.0.2.2:3000',
    allowCleartext: true
  },
  lan: {
    label: 'Physical phone on the same LAN',
    // MUST be supplied with --lan-ip. 192.168.1.10 is only a placeholder used to
    // make a missing value fail closed in validation, never to contact a server.
    defaultBaseUrl: '',
    allowCleartext: true
  }
};

export function normaliseBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('API base URL must use http (debug only) or https.');
  }
  if (url.username || url.password) {
    throw new Error('API base URL must not contain credentials.');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('API base URL must be an origin only, for example https://easy-gateway.onrender.com.');
  }
  return url.origin;
}

export function isPrivateLanHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'localhost') return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const parts = ipv4.slice(1).map(Number);
  if (parts.some(n => n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 127 && b === 0 && parts[2] === 0 && parts[3] === 1);
}

/**
 * Picks the most likely private IPv4 address for a LAN build.
 * Prefers a Wi-Fi adapter so a virtual/VPN/TAP adapter is not embedded by accident.
 * @param {object} interfaces A node:os networkInterfaces() result, or a test fixture.
 */
export function findPrivateLanIp(interfaces) {
  const candidates = [];
  for (const [name, addresses] of Object.entries(interfaces || {})) {
    if (/vEthernet|virtual|vmware|virtualbox|tap|loopback|bluetooth|docker|wsl/i.test(name)) continue;
    for (const item of addresses || []) {
      if (!item || item.internal) continue;
      if (item.family !== 'IPv4' && item.family !== 4) continue;
      if (/^127\./.test(item.address) || /^169\.254\./.test(item.address)) continue;
      if (!isPrivateLanHost(item.address)) continue;
      candidates.push({
        name,
        address: item.address,
        wireless: /wi-?fi|wlan|wireless/i.test(name)
      });
    }
  }
  candidates.sort((a, b) => Number(b.wireless) - Number(a.wireless));
  return candidates[0] || null;
}

/**
 * Validates the API endpoint for a build.
 * @param {string} value
 * @param {{ allowCleartext?: boolean, environment?: string }} options
 */
export function validateApiBaseUrl(value, options = {}) {
  const baseUrl = normaliseBaseUrl(value);
  if (!baseUrl) throw new Error('An API base URL is required.');
  const url = new URL(baseUrl);
  const allowCleartext = options.allowCleartext === true;
  const environment = options.environment || 'custom';

  if (url.protocol === 'http:') {
    if (!allowCleartext) {
      throw new Error('Cleartext HTTP is not allowed for this build. Use an HTTPS API base URL.');
    }
    if (environment === 'production') {
      throw new Error('Production builds must use HTTPS.');
    }
    if (!isPrivateLanHost(url.hostname)) {
      throw new Error('Debug HTTP is only allowed for an emulator or private LAN development host.');
    }
  }

  if (url.protocol === 'https:' && environment === 'emulator') {
    // HTTPS emulator endpoints are permitted (for example a tunnelled dev server).
    return baseUrl;
  }

  return baseUrl;
}

/**
 * Resolves the endpoint a build should embed.
 * @param {{ environment?: string, apiBaseUrl?: string, lanIp?: string, port?: number|string }} options
 */
export function resolveApiBaseUrl(options = {}) {
  const environment = String(options.environment || 'production').toLowerCase();
  const preset = ENVIRONMENTS[environment];
  if (!preset) throw new Error(`Unknown environment "${environment}". Use production, emulator or lan.`);

  let base = options.apiBaseUrl || preset.defaultBaseUrl;
  if (environment === 'lan' && !options.apiBaseUrl) {
    const lanIp = String(options.lanIp || '').trim();
    if (!lanIp) throw new Error('LAN builds require --lan-ip with the development PC address, for example 192.168.1.20.');
    const port = Number(options.port || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('LAN port is invalid.');
    base = `http://${lanIp}:${port}`;
  }

  return {
    environment,
    label: preset.label,
    allowCleartext: preset.allowCleartext,
    baseUrl: validateApiBaseUrl(base, { allowCleartext: preset.allowCleartext, environment })
  };
}

/** Hosts that a QR payload may legitimately point at. */
export function allowedQrHosts(apiBaseUrl, publicAppUrl = PRODUCTION_API_BASE_URL) {
  const hosts = new Set([PRODUCTION_HOST]);
  for (const value of [apiBaseUrl, publicAppUrl]) {
    if (!value) continue;
    try {
      hosts.add(new URL(value).host);
    } catch {
      // Ignore malformed optional values; validation happens at build time.
    }
  }
  return [...hosts];
}
