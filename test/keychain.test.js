import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeychainStore, isSecureStorage } from '../src/keychain.js';

test('isSecureStorage recognizes all three OS backends only', () => {
  assert.equal(isSecureStorage('keychain'), true);
  assert.equal(isSecureStorage('secret-service'), true);
  assert.equal(isSecureStorage('windows-dpapi'), true);
  assert.equal(isSecureStorage('session-file'), false);
  assert.equal(isSecureStorage('none'), false);
});

test('macOS backend encodes non-ASCII passwords with odtu-b64 and handles delete exit 44', () => {
  let savedInput = '';
  let storedHex = '';
  const store = createKeychainStore({
    platform: 'darwin',
    env: {},
    spawnSync: (cmd, args, opts) => {
      assert.equal(cmd, 'security');
      if (args[0] === '-i') {
        savedInput = opts.input;
        const m = savedInput.match(/-X ([0-9a-f]+)\n$/);
        storedHex = m[1];
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'find-generic-password' && args[1] === '-w') {
        const decoded = Buffer.from(storedHex, 'hex').toString('utf8');
        return { status: 0, stdout: `${decoded}\n`, stderr: '' };
      }
      if (args[0] === 'find-generic-password') {
        return { status: storedHex ? 0 : 44, stdout: '', stderr: '' };
      }
      if (args[0] === 'delete-generic-password') {
        if (!storedHex) {
          return { status: 44, stdout: '', stderr: 'security: The specified item could not be found in the keychain.' };
        }
        storedHex = '';
        return { status: 0, stdout: '', stderr: '' };
      }
      throw new Error(`Unexpected security args: ${args.join(' ')}`);
    },
  });

  assert.equal(store.getCredentialBackend(), 'keychain');
  assert.equal(store.savePassword('e276407', 'p@ss-şğüöçıİ-€!'), true);
  assert.ok(Buffer.from(storedHex, 'hex').toString('utf8').startsWith('odtu-b64:'));
  assert.equal(store.hasKeychainPassword('e276407'), true);
  assert.equal(store.getKeychainPassword('e276407'), 'p@ss-şğüöçıİ-€!');
  assert.deepEqual(store.deletePassword('e276407'), { ok: true, removed: true, notFound: false });
  assert.deepEqual(store.deletePassword('e276407'), { ok: true, removed: false, notFound: true });
});

test('Linux secret-tool backend discovers /run/user/<uid>/bus over SSH and round-trips UTF-8', () => {
  const entries = new Map();
  let seenDbus = null;
  const store = createKeychainStore({
    platform: 'linux',
    env: { PATH: '/usr/bin:/bin' },
    getuid: () => 1000,
    existsSync: (p) => p === '/usr/bin/secret-tool' || p === '/run/user/1000/bus',
    accessSync: () => {},
    spawnSync: (cmd, args, opts) => {
      assert.equal(cmd, 'secret-tool');
      seenDbus = opts.env.DBUS_SESSION_BUS_ADDRESS;
      const acctIdx = args.indexOf('account');
      const user = args[acctIdx + 1];
      if (args[0] === 'store') {
        entries.set(user, opts.input);
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'lookup') {
        if (!entries.has(user)) return { status: 1, stdout: '', stderr: '' };
        return { status: 0, stdout: `${entries.get(user)}\n`, stderr: '' };
      }
      if (args[0] === 'clear') {
        entries.delete(user);
        return { status: 0, stdout: '', stderr: '' };
      }
      throw new Error(`Unexpected secret-tool args: ${args.join(' ')}`);
    },
  });

  assert.equal(store.getCredentialBackend(), 'secret-service');
  assert.equal(store.savePassword('e276407', 'linux-şifre-İ€'), true);
  assert.equal(seenDbus, 'unix:path=/run/user/1000/bus');
  assert.equal(store.hasKeychainPassword('e276407'), true);
  assert.equal(store.getKeychainPassword('e276407'), 'linux-şifre-İ€');
  assert.deepEqual(store.deletePassword('e276407'), { ok: true, removed: true, notFound: false });
  assert.deepEqual(store.deletePassword('e276407'), { ok: true, removed: false, notFound: true });
  assert.match(store.getRetryDeleteCommand('e276407'), /^secret-tool clear service odtu-cli-metu account /);
});

test('Linux without D-Bus or secret-tool cleanly reports null backend (falls back to session-file)', () => {
  const headless = createKeychainStore({
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    getuid: () => 1000,
    existsSync: (p) => p === '/usr/bin/secret-tool', // no /run/user/1000/bus
    accessSync: () => {},
  });
  assert.equal(headless.getCredentialBackend(), null);
  assert.equal(headless.isCredentialStoreSupported(), false);
  assert.equal(headless.savePassword('e276407', 'pw'), false);
  assert.deepEqual(headless.deletePassword('e276407'), { ok: true, removed: false, notFound: true });

  // ODTU_PASSWORD env still works on headless Linux
  const withEnv = createKeychainStore({
    platform: 'linux',
    env: { PATH: '/usr/bin', ODTU_PASSWORD: 'from-env-password' },
    existsSync: () => false,
  });
  assert.equal(withEnv.getPassword('e276407'), 'from-env-password');
  assert.equal(withEnv.hasPassword('e276407'), true);
  assert.equal(withEnv.hasKeychainPassword('e276407'), false);
});

test('Windows DPAPI backend protects, reads, and deletes encrypted credentials file', () => {
  const files = new Map();
  let lastChmod = null;
  const fakeCredFile = 'C:\\Users\\test\\.odtuclass\\credentials.dpapi.json';

  const store = createKeychainStore({
    platform: 'win32',
    pathDelimiter: ';',
    env: { PATH: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0' },
    windowsCredFile: fakeCredFile,
    existsSync: (p) => p === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0/powershell.exe'
      || p === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
      || files.has(p),
    readFileSync: (p) => files.get(p),
    writeFileSync: (p, data) => files.set(p, data),
    mkdirSync: () => {},
    chmodSync: (_p, mode) => { lastChmod = mode; },
    unlinkSync: (p) => files.delete(p),
    spawnSync: (cmd, args, opts) => {
      assert.match(cmd, /powershell\.exe$/);
      const script = args[args.indexOf('-Command') + 1];
      if (script.includes('::Protect(')) {
        const dpapiBlob = `DPAPI:${Buffer.from(opts.input, 'utf8').toString('base64')}`;
        return { status: 0, stdout: `${dpapiBlob}\r\n`, stderr: '' };
      }
      if (script.includes('::Unprotect(')) {
        const raw = opts.input.replace(/^DPAPI:/, '');
        return { status: 0, stdout: `${Buffer.from(raw, 'base64').toString('utf8')}\r\n`, stderr: '' };
      }
      throw new Error(`Unexpected PowerShell script`);
    },
  });

  assert.equal(store.getCredentialBackend(), 'windows-dpapi');
  assert.equal(store.savePassword('e276407', 'win-şifre-€'), true);
  assert.equal(lastChmod, 0o600);
  assert.ok(!files.get(fakeCredFile).includes('win-şifre-€'));
  assert.equal(store.hasKeychainPassword('e276407'), true);
  assert.equal(store.getKeychainPassword('e276407'), 'win-şifre-€');
  assert.deepEqual(store.deletePassword('e276407'), { ok: true, removed: true, notFound: false });
  assert.equal(files.has(fakeCredFile), false);
  assert.deepEqual(store.deletePassword('e276407'), { ok: true, removed: false, notFound: true });
});
