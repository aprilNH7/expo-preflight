'use strict';

// Covers the parts that do touch the disk: the CLI contract, PNG header
// parsing, env-name collection, entitlement parsing and profile inheritance.
// Everything is built in a temp directory and torn down, so the suite stays
// runnable anywhere and never depends on a real Expo install.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const { readPngInfo, collectEnvNames, loadIosEntitlements, resolveProfile, loadProject } = require('../src/load.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'expo-preflight-'));
}

function run(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

// Build a real PNG so the header parser is tested against actual bytes rather
// than a hand-rolled buffer that happens to match our own assumptions.
function makePng(file, width, height, colorType) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(colorType, 9);
  const channels = colorType === 6 ? 4 : colorType === 4 ? 2 : colorType === 2 ? 3 : 1;
  const raw = Buffer.alloc(height * (1 + width * channels));
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ])
  );
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

// --- CLI contract ---------------------------------------------------------

test('--help explains itself and exits 0', () => {
  const r = run(['--help']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /expo-preflight/);
  assert.match(r.stdout, /Exit codes/);
});

test('--version prints the package version', () => {
  const r = run(['--version']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout.trim(), require('../package.json').version);
});

test('an unknown option is refused rather than ignored', () => {
  const r = run(['--nope']);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /Unknown option/);
});

test('a directory with no Expo project exits 2, not 1', () => {
  // Exit 1 would mean "your app has problems". Exit 2 means "wrong directory".
  const dir = tmpdir();
  try {
    const r = run(['--dir', dir]);
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /No Expo config found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--json still reports a missing project as machine-readable', () => {
  const dir = tmpdir();
  try {
    const r = run(['--dir', dir, '--json']);
    assert.strictEqual(r.code, 2);
    assert.strictEqual(JSON.parse(r.stdout).error, 'no_expo_project');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- end to end on a synthetic project -----------------------------------

function writeProject(dir, opts) {
  const o = opts || {};
  fs.writeFileSync(
    path.join(dir, 'app.json'),
    JSON.stringify({ expo: { name: 'Demo', slug: 'demo', version: '1.0.0', icon: './icon.png', ...(o.expo || {}) } })
  );
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', dependencies: o.deps || { expo: '53.0.0' } }));
  if (o.eas) fs.writeFileSync(path.join(dir, 'eas.json'), JSON.stringify(o.eas));
  if (o.gitignore !== undefined) fs.writeFileSync(path.join(dir, '.gitignore'), o.gitignore);
  makePng(path.join(dir, 'icon.png'), o.iconSize || 1024, o.iconSize || 1024, o.iconColorType === undefined ? 2 : o.iconColorType);
  for (const f of o.files || []) fs.writeFileSync(path.join(dir, f), 'x');
  if (o.env) fs.writeFileSync(path.join(dir, '.env'), o.env);
}

test('a clean project exits 0', () => {
  const dir = tmpdir();
  try {
    writeProject(dir, {
      expo: {
        ios: {
          bundleIdentifier: 'com.iqgen.energy',
          config: { usesNonExemptEncryption: false },
        },
        android: { package: 'com.iqgen.energy', adaptiveIcon: { foregroundImage: './icon.png' } },
        extra: { privacyPolicyUrl: 'https://x.co/p', supportUrl: 'https://x.co/s' },
      },
      eas: {
        build: { production: { channel: 'production', autoIncrement: true } },
        submit: { production: { ios: { ascAppId: '1', appleTeamId: 'T' } } },
      },
      gitignore: 'node_modules\n',
    });
    const r = run(['--dir', dir, '--json']);
    assert.strictEqual(r.code, 0, r.stdout);
    assert.strictEqual(JSON.parse(r.stdout).ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a leaked APNs key alone is enough to exit 1', () => {
  const dir = tmpdir();
  try {
    writeProject(dir, {
      expo: {
        ios: { bundleIdentifier: 'com.iqgen.energy', config: { usesNonExemptEncryption: false } },
        android: { package: 'com.iqgen.energy', adaptiveIcon: { foregroundImage: './icon.png' } },
        extra: { privacyPolicyUrl: 'https://x.co/p', supportUrl: 'https://x.co/s' },
      },
      eas: {
        build: { production: { channel: 'production', autoIncrement: true } },
        submit: { production: { ios: { ascAppId: '1', appleTeamId: 'T' } } },
      },
      gitignore: 'node_modules\n',
      files: ['AuthKey_ABC123.p8'],
    });
    const r = run(['--dir', dir, '--json']);
    assert.strictEqual(r.code, 1);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.ok, false);
    const hit = out.results.find((x) => x.id === 'secret-files');
    assert.strictEqual(hit.status, 'fail');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--strict turns warnings into a non-zero exit', () => {
  const dir = tmpdir();
  try {
    // Missing privacy URLs and no autoIncrement: warnings only.
    writeProject(dir, {
      expo: {
        ios: { bundleIdentifier: 'com.iqgen.energy', config: { usesNonExemptEncryption: false } },
        android: { package: 'com.iqgen.energy', adaptiveIcon: { foregroundImage: './icon.png' } },
      },
      eas: { build: { production: { channel: 'production' } } },
      gitignore: 'node_modules\n',
    });
    assert.strictEqual(run(['--dir', dir]).code, 0, 'warnings alone do not fail by default');
    assert.strictEqual(run(['--dir', dir, '--strict']).code, 1, '--strict fails on warnings');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the human report leads with problems, not passes', () => {
  const dir = tmpdir();
  try {
    writeProject(dir, { expo: {}, gitignore: '', files: ['AuthKey.p8'] });
    const r = run(['--dir', dir]);
    const firstVerdict = r.stdout.split('\n').find((l) => /^(PASS|FAIL|WARN|INFO)/.test(l));
    assert.match(firstVerdict, /^FAIL/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skipped checks are hidden by default and shown with --verbose', () => {
  const dir = tmpdir();
  try {
    writeProject(dir, { expo: {}, gitignore: 'node_modules\n' });
    assert.ok(!/^SKIP/m.test(run(['--dir', dir]).stdout));
    assert.ok(/^SKIP/m.test(run(['--dir', dir, '--verbose']).stdout));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an icon with an alpha channel is caught from the real PNG bytes', () => {
  const dir = tmpdir();
  try {
    writeProject(dir, { expo: {}, gitignore: 'node_modules\n', iconColorType: 6 });
    const out = JSON.parse(run(['--dir', dir, '--json']).stdout);
    const icon = out.results.find((r) => r.id === 'icon');
    assert.strictEqual(icon.status, 'fail');
    assert.match(icon.detail, /alpha channel/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('env var names are collected without reading any value', () => {
  const dir = tmpdir();
  try {
    writeProject(dir, { expo: {}, gitignore: '', env: 'EXPO_PUBLIC_API_SECRET_KEY=hunter2\nOTHER=x\n' });
    const raw = run(['--dir', dir, '--json']).stdout;
    assert.match(raw, /EXPO_PUBLIC_API_SECRET_KEY/);
    assert.ok(!raw.includes('hunter2'), 'a secret value must never reach the report');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- loader units --------------------------------------------------------

test('PNG dimensions and colour type are read from the header', () => {
  const dir = tmpdir();
  try {
    const f = path.join(dir, 'a.png');
    makePng(f, 1024, 768, 2);
    const info = readPngInfo(f);
    assert.strictEqual(info.width, 1024);
    assert.strictEqual(info.height, 768);
    assert.strictEqual(info.hasAlpha, false);

    makePng(f, 512, 512, 6);
    assert.strictEqual(readPngInfo(f).hasAlpha, true, 'colour type 6 is RGBA');

    makePng(f, 512, 512, 4);
    assert.strictEqual(readPngInfo(f).hasAlpha, true, 'colour type 4 is grey+alpha');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-PNG is reported as unsupported rather than crashing', () => {
  const dir = tmpdir();
  try {
    const f = path.join(dir, 'a.png');
    fs.writeFileSync(f, Buffer.alloc(64, 7));
    assert.strictEqual(readPngInfo(f).unsupported, true);
    assert.strictEqual(readPngInfo(path.join(dir, 'missing.png')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('env names come from both dotenv files and eas.json build profiles', () => {
  const dir = tmpdir();
  try {
    fs.writeFileSync(path.join(dir, '.env'), 'export FROM_DOTENV=1\n# c\nBAD LINE\n');
    const names = collectEnvNames(dir, { build: { production: { env: { FROM_EAS: 'x' } } } });
    assert.ok(names.includes('FROM_DOTENV'));
    assert.ok(names.includes('FROM_EAS'));
    assert.ok(!names.includes('BAD LINE'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('entitlements are parsed out of a bare ios/ directory', () => {
  const dir = tmpdir();
  try {
    fs.mkdirSync(path.join(dir, 'ios', 'Demo'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'ios', 'Demo', 'Demo.entitlements'),
      '<plist><dict><key>aps-environment</key><string>production</string></dict></plist>'
    );
    const r = loadIosEntitlements(dir);
    assert.strictEqual(r.hasBareIos, true);
    assert.strictEqual(r.entitlements['aps-environment'], 'production');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a managed project reports no bare ios directory', () => {
  const dir = tmpdir();
  try {
    assert.strictEqual(loadIosEntitlements(dir).hasBareIos, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('build profiles inherit through extends, with the child winning', () => {
  const profiles = {
    base: { node: '20', channel: 'base-channel', ios: { image: 'latest' } },
    production: { extends: 'base', channel: 'production', ios: { autoIncrement: true } },
  };
  const r = resolveProfile(profiles, 'production');
  assert.strictEqual(r.channel, 'production');
  assert.strictEqual(r.node, '20');
  assert.strictEqual(r.ios.image, 'latest', 'nested ios keys merge rather than replace');
  assert.strictEqual(r.ios.autoIncrement, true);
});

test('a circular extends chain resolves instead of recursing forever', () => {
  const r = resolveProfile({ a: { extends: 'b', x: 1 }, b: { extends: 'a', y: 2 } }, 'a');
  assert.ok(r);
});

test('loadProject reports when a dynamic config could not be evaluated', () => {
  const dir = tmpdir();
  try {
    // A config that throws. Without expo installed this cannot be evaluated,
    // and the report has to admit that rather than silently checking nothing.
    fs.writeFileSync(path.join(dir, 'app.config.js'), 'throw new Error("boom");');
    fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ expo: { name: 'Fallback', version: '9.9.9' } }));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo' }));
    const p = loadProject(dir);
    assert.strictEqual(p.configEvaluated, false);
    assert.strictEqual(p.config.name, 'Fallback', 'falls back to app.json so checks still run');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the report warns loudly when config evaluation failed', () => {
  const dir = tmpdir();
  try {
    fs.writeFileSync(path.join(dir, 'app.config.js'), 'throw new Error("boom");');
    fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ expo: { name: 'Fallback', version: '1.0.0' } }));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo' }));
    const r = run(['--dir', dir]);
    assert.match(r.stdout, /could not be evaluated/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('git-ignored credential files are not reported', () => {
  const dir = tmpdir();
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeProject(dir, { expo: {}, gitignore: '*.p8\n', files: ['AuthKey_X.p8'] });
    const out = JSON.parse(run(['--dir', dir, '--json']).stdout);
    assert.strictEqual(out.results.find((r) => r.id === 'secret-files').status, 'pass');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no source file contains an em dash', () => {
  const files = ['src/checks.js', 'src/load.js', 'src/report.js', 'bin/cli.js', 'README.md'];
  for (const f of files) {
    const p = path.join(__dirname, '..', f);
    if (!fs.existsSync(p)) continue;
    assert.ok(!fs.readFileSync(p, 'utf8').includes('\u2014'), `${f} contains an em dash`);
  }
});
