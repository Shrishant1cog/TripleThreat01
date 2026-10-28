#!/usr/bin/env node
/**
 * Build the Easy Gateway Android APK with an explicit API environment.
 *
 * Usage:
 *   node scripts/build-android.mjs                       # production API, debug APK
 *   node scripts/build-android.mjs --env emulator        # 10.0.2.2:3000, debug APK
 *   node scripts/build-android.mjs --env lan --lan-ip 192.168.1.20
 *   node scripts/build-android.mjs --env lan --lan-ip auto
 *   node scripts/build-android.mjs --env production --release
 *
 * Production builds are HTTPS-only. Cleartext HTTP is accepted only for explicit
 * emulator/LAN debug builds. Release builds remain unsigned unless a signing
 * config is added to android/app/build.gradle; see README.md.
 */
import { existsSync, mkdirSync, copyFileSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPrivateLanIp, resolveApiBaseUrl } from '../config/environments.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function option(name, fallback = '') {
  const inline = args.find(arg => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')) return args[index + 1];
  return fallback;
}

function run(command, commandArgs, options = {}) {
  console.log(`\n$ ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`);
}

function findAndroidSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk')
      : '',
    process.platform === 'darwin' ? join(process.env.HOME || '', 'Library', 'Android', 'sdk') : '',
    process.platform === 'linux' ? join(process.env.HOME || '', 'Android', 'Sdk') : ''
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate)) || '';
}

function javaMajor(home) {
  try {
    const release = readFileSync(join(home, 'release'), 'utf8');
    const match = release.match(/JAVA_VERSION="(\d+)/);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

function findJdk21() {
  const candidates = [
    process.env.EASY_GATEWAY_JAVA_HOME,
    'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.12.101-hotspot',
    'C:\\Program Files\\Java\\jdk-21',
    '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home',
    process.env.JAVA_HOME
  ].filter(Boolean);
  const installed = candidates.filter(candidate =>
    existsSync(join(candidate, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))
  );
  // Prefer a Java 21+ home; fall back to any installed JDK only if none is newer.
  installed.sort((a, b) => {
    const score = home => {
      const major = javaMajor(home);
      return major >= 21 ? 1000 + major : major;
    };
    return score(b) - score(a);
  });
  return installed[0] || '';
}

const environment = option('env', process.env.EASY_GATEWAY_ENV || 'production').toLowerCase();
const release = args.includes('--release');
const skipSync = args.includes('--skip-sync');
let lanIp = option('lan-ip', process.env.EASY_GATEWAY_LAN_IP || '');
const port = option('port', process.env.EASY_GATEWAY_PORT || '3000');

if (release && environment !== 'production') {
  throw new Error('Release builds must use --env production. HTTP debug environments are debug-only.');
}

if (environment === 'lan' && lanIp.toLowerCase() === 'auto') {
  const detected = findPrivateLanIp(networkInterfaces());
  if (!detected) {
    throw new Error('No private LAN IPv4 address was detected. Pass --lan-ip with the development PC address.');
  }
  lanIp = detected.address;
  console.log(`Auto-detected LAN address: ${detected.address} (${detected.name})`);
}

const resolved = resolveApiBaseUrl({
  environment,
  apiBaseUrl: option('api-base-url', ''),
  lanIp,
  port
});

if (resolved.allowCleartext && !release) {
  console.log('Debug build: cleartext HTTP is limited to the explicitly configured private host.');
}
if (/localhost|127\.0\.0\.1/i.test(resolved.baseUrl)) {
  throw new Error('localhost is not a valid production or emulator endpoint. Use 10.0.2.2 for the emulator or a LAN IP for a phone.');
}

const sdk = findAndroidSdk();
if (!sdk) throw new Error('Android SDK not found. Set ANDROID_HOME to an installed Android SDK.');
const javaHome = findJdk21();
if (!javaHome) throw new Error('JDK 21 not found. Set EASY_GATEWAY_JAVA_HOME or JAVA_HOME to a JDK 21 installation.');

const androidDir = join(root, 'android');
if (!existsSync(androidDir)) throw new Error('android/ is missing. Run npm install && npx cap add android first.');
const localProperties = join(androidDir, 'local.properties');
if (!existsSync(localProperties)) {
  writeFileSync(localProperties, `sdk.dir=${sdk.replace(/\\/g, '/')}\n`, 'utf8');
  console.log(`Wrote ${localProperties}`);
}

const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: sdk,
  ANDROID_SDK_ROOT: sdk
};
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
env[pathKey] = [join(javaHome, 'bin'), join(sdk, 'platform-tools'), env[pathKey] || ''].filter(Boolean).join(delimiter);
const environmentLabel = environment === 'production' ? 'Production' : environment === 'emulator' ? 'Emulator' : 'LAN';

console.log(`\nEasy Gateway Android build`);
console.log(`  API base:   ${resolved.baseUrl}`);
console.log(`  Environment:${resolved.label}`);
console.log(`  Cleartext:  ${resolved.allowCleartext ? 'allowed (debug only)' : 'blocked'}`);
console.log(`  Variant:    ${release ? 'release' : 'debug'}`);
console.log(`  JDK:        ${javaHome}`);
console.log(`  SDK:        ${sdk}`);

if (!skipSync) {
  run('node', [join(root, 'scripts', 'verify-web.mjs')], { env });
  run('npx', ['cap', 'sync', 'android'], { cwd: root, env });
} else {
  console.log('Skipping cap sync (--skip-sync).');
}

const task = release ? 'assembleRelease' : 'assembleDebug';
run(process.platform === 'win32' ? 'gradlew.bat' : './gradlew', [
  task,
  `-PeasyGateway.apiBaseUrl=${resolved.baseUrl}`,
  `-PeasyGateway.allowCleartext=${resolved.allowCleartext}`,
  `-PeasyGateway.environmentLabel=${environmentLabel}`
], { cwd: androidDir, env });

const candidates = release
  ? [
      join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
      join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk')
    ]
  : [join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')];

const apk = candidates.find(candidate => existsSync(candidate));
if (!apk) throw new Error(`Gradle finished but no APK was found in:\n${candidates.join('\n')}`);

const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });
const output = join(dist, `EasyGateway-${environment}-${release ? 'release' : 'debug'}.apk`);
copyFileSync(apk, output);
const size = statSync(output).size;
if (size < 1024 * 1024) throw new Error(`APK looks too small (${size} bytes).`);

console.log(`\nAPK ready: ${output}`);
console.log(`Size: ${(size / (1024 * 1024)).toFixed(1)} MB`);
if (release && apk.endsWith('-unsigned.apk')) {
  console.log('This release APK is unsigned. Configure a signing key in android/app/build.gradle before distribution.');
}
