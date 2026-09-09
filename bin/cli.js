#!/usr/bin/env node
'use strict';

const path = require('path');
const checks = require('../src/checks.js');
const { loadProject } = require('../src/load.js');
const { render, renderJson } = require('../src/report.js');

const HELP = `
expo-preflight  ::  what App Review will reject, before you build

  npx expo-preflight [options]

Runs against the Expo project in the current directory. Reads config, eas.json,
package.json, your icon and any ios/ entitlements, then reports what will fail
at upload or in review. Nothing is sent anywhere, and no environment variable
values are read, only their names.

Options
  --json           machine-readable output
  --verbose        include checks skipped as not applicable
  --dir <path>     project directory, default cwd
  --no-warn-exit   exit 0 even with warnings (default already ignores warnings)
  --strict         exit 1 on warnings too
  -h, --help       this
  -v, --version    print version

Exit codes
  0  no blocking problems
  1  at least one blocking problem (or any warning under --strict)
  2  no Expo project found here

A missing project is deliberately not 1, so a misconfigured CI path does not look like a failing app.
`;

function parseArgs(argv) {
  const opts = { json: false, verbose: false, dir: process.cwd(), strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--no-warn-exit') opts.strict = false;
    else if (a === '--dir') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        process.stderr.write('--dir requires a path. Try --help.\n');
        process.exit(2);
      }
      opts.dir = path.resolve(next);
      i += 1;
    }
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a.startsWith('-')) opts.unknown = a;
  }
  return opts;
}

function runChecks(p) {
  const cfg = p.config || {};
  const ios = cfg.ios || {};
  const android = cfg.android || {};
  const prod = p.productionProfile || {};
  const autoIncrement = !!(prod.autoIncrement || (prod.ios && prod.ios.autoIncrement));

  return [
    checks.checkSecretFiles(p.sensitiveFiles, p.gitignore),
    checks.checkPublicEnvSecrets(p.envNames),
    checks.checkPermissionStrings(p.deps, ios.infoPlist),
    checks.checkTrackingTransparency(p.deps, ios.infoPlist),
    checks.checkIcon(p.iconInfo),
    checks.checkBundleIds(ios.bundleIdentifier, android.package),
    checks.checkStoreUrls(cfg.extra),
    checks.checkExportCompliance(ios.config),
    checks.checkVersioning(cfg.version, ios.buildNumber, android.versionCode, autoIncrement),
    checks.checkSubmitConfig(p.submitProduction),
    checks.checkPushSetup(p.deps, p.entitlements, p.hasBareIos),
    checks.checkUpdatesWiring(cfg.updates, p.deps),
    checks.checkRuntimeVersion(cfg.runtimeVersion, cfg.version, !!(cfg.updates && cfg.updates.url)),
    checks.checkUpdateChannels(p.buildProfiles),
    checks.checkAndroidIcon(android.adaptiveIcon, p.iconInfo),
    checks.checkPlayServiceAccount(p.submitProduction && p.submitProduction.android, p.sensitiveFiles, p.gitignore),
    checks.checkSdkVersion(p.sdkVersion),
  ];
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (opts.version) {
    process.stdout.write(require('../package.json').version + '\n');
    return 0;
  }
  if (opts.unknown) {
    process.stderr.write(`Unknown option ${opts.unknown}. Try --help.\n`);
    return 2;
  }

  let p;
  try {
    p = loadProject(opts.dir);
  } catch (e) {
    process.stderr.write(`Could not read the project: ${e.message}\n`);
    return 2;
  }

  if (!p.hasConfig) {
    const msg = `No Expo config found in ${opts.dir}. Looked for app.json, app.config.js and app.config.ts.\n`;
    if (opts.json) process.stdout.write(JSON.stringify({ ok: false, error: 'no_expo_project', dir: opts.dir }, null, 2) + '\n');
    else process.stderr.write(msg);
    return 2;
  }

  const results = runChecks(p);
  const meta = {
    configSource: p.configSource,
    configEvaluated: p.configEvaluated,
    appName: p.config.name,
    version: p.config.version,
    verbose: opts.verbose,
  };

  process.stdout.write((opts.json ? renderJson(results, meta) : render(results, meta)) + '\n');

  const fails = results.filter((r) => r.status === checks.FAIL).length;
  const warns = results.filter((r) => r.status === checks.WARN).length;
  return fails > 0 || (opts.strict && warns > 0) ? 1 : 0;
}

process.exitCode = main();
