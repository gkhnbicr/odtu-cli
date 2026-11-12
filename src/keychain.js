/**
 * Cross-platform OS credential store helper (with ODTU_PASSWORD env fallback).
 * - macOS:   Keychain via `security` CLI (`odtu-b64:` ASCII-encoded UTF-8 payload)
 * - Linux:   Freedesktop Secret Service via `secret-tool` (GNOME Keyring / KDE Wallet)
 * - Windows: DPAPI CurrentUser encryption via PowerShell -> ~/.odtuclass/credentials.dpapi.json
 */

import { spawnSync } from 'child_process';
import {
  accessSync, chmodSync, constants, existsSync,
  mkdirSync, readFileSync, unlinkSync, writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { delimiter, dirname, join } from 'path';

const SERVICE = 'odtu-cli-metu';
const B64_PREFIX = 'odtu-b64:';
const DPAPI_ENTROPY = 'odtu-cli-metu';
const SECURE_BACKENDS = new Set(['keychain', 'secret-service', 'windows-dpapi']);

const PS_PROTECT = [
  "$ErrorActionPreference = 'Stop'",
  "if (-not ('System.Security.Cryptography.ProtectedData' -as [type])) {",
  '  try { Add-Type -AssemblyName System.Security } catch { Add-Type -AssemblyName System.Security.Cryptography.ProtectedData }',
  '}',
  '$raw = [Console]::In.ReadToEnd().Trim()',
  '$bytes = [System.Text.Encoding]::UTF8.GetBytes($raw)',
  `$entropy = [System.Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`,
  '$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Convert]::ToBase64String($protected)',
].join('\n');

const PS_UNPROTECT = [
  "$ErrorActionPreference = 'Stop'",
  "if (-not ('System.Security.Cryptography.ProtectedData' -as [type])) {",
  '  try { Add-Type -AssemblyName System.Security } catch { Add-Type -AssemblyName System.Security.Cryptography.ProtectedData }',
  '}',
  '$blobB64 = [Console]::In.ReadToEnd().Trim()',
  '$blob = [Convert]::FromBase64String($blobB64)',
  `$entropy = [System.Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`,
  '$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[System.Text.Encoding]::UTF8.GetString($bytes)',
].join('\n');

function encodeSecret(password) {
  return `${B64_PREFIX}${Buffer.from(password, 'utf8').toString('base64')}`;
}

function decodeSecret(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/\r?\n$/, '');
  if (!cleaned.length) return null;
  if (cleaned.startsWith(B64_PREFIX)) {
    return Buffer.from(cleaned.slice(B64_PREFIX.length), 'base64').toString('utf8');
  }
  return cleaned;
}

export function isSecureStorage(storage) {
  return SECURE_BACKENDS.has(storage);
}

/**
 * Creates a credential store bound to real OS primitives or injected test doubles.
 */
export function createKeychainStore(deps = {}) {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const runSpawn = deps.spawnSync ?? spawnSync;
  const fileExists = deps.existsSync ?? existsSync;
  const fileAccess = deps.accessSync ?? accessSync;
  const readFile = deps.readFileSync ?? readFileSync;
  const writeFile = deps.writeFileSync ?? writeFileSync;
  const mkdir = deps.mkdirSync ?? mkdirSync;
  const chmod = deps.chmodSync ?? chmodSync;
  const unlink = deps.unlinkSync ?? unlinkSync;
  const getuid = deps.getuid ?? (typeof process.getuid === 'function' ? () => process.getuid() : null);
  const pathSep = deps.pathDelimiter ?? (platform === 'win32' ? ';' : delimiter);
  const credFile = deps.windowsCredFile ?? join(homedir(), '.odtuclass', 'credentials.dpapi.json');

  function findExecutable(names) {
    const dirs = (env.PATH || '').split(pathSep).filter(Boolean);
    for (const name of names) {
      for (const dir of dirs) {
        const full = join(dir, name);
        try {
          if (!fileExists(full)) continue;
          if (platform !== 'win32') {
            fileAccess(full, constants.X_OK);
          }
          return full;
        } catch { /* try next */ }
      }
    }
    return null;
  }

  function resolveLinuxDbusEnv() {
    if (env.DBUS_SESSION_BUS_ADDRESS) return env;
    if (!getuid) return null;
    const bus = `/run/user/${getuid()}/bus`;
    if (!fileExists(bus)) return null;
    return { ...env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}` };
  }

  function findWindowsPowerShell() {
    const found = findExecutable(['powershell.exe', 'pwsh.exe', 'powershell', 'pwsh']);
    if (found) return found;
    const systemRoot = env.SystemRoot || 'C:\\Windows';
    const fallback = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return fileExists(fallback) ? fallback : null;
  }

  function getCredentialBackend() {
    if (platform === 'darwin') return 'keychain';
    if (platform === 'linux') {
      return findExecutable(['secret-tool']) && resolveLinuxDbusEnv() ? 'secret-service' : null;
    }
    if (platform === 'win32') {
      return findWindowsPowerShell() ? 'windows-dpapi' : null;
    }
    return null;
  }

  function isCredentialStoreSupported() {
    return getCredentialBackend() !== null;
  }

  function isMacKeychainSupported() {
    return platform === 'darwin';
  }

  function readDpapiStore() {
    if (!fileExists(credFile)) return { version: 1, entries: {} };
    try {
      const parsed = JSON.parse(readFile(credFile, 'utf8'));
      const entries = parsed && typeof parsed.entries === 'object' && parsed.entries !== null
        ? parsed.entries
        : {};
      return { version: 1, entries };
    } catch {
      return { version: 1, entries: {} };
    }
  }

  function writeDpapiStore(store) {
    mkdir(dirname(credFile), { recursive: true });
    writeFile(credFile, JSON.stringify(store));
    try {
      chmod(credFile, 0o600);
    } catch { /* ignore on non-POSIX */ }
  }

  function runPowerShell(script, input) {
    const ps = findWindowsPowerShell();
    if (!ps) return { status: 1, stdout: '', stderr: 'PowerShell not found' };
    return runSpawn(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
      input,
      encoding: 'utf8',
      timeout: 8000,
    });
  }

  function getKeychainPassword(username) {
    if (!username) return null;
    const backend = getCredentialBackend();
    if (!backend) return null;

    if (backend === 'keychain') {
      const res = runSpawn(
        'security',
        ['find-generic-password', '-w', '-a', username, '-s', SERVICE],
        { encoding: 'utf8' },
      );
      if (res.status !== 0) return null;
      return decodeSecret(res.stdout);
    }

    if (backend === 'secret-service') {
      const dbusEnv = resolveLinuxDbusEnv();
      if (!dbusEnv) return null;
      const res = runSpawn(
        'secret-tool',
        ['lookup', 'service', SERVICE, 'account', username],
        { encoding: 'utf8', env: dbusEnv, timeout: 4000 },
      );
      if (res.status !== 0) return null;
      return decodeSecret(res.stdout);
    }

    const store = readDpapiStore();
    const blob = store.entries[username];
    if (typeof blob !== 'string' || !blob.length) return null;
    const res = runPowerShell(PS_UNPROTECT, blob);
    if (res.status !== 0) return null;
    return decodeSecret(res.stdout);
  }

  function getPassword(username) {
    if (env.ODTU_PASSWORD) {
      return env.ODTU_PASSWORD;
    }
    return getKeychainPassword(username);
  }

  function hasKeychainPassword(username) {
    if (!username) return false;
    const backend = getCredentialBackend();
    if (!backend) return false;

    if (backend === 'keychain') {
      const res = runSpawn(
        'security',
        ['find-generic-password', '-a', username, '-s', SERVICE],
        { stdio: 'ignore' },
      );
      return res.status === 0;
    }

    if (backend === 'secret-service') {
      return getKeychainPassword(username) !== null;
    }

    const store = readDpapiStore();
    return typeof store.entries[username] === 'string' && store.entries[username].length > 0;
  }

  function hasPassword(username) {
    if (env.ODTU_PASSWORD) return true;
    return hasKeychainPassword(username);
  }

  function savePassword(username, password) {
    if (!username || !password) return false;
    const backend = getCredentialBackend();
    if (!backend) return false;

    const encoded = encodeSecret(password);

    if (backend === 'keychain') {
      // Hex payload keeps non-ASCII UTF-8 bytes lossless through macOS `security`
      const hex = Buffer.from(encoded, 'utf8').toString('hex');
      const acct = JSON.stringify(username);
      const cmd = `add-generic-password -U -a ${acct} -s "${SERVICE}" -X ${hex}\n`;
      const res = runSpawn('security', ['-i'], {
        input: cmd,
        encoding: 'utf8',
      });
      return res.status === 0;
    }

    if (backend === 'secret-service') {
      const dbusEnv = resolveLinuxDbusEnv();
      if (!dbusEnv) return false;
      const res = runSpawn(
        'secret-tool',
        ['store', `--label=odtu-cli (${username})`, 'service', SERVICE, 'account', username],
        { input: encoded, encoding: 'utf8', env: dbusEnv, timeout: 4000 },
      );
      return res.status === 0;
    }

    const res = runPowerShell(PS_PROTECT, encoded);
    const blob = typeof res.stdout === 'string' ? res.stdout.trim() : '';
    if (res.status !== 0 || !blob) return false;
    try {
      const store = readDpapiStore();
      store.entries[username] = blob;
      writeDpapiStore(store);
      return true;
    } catch {
      return false;
    }
  }

  function deletePassword(username) {
    if (!username) {
      return { ok: true, removed: false, notFound: true };
    }
    const backend = getCredentialBackend();
    if (!backend) {
      return { ok: true, removed: false, notFound: true };
    }

    if (backend === 'keychain') {
      const res = runSpawn(
        'security',
        ['delete-generic-password', '-a', username, '-s', SERVICE],
        { encoding: 'utf8' },
      );
      if (res.status === 0) {
        return { ok: true, removed: true, notFound: false };
      }
      const err = (res.stderr || res.stdout || '').trim();
      // macOS `security` exits 44 ("The specified item could not be found in the keychain")
      if (res.status === 44 || /could not be found/i.test(err)) {
        return { ok: true, removed: false, notFound: true };
      }
      return {
        ok: false,
        removed: false,
        notFound: false,
        error: err || `security exited with status ${res.status}`,
      };
    }

    if (backend === 'secret-service') {
      const dbusEnv = resolveLinuxDbusEnv();
      if (!dbusEnv) {
        return { ok: true, removed: false, notFound: true };
      }
      const existed = getKeychainPassword(username) !== null;
      const res = runSpawn(
        'secret-tool',
        ['clear', 'service', SERVICE, 'account', username],
        { encoding: 'utf8', env: dbusEnv, timeout: 4000 },
      );
      if (res.status === 0) {
        return { ok: true, removed: existed, notFound: !existed };
      }
      const err = (res.stderr || res.stdout || '').trim();
      return {
        ok: false,
        removed: false,
        notFound: false,
        error: err || `secret-tool exited with status ${res.status}`,
      };
    }

    try {
      if (!fileExists(credFile)) {
        return { ok: true, removed: false, notFound: true };
      }
      const store = readDpapiStore();
      if (!(username in store.entries)) {
        return { ok: true, removed: false, notFound: true };
      }
      delete store.entries[username];
      if (Object.keys(store.entries).length === 0) {
        unlink(credFile);
      } else {
        writeDpapiStore(store);
      }
      return { ok: true, removed: true, notFound: false };
    } catch (e) {
      return {
        ok: false,
        removed: false,
        notFound: false,
        error: e?.message || 'Failed to update DPAPI credential store',
      };
    }
  }

  function getRetryDeleteCommand(username) {
    const backend = getCredentialBackend();
    if (backend === 'keychain') {
      return `security delete-generic-password -a ${JSON.stringify(username)} -s ${SERVICE}`;
    }
    if (backend === 'secret-service') {
      return `secret-tool clear service ${SERVICE} account ${JSON.stringify(username)}`;
    }
    if (backend === 'windows-dpapi') {
      return `Remove ${JSON.stringify(username)} from ${credFile}`;
    }
    return null;
  }

  return {
    getCredentialBackend,
    isCredentialStoreSupported,
    isMacKeychainSupported,
    getKeychainPassword,
    getPassword,
    hasKeychainPassword,
    hasPassword,
    savePassword,
    deletePassword,
    getRetryDeleteCommand,
  };
}

const defaultStore = createKeychainStore();

export const {
  getCredentialBackend,
  isCredentialStoreSupported,
  isMacKeychainSupported,
  getKeychainPassword,
  getPassword,
  hasKeychainPassword,
  hasPassword,
  savePassword,
  deletePassword,
  getRetryDeleteCommand,
} = defaultStore;
