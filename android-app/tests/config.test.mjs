import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRODUCTION_API_BASE_URL,
  allowedQrHosts,
  findPrivateLanIp,
  isCurrentMachineAddress,
  isLoopbackHost,
  lanBaseUrlFromPublicAppUrl,
  normaliseBaseUrl,
  resolveApiBaseUrl,
  validateApiBaseUrl
} from '../config/environments.mjs';

test('production always resolves to the HTTPS production origin', () => {
  const resolved = resolveApiBaseUrl({ environment: 'production' });
  assert.equal(resolved.baseUrl, PRODUCTION_API_BASE_URL);
  assert.equal(resolved.allowCleartext, false);
  assert.equal(resolved.environment, 'production');
});

test('production rejects cleartext HTTP, including localhost', () => {
  assert.throws(() => resolveApiBaseUrl({ environment: 'production', apiBaseUrl: 'http://localhost:3000' }), /HTTPS|Cleartext/i);
  assert.throws(() => resolveApiBaseUrl({ environment: 'production', apiBaseUrl: 'http://easy-gateway.onrender.com' }), /HTTPS|Cleartext/i);
  assert.throws(() => validateApiBaseUrl('http://10.0.2.2:3000', { allowCleartext: true, environment: 'production' }), /Production builds must use HTTPS/i);
});

test('emulator build uses 10.0.2.2 and permits debug cleartext', () => {
  const resolved = resolveApiBaseUrl({ environment: 'emulator' });
  assert.equal(resolved.baseUrl, 'http://10.0.2.2:3000');
  assert.equal(resolved.allowCleartext, true);
});

test('LAN build requires an explicit private address', () => {
  assert.throws(() => resolveApiBaseUrl({ environment: 'lan' }), /PUBLIC_APP_URL|--lan-ip/i);
  const resolved = resolveApiBaseUrl({ environment: 'lan', lanIp: '192.168.1.20', port: 3000 });
  assert.equal(resolved.baseUrl, 'http://192.168.1.20:3000');
  assert.throws(() => resolveApiBaseUrl({ environment: 'lan', lanIp: '8.8.8.8' }), /private LAN/i);
  assert.throws(() => resolveApiBaseUrl({ environment: 'lan', lanIp: '192.168.1.20', port: 70000 }), /port/i);
});

test('a LAN build reuses PUBLIC_APP_URL so the APK and QR origin cannot drift', () => {
  const fromEnv = lanBaseUrlFromPublicAppUrl('http://10.27.244.13:3000/');
  assert.equal(fromEnv, 'http://10.27.244.13:3000');
  const resolved = resolveApiBaseUrl({ environment: 'lan', apiBaseUrl: fromEnv });
  assert.equal(resolved.baseUrl, 'http://10.27.244.13:3000');
  assert.equal(resolved.allowCleartext, true);
  assert.ok(allowedQrHosts(resolved.baseUrl, fromEnv).includes('10.27.244.13:3000'));
  assert.equal(lanBaseUrlFromPublicAppUrl('https://dev-tunnel.example.test'), 'https://dev-tunnel.example.test');
});

test('PUBLIC_APP_URL cannot point a LAN APK at localhost or a public HTTP host', () => {
  for (const host of ['localhost', '127.0.0.1', '0.0.0.0', 'shop.localhost']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  assert.equal(isLoopbackHost('10.27.244.13'), false);
  assert.throws(() => lanBaseUrlFromPublicAppUrl('http://localhost:3000'), /localhost|phone cannot reach/i);
  assert.throws(() => lanBaseUrlFromPublicAppUrl('http://127.0.0.1:3000'), /localhost|phone cannot reach/i);
  assert.throws(() => lanBaseUrlFromPublicAppUrl('http://8.8.8.8:3000'), /private LAN/i);
  assert.throws(() => lanBaseUrlFromPublicAppUrl('http://192.168.1.20:3000/api'), /origin only/i);
  assert.throws(
    () => validateApiBaseUrl('http://127.0.0.1:3000', { allowCleartext: true, environment: 'lan' }),
    /localhost|10\.0\.2\.2/i
  );
  assert.throws(
    () => validateApiBaseUrl('https://localhost:3000', { allowCleartext: false, environment: 'production' }),
    /localhost|10\.0\.2\.2/i
  );
});

test('a stale PUBLIC_APP_URL from an old DHCP lease is detected before building', () => {
  const interfaces = {
    'Wi-Fi': [{ address: '10.74.75.13', family: 'IPv4', internal: false }],
    'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }]
  };
  assert.equal(isCurrentMachineAddress('10.74.75.13', interfaces), true);
  assert.equal(isCurrentMachineAddress('10.27.244.13', interfaces), false);
  // A public hostname or tunnel is not a local interface and must not fail.
  assert.equal(isCurrentMachineAddress('dev-tunnel.example.test', interfaces), true);
});

test('LAN auto-detection prefers a Wi-Fi adapter over virtual or loopback interfaces', () => {
  const interfaces = {
    'vEthernet (WSL)': [{ address: '172.20.0.1', family: 'IPv4', internal: false }],
    'TAP-Windows Adapter V9': [{ address: '10.8.0.2', family: 'IPv4', internal: false }],
    'Wi-Fi': [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
    'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }]
  };
  assert.deepEqual(findPrivateLanIp(interfaces), {
    name: 'Wi-Fi',
    address: '192.168.1.20',
    wireless: true
  });
});

test('LAN auto-detection accepts Ethernet-only PCs and rejects public addresses', () => {
  assert.deepEqual(
    findPrivateLanIp({ Ethernet: [{ address: '192.168.1.20', family: 4, internal: false }] }),
    { name: 'Ethernet', address: '192.168.1.20', wireless: false }
  );
  assert.equal(findPrivateLanIp({ 'Wi-Fi': [{ address: '8.8.8.8', family: 'IPv4', internal: false }] }), null);
  assert.equal(findPrivateLanIp({}), null);
});

test('API origins must be bare origins without paths, queries or credentials', () => {
  assert.equal(normaliseBaseUrl('https://easy-gateway.onrender.com/'), 'https://easy-gateway.onrender.com');
  assert.throws(() => normaliseBaseUrl('https://example.com/api'), /origin only/i);
  assert.throws(() => normaliseBaseUrl('https://user:pass@example.com'), /credentials/i);
  assert.throws(() => normaliseBaseUrl('ftp://example.com'), /http|https/i);
  assert.throws(() => normaliseBaseUrl('not a url'), /valid URL/i);
  assert.throws(() => normaliseBaseUrl('https://'), /valid URL/i);
});

test('unknown environments fail instead of silently falling back', () => {
  assert.throws(() => resolveApiBaseUrl({ environment: 'staging' }), /Unknown environment/i);
});

test('QR allow-list includes production plus the configured API host', () => {
  const hosts = allowedQrHosts('https://dev.example.test');
  assert.ok(hosts.includes('easy-gateway.onrender.com'));
  assert.ok(hosts.includes('dev.example.test'));
});
