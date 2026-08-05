'use strict';

// Everything that touches the disk lives here, so src/checks.js can stay pure
// and the test suite never needs fixture directories.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return '';
  }
}

// Resolve the Expo config. app.json is a straight read. app.config.js and
// app.config.ts have to be executed to know what they produce, and asking Expo
// itself is the only way to get that right, since the file can read env vars,
// import helpers, or be TypeScript. We shell out to the project's own expo CLI
// and fall back to app.json if that is not available.
function loadAppConfig(root) {
  const staticPath = ['app.json', 'app.config.json'].map((f) => path.join(root, f)).find(fs.existsSync);
  const dynamicPath = ['app.config.ts', 'app.config.js', 'app.config.mjs']
    .map((f) => path.join(root, f))
    .find(fs.existsSync);

  if (dynamicPath) {
    try {
      const out = execFileSync('npx', ['--no-install', 'expo', 'config', '--json', '--type', 'public'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 90000,
      });
      const parsed = JSON.parse(out);
      // `expo config` returns the resolved config, already unwrapped.
      return { config: parsed.expo || parsed, source: path.basename(dynamicPath), evaluated: true };
    } catch (e) {
      // Fall through to the static file. Reporting this matters, because a
      // dynamic config we could not evaluate means several checks are guessing.
      const staticJson = staticPath ? readJson(staticPath) : null;
      return {
        config: (staticJson && (staticJson.expo || staticJson)) || null,
        source: path.basename(dynamicPath),
        evaluated: false,
      };
    }
  }

  if (staticPath) {
    const json = readJson(staticPath);
    return { config: (json && (json.expo || json)) || null, source: path.basename(staticPath), evaluated: true };
  }
  return { config: null, source: null, evaluated: false };
}

// PNG dimensions and alpha, straight from the header. The 8 byte signature is
// followed by the IHDR chunk: 4 byte length, the type, then width, height, bit
// depth and colour type. Colour types 4 and 6 carry alpha; a tRNS chunk adds
// transparency to the others. No dependency needed for any of it.
function readPngInfo(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return null;
  }
  if (buf.length < 33) return null;
  const sig = buf.subarray(0, 8).toString('hex');
  if (sig !== '89504e470d0a1a0a') return { path: file, unsupported: true };

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const colorType = buf.readUInt8(25);

  let hasAlpha = colorType === 4 || colorType === 6;
  if (!hasAlpha) {
    // Walk the chunks looking for tRNS, stopping at the image data.
    let off = 8;
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.subarray(off + 4, off + 8).toString('ascii');
      if (type === 'tRNS') {
        hasAlpha = true;
        break;
      }
      if (type === 'IDAT' || type === 'IEND') break;
      off += 12 + len;
    }
  }
  return { path: path.basename(file), width, height, colorType, hasAlpha };
}

// Names only. We deliberately never read a single value, so this tool cannot
// leak a secret into its own output or into CI logs.
function collectEnvNames(root, easJson) {
  const names = new Set();

  for (const f of ['.env', '.env.local', '.env.production', '.env.development']) {
    const text = readText(path.join(root, f));
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (m) names.add(m[1]);
    }
  }

  const profiles = (easJson && easJson.build) || {};
  for (const name of Object.keys(profiles)) {
    const env = profiles[name] && profiles[name].env;
    if (env) for (const k of Object.keys(env)) names.add(k);
  }

  return Array.from(names);
}

// Files that exist and that git is not already ignoring. Asking git rather than
// reinterpreting .gitignore ourselves means global excludes and nested ignore
// files are handled correctly. Outside a repo, everything present counts.
function collectSensitiveFiles(root, patterns) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'Pods') continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(abs, depth + 1);
        continue;
      }
      const matched = patterns.some((p) =>
        p.glob.startsWith('*.') ? ent.name.endsWith(p.glob.slice(1)) : ent.name === p.glob
      );
      if (matched) found.push(path.relative(root, abs));
    }
  };
  walk(root, 0);

  if (!found.length) return [];

  // Drop anything git already ignores; those cannot be committed by accident.
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root,
      stdio: 'ignore',
    });
  } catch (e) {
    return found; // not a git repo, report everything present
  }

  const notIgnored = [];
  for (const f of found) {
    try {
      execFileSync('git', ['check-ignore', '-q', f], { cwd: root, stdio: 'ignore' });
      // exit 0 means ignored, so skip it
    } catch (e) {
      notIgnored.push(f);
    }
  }
  return notIgnored;
}

// Bare projects keep their entitlements in ios/. Parse just enough plist to
// find aps-environment: a <key> followed by its <string>.
function loadIosEntitlements(root) {
  const iosDir = path.join(root, 'ios');
  if (!fs.existsSync(iosDir)) return { hasBareIos: false, entitlements: null };

  let files = [];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      if (ent.name === 'Pods' || ent.name === 'build') continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs, depth + 1);
      else if (ent.name.endsWith('.entitlements')) files.push(abs);
    }
  };
  walk(iosDir, 0);

  const merged = {};
  for (const f of files) {
    const text = readText(f);
    const re = /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g;
    let m;
    while ((m = re.exec(text))) merged[m[1]] = m[2];
  }
  return { hasBareIos: true, entitlements: files.length ? merged : {} };
}

function resolveIconPath(root, config) {
  const candidates = [
    config && config.ios && config.ios.icon,
    config && config.icon,
  ].filter(Boolean);
  for (const rel of candidates) {
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

// Merge a build profile with whatever it extends, so a check can ask about the
// effective value rather than reimplementing inheritance.
function resolveProfile(profiles, name, seen) {
  const p = (profiles || {})[name];
  if (!p) return null;
  const guard = seen || new Set([name]);
  if (!p.extends || guard.has(p.extends)) return p;
  guard.add(p.extends);
  const base = resolveProfile(profiles, p.extends, guard) || {};
  return { ...base, ...p, ios: { ...(base.ios || {}), ...(p.ios || {}) }, android: { ...(base.android || {}), ...(p.android || {}) } };
}

function loadProject(root) {
  const pkg = readJson(path.join(root, 'package.json')) || {};
  const easJson = readJson(path.join(root, 'eas.json'));
  const { config, source, evaluated } = loadAppConfig(root);
  const cfg = config || {};

  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const iconPath = resolveIconPath(root, cfg);
  const { hasBareIos, entitlements } = loadIosEntitlements(root);
  const production = resolveProfile(easJson && easJson.build, 'production');

  return {
    root,
    configSource: source,
    configEvaluated: evaluated,
    hasConfig: !!config,
    pkg,
    deps,
    easJson,
    config: cfg,
    sdkVersion: (deps.expo || '').replace(/^[^\d]*/, '') || cfg.sdkVersion || '',
    iconInfo: iconPath ? readPngInfo(iconPath) : null,
    entitlements,
    hasBareIos,
    envNames: collectEnvNames(root, easJson),
    sensitiveFiles: collectSensitiveFiles(root, require('./checks.js').SECRET_FILE_PATTERNS),
    gitignore: readText(path.join(root, '.gitignore')),
    buildProfiles: (easJson && easJson.build) || null,
    productionProfile: production,
    submitProduction: (easJson && easJson.submit && easJson.submit.production) || null,
  };
}

module.exports = {
  loadProject,
  loadAppConfig,
  readPngInfo,
  collectEnvNames,
  collectSensitiveFiles,
  loadIosEntitlements,
  resolveProfile,
  readJson,
  readText,
};
