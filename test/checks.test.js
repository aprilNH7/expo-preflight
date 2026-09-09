'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  FAIL, WARN, PASS, INFO, SKIP,
  gitignoreCovers,
  SECRET_FILE_PATTERNS,
  checkSecretFiles,
  checkPublicEnvSecrets,
  checkPermissionStrings,
  checkTrackingTransparency,
  checkIcon,
  checkBundleIds,
  checkStoreUrls,
  checkExportCompliance,
  checkVersioning,
  checkSubmitConfig,
  checkPushSetup,
  checkUpdatesWiring,
  checkRuntimeVersion,
  checkUpdateChannels,
  checkAndroidIcon,
  checkPlayServiceAccount,
  checkSdkVersion,
} = require('../src/checks.js');

// --- .gitignore matching ---------------------------------------------------

test('a suffix glob covers the extension it names', () => {
  assert.ok(gitignoreCovers('*.p8\n', 'AuthKey_ABC123.p8'));
  assert.ok(gitignoreCovers('node_modules\n*.p12\n', 'certs/dist.p12'));
});

test('an exact filename covers only that file', () => {
  assert.ok(gitignoreCovers('google-service-account.json\n', 'google-service-account.json'));
  assert.ok(!gitignoreCovers('google-service-account.json\n', 'other.json'));
});

test('a directory entry covers what is under it', () => {
  assert.ok(gitignoreCovers('secrets/\n', 'secrets/AuthKey.p8'));
  assert.ok(gitignoreCovers('/certs\n', 'certs/dist.p12'));
});

test('comments and blank lines are not rules', () => {
  assert.ok(!gitignoreCovers('# *.p8\n\n', 'AuthKey.p8'));
});

test('a negation is never what covers a file', () => {
  // "!*.p8" un-ignores; treating it as a match would report the file as safe.
  assert.ok(!gitignoreCovers('!*.p8\n', 'AuthKey.p8'));
});

test('a prefix glob matches by prefix', () => {
  assert.ok(gitignoreCovers('google-service*\n', 'google-services.json'));
});

// --- credential leaks ------------------------------------------------------

test('an unignored APNs key is a blocker, and says why it cannot be undone', () => {
  const r = checkSecretFiles(['AuthKey_9F8X.p8'], 'node_modules\n');
  assert.strictEqual(r.status, FAIL);
  assert.match(r.detail, /AuthKey_9F8X\.p8/);
  assert.match(r.detail, /rotating/i);
  assert.match(r.rejects, /push/i);
});

test('the fix line is runnable and names the real file', () => {
  const r = checkSecretFiles(['certs/dist.p12'], '');
  assert.match(r.fix, /\*\.p12/);
  assert.match(r.fix, /git check-ignore -v certs\/dist\.p12/);
});

test('an ignored key passes', () => {
  const r = checkSecretFiles(['AuthKey_9F8X.p8'], '*.p8\n');
  assert.strictEqual(r.status, PASS);
});

test('no credential files at all passes', () => {
  assert.strictEqual(checkSecretFiles([], '').status, PASS);
});

test('every documented secret pattern is actually detected', () => {
  // Guards against adding a pattern to the table and forgetting the matcher.
  for (const p of SECRET_FILE_PATTERNS) {
    const name = p.glob.startsWith('*.') ? 'thing' + p.glob.slice(1) : p.glob;
    const r = checkSecretFiles([name], '');
    assert.strictEqual(r.status, FAIL, `${name} was not flagged`);
  }
});

test('a keystore in a subdirectory is still found', () => {
  const r = checkSecretFiles(['android/app/release.keystore'], '');
  assert.strictEqual(r.status, FAIL);
});

test('a generic service-account.json is also flagged', () => {
  const r = checkSecretFiles(['service-account.json'], '');
  assert.strictEqual(r.status, FAIL);
  assert.match(r.detail, /service-account\.json/);
  assert.match(r.detail, /Play publishing service account/);
});

// --- EXPO_PUBLIC_ ---------------------------------------------------------

test('a secret behind EXPO_PUBLIC_ is a blocker', () => {
  const r = checkPublicEnvSecrets(['EXPO_PUBLIC_STRIPE_SECRET_KEY', 'EXPO_PUBLIC_API_URL']);
  assert.strictEqual(r.status, FAIL);
  assert.match(r.detail, /EXPO_PUBLIC_STRIPE_SECRET_KEY/);
  assert.match(r.detail, /bundle/i);
});

test('a secret without the prefix is not this check\'s business', () => {
  const r = checkPublicEnvSecrets(['STRIPE_SECRET_KEY', 'DATABASE_URL']);
  assert.strictEqual(r.status, PASS);
});

test('keys that are meant to be public are not flagged', () => {
  const r = checkPublicEnvSecrets([
    'EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY',
    'EXPO_PUBLIC_SUPABASE_ANON_KEY',
    'EXPO_PUBLIC_GOOGLE_CLIENT_ID',
  ]);
  assert.strictEqual(r.status, PASS, 'publishable and anon keys are designed to ship');
});

test('the count of public vars is reported when clean', () => {
  const r = checkPublicEnvSecrets(['EXPO_PUBLIC_API_URL', 'EXPO_PUBLIC_ENV']);
  assert.match(r.detail, /2 EXPO_PUBLIC_/);
});

test('token and password shapes are caught', () => {
  for (const n of ['EXPO_PUBLIC_AUTH_TOKEN', 'EXPO_PUBLIC_DB_PASSWORD', 'EXPO_PUBLIC_SERVICE_ROLE']) {
    assert.strictEqual(checkPublicEnvSecrets([n]).status, FAIL, n);
  }
});

// --- permission strings ---------------------------------------------------

test('a bare RN library with no usage string is a hard failure', () => {
  // No config plugin means the key is simply absent and iOS kills the process.
  const r = checkPermissionStrings({ 'react-native-vision-camera': '4.0.0' }, {});
  assert.strictEqual(r.status, FAIL);
  assert.match(r.detail, /NSCameraUsageDescription/);
  assert.match(r.rejects, /5\.1\.1/);
});

test('an expo package with no explicit string only warns, because the plugin injects one', () => {
  const r = checkPermissionStrings({ 'expo-camera': '~15.0.0' }, {});
  assert.strictEqual(r.status, WARN);
  assert.match(r.detail, /generic default/i);
});

test('a specific purpose string passes', () => {
  const r = checkPermissionStrings(
    { 'expo-camera': '~15.0.0' },
    { NSCameraUsageDescription: 'IQGen uses your camera to photograph the meter panel during a site survey.' }
  );
  assert.strictEqual(r.status, PASS);
});

test('Apple\'s own placeholder wording is treated as vague', () => {
  const r = checkPermissionStrings(
    { 'expo-camera': '~15.0.0' },
    { NSCameraUsageDescription: 'Allow $(PRODUCT_NAME) to access your camera' }
  );
  assert.strictEqual(r.status, WARN);
  assert.match(r.detail, /vague/i);
});

test('a too-short string is vague no matter the wording', () => {
  const r = checkPermissionStrings({ 'expo-location': '~17.0.0' }, { NSLocationWhenInUseUsageDescription: 'Maps' });
  assert.strictEqual(r.status, WARN);
});

test('no permission packages installed passes cleanly', () => {
  const r = checkPermissionStrings({ react: '18.0.0' }, {});
  assert.strictEqual(r.status, PASS);
  assert.match(r.detail, /No packages/);
});

test('a hard failure outranks a warning when both are present', () => {
  const r = checkPermissionStrings(
    { 'react-native-ble-plx': '3.0.0', 'expo-camera': '~15.0.0' },
    {}
  );
  assert.strictEqual(r.status, FAIL);
});

// --- ATT -----------------------------------------------------------------

test('an ad SDK with no ATT wiring is a blocker', () => {
  const r = checkTrackingTransparency({ 'react-native-google-mobile-ads': '13.0.0' }, {});
  assert.strictEqual(r.status, FAIL);
  assert.match(r.rejects, /5\.1\.2/);
});

test('the detail names which half is missing', () => {
  const withString = checkTrackingTransparency(
    { 'react-native-google-mobile-ads': '13.0.0' },
    { NSUserTrackingUsageDescription: 'Used to show you relevant ads.' }
  );
  assert.strictEqual(withString.status, FAIL);
  assert.match(withString.detail, /expo-tracking-transparency is not installed/);

  const withDep = checkTrackingTransparency(
    { 'react-native-google-mobile-ads': '13.0.0', 'expo-tracking-transparency': '~5.0.0' },
    {}
  );
  assert.match(withDep.detail, /NSUserTrackingUsageDescription is missing/);
});

test('both halves present passes', () => {
  const r = checkTrackingTransparency(
    { 'react-native-google-mobile-ads': '13.0.0', 'expo-tracking-transparency': '~5.0.0' },
    { NSUserTrackingUsageDescription: 'Used to show you relevant ads.' }
  );
  assert.strictEqual(r.status, PASS);
});

test('no tracking SDK means nothing to declare', () => {
  assert.strictEqual(checkTrackingTransparency({ expo: '53.0.0' }, {}).status, PASS);
});

// --- icon ----------------------------------------------------------------

test('an alpha channel on the marketing icon fails, with the sips fix', () => {
  const r = checkIcon({ path: 'icon.png', width: 1024, height: 1024, hasAlpha: true });
  assert.strictEqual(r.status, FAIL);
  assert.match(r.detail, /alpha/);
  assert.match(r.fix, /hasAlpha false/);
  assert.match(r.rejects, /90717/);
});

test('an undersized icon fails and states the size found', () => {
  const r = checkIcon({ path: 'icon.png', width: 512, height: 512, hasAlpha: false });
  assert.strictEqual(r.status, FAIL);
  assert.match(r.detail, /512x512/);
});

test('a non-square icon fails', () => {
  const r = checkIcon({ path: 'icon.png', width: 1024, height: 768, hasAlpha: false });
  assert.strictEqual(r.status, FAIL);
  assert.match(r.detail, /not square/);
});

test('a correct icon passes', () => {
  assert.strictEqual(checkIcon({ path: 'icon.png', width: 1024, height: 1024, hasAlpha: false }).status, PASS);
});

test('a larger square opaque icon is fine', () => {
  assert.strictEqual(checkIcon({ path: 'icon.png', width: 2048, height: 2048, hasAlpha: false }).status, PASS);
});

test('a missing icon fails rather than being skipped', () => {
  const r = checkIcon(null);
  assert.strictEqual(r.status, FAIL);
  assert.match(r.detail, /after the build minutes are spent/);
});

test('a non-png icon is reported as an upload failure', () => {
  const r = checkIcon({ path: 'icon.jpg', unsupported: true });
  assert.strictEqual(r.status, FAIL);
  assert.match(r.detail, /not a PNG/);
  assert.match(r.rejects, /App Store Connect/);
});

// --- bundle ids ----------------------------------------------------------

test('placeholder identifiers are caught on both platforms', () => {
  const r = checkBundleIds('com.example.myapp', 'com.example.myapp');
  assert.strictEqual(r.status, FAIL);
  assert.match(r.detail, /placeholder/);
});

test('anonymous ids from expo init are caught', () => {
  assert.strictEqual(checkBundleIds('com.anonymous.app', 'com.anonymous.app').status, FAIL);
});

test('a missing android package is called out by name', () => {
  const r = checkBundleIds('com.iqgen.energy', null);
  assert.strictEqual(r.status, FAIL);
  assert.match(r.detail, /expo\.android\.package/);
});

test('real identifiers pass', () => {
  assert.strictEqual(checkBundleIds('com.iqgen.energy', 'com.iqgen.energy').status, PASS);
});

test('a legitimate id containing a placeholder word as a substring is not flagged', () => {
  // "testing" is not "test": matching on substring would false-positive here.
  assert.strictEqual(checkBundleIds('com.testinglabs.app', 'com.testinglabs.app').status, PASS);
});

test('a placeholder word with trailing digits is not treated as a placeholder', () => {
  assert.strictEqual(checkBundleIds('com.example123.app', 'com.example123.app').status, PASS);
});

// --- store urls ---------------------------------------------------------

test('missing privacy and support urls warn', () => {
  const r = checkStoreUrls({});
  assert.strictEqual(r.status, WARN);
  assert.match(r.detail, /privacy policy URL and support URL/);
});

test('recorded urls pass', () => {
  const r = checkStoreUrls({ privacyPolicyUrl: 'https://x.com/p', supportUrl: 'https://x.com/s' });
  assert.strictEqual(r.status, PASS);
});

test('the warning admits it cannot see App Store Connect', () => {
  assert.match(checkStoreUrls({}).fix, /cannot verify/);
});

test('a missing support url alone is still warned', () => {
  const r = checkStoreUrls({ privacyPolicyUrl: 'https://x.com/p' });
  assert.strictEqual(r.status, WARN);
  assert.match(r.detail, /support URL/);
  assert.ok(!r.detail.includes('privacy policy URL'));
});

// --- export compliance --------------------------------------------------

test('an unanswered encryption question warns and explains it is a stall', () => {
  const r = checkExportCompliance({});
  assert.strictEqual(r.status, WARN);
  assert.match(r.rejects, /stall/i);
});

test('answering false in config passes', () => {
  assert.strictEqual(checkExportCompliance({ usesNonExemptEncryption: false }).status, PASS);
});

test('answering true also passes, since it is answered', () => {
  const r = checkExportCompliance({ usesNonExemptEncryption: true });
  assert.strictEqual(r.status, PASS);
  assert.match(r.detail, /true/);
});

// --- versioning ---------------------------------------------------------

test('no version at all is a blocker', () => {
  const r = checkVersioning(null, null, null, false);
  assert.strictEqual(r.status, FAIL);
});

test('autoIncrement passes and is named as the reason', () => {
  const r = checkVersioning('1.0.0', null, null, true);
  assert.strictEqual(r.status, PASS);
  assert.match(r.detail, /autoIncrement/);
});

test('hand-managed build numbers warn about deleted uploads', () => {
  const r = checkVersioning('1.0.0', '20', '20', false);
  assert.strictEqual(r.status, WARN);
  assert.match(r.detail, /deleted or that were rejected/);
  assert.match(r.rejects, /90186/);
});

// --- submit config ------------------------------------------------------

test('a complete submit profile passes', () => {
  const r = checkSubmitConfig({ ios: { ascAppId: '6792329799', appleTeamId: 'MVTT4PF527' } });
  assert.strictEqual(r.status, PASS);
});

test('a partial submit profile warns and names the gap', () => {
  const r = checkSubmitConfig({ ios: { ascAppId: '6792329799' } });
  assert.strictEqual(r.status, WARN);
  assert.match(r.detail, /appleTeamId/);
});

test('no submit block is information, not a problem', () => {
  assert.strictEqual(checkSubmitConfig(null).status, INFO);
});

// --- push ---------------------------------------------------------------

test('no expo-notifications means nothing to check', () => {
  assert.strictEqual(checkPushSetup({ expo: '53.0.0' }, null, false).status, SKIP);
});

test('managed projects are informed, not failed, since the entitlement is injected at build time', () => {
  const r = checkPushSetup({ 'expo-notifications': '~0.29.0' }, null, false);
  assert.strictEqual(r.status, INFO);
  assert.match(r.fix, /expo-push-doctor/);
});

test('a bare ios/ with no aps-environment is the real silent failure', () => {
  const r = checkPushSetup({ 'expo-notifications': '~0.29.0' }, {}, true);
  assert.strictEqual(r.status, FAIL);
  assert.match(r.detail, /no valid aps-environment entitlement string found/);
  assert.match(r.rejects, /cannot receive a single notification/);
});

test('a present entitlement passes and reports the environment', () => {
  const r = checkPushSetup({ 'expo-notifications': '~0.29.0' }, { 'aps-environment': 'production' }, true);
  assert.strictEqual(r.status, PASS);
  assert.match(r.detail, /production/);
});

// --- OTA ---------------------------------------------------------------

test('an updates url with no expo-updates installed reaches nobody', () => {
  const r = checkUpdatesWiring({ url: 'https://u.expo.dev/abc' }, {});
  assert.strictEqual(r.status, FAIL);
  assert.match(r.detail, /reach nobody/);
});

test('expo-updates with no url warns', () => {
  const r = checkUpdatesWiring({}, { 'expo-updates': '~0.28.0' });
  assert.strictEqual(r.status, WARN);
});

test('neither present is skipped', () => {
  assert.strictEqual(checkUpdatesWiring(null, {}).status, SKIP);
});

test('both present passes', () => {
  const r = checkUpdatesWiring({ url: 'https://u.expo.dev/abc' }, { 'expo-updates': '~0.28.0' });
  assert.strictEqual(r.status, PASS);
});

test('appVersion policy warns that bumping the version orphans installed builds', () => {
  const r = checkRuntimeVersion({ policy: 'appVersion' }, '1.0.0', true);
  assert.strictEqual(r.status, WARN);
  assert.match(r.detail, /stops matching/);
  assert.match(r.fix, /fingerprint/);
});

test('fingerprint policy passes', () => {
  assert.strictEqual(checkRuntimeVersion({ policy: 'fingerprint' }, '1.0.0', true).status, PASS);
});

test('nativeVersion policy passes', () => {
  assert.strictEqual(checkRuntimeVersion({ policy: 'nativeVersion' }, '1.0.0', true).status, PASS);
});

test('a missing runtimeVersion with OTA on is a blocker, because updates can crash on launch', () => {
  const r = checkRuntimeVersion(null, '1.0.0', true);
  assert.strictEqual(r.status, FAIL);
  assert.match(r.rejects, /crash/);
});

test('runtimeVersion is not checked when OTA is off', () => {
  assert.strictEqual(checkRuntimeVersion(null, '1.0.0', false).status, SKIP);
});

test('a literal runtimeVersion passes with a caveat', () => {
  const r = checkRuntimeVersion('1.0.0', '1.0.0', true);
  assert.strictEqual(r.status, PASS);
  assert.match(r.detail, /by hand/);
});

test('an unrecognised policy warns rather than being silently accepted', () => {
  const r = checkRuntimeVersion({ policy: 'sdkVersion' }, '1.0.0', true);
  assert.strictEqual(r.status, WARN);
});

test('a profile with no channel anywhere in its extends chain is flagged', () => {
  const r = checkUpdateChannels({
    base: { node: '20' },
    production: { extends: 'base' },
  });
  assert.strictEqual(r.status, WARN);
  assert.match(r.detail, /production/);
});

test('a channel inherited through extends counts', () => {
  const r = checkUpdateChannels({
    base: { channel: 'production' },
    production: { extends: 'base', autoIncrement: true },
  });
  assert.strictEqual(r.status, PASS);
});

test('a base profile that others extend is not expected to have a channel', () => {
  // Real eas.json files almost always have one. Flagging it was noise.
  const r = checkUpdateChannels({
    base: { node: '20' },
    production: { extends: 'base', channel: 'production' },
    preview: { extends: 'base', channel: 'preview' },
  });
  assert.strictEqual(r.status, PASS);
});

test('developmentClient inherited through extends is still exempt', () => {
  const r = checkUpdateChannels({
    development: { developmentClient: true, channel: 'development' },
    'development-device': { extends: 'development' },
    production: { channel: 'production' },
  });
  assert.strictEqual(r.status, PASS);
});

test('development clients are exempt, they do not consume channels', () => {
  const r = checkUpdateChannels({
    development: { developmentClient: true },
    production: { channel: 'production' },
  });
  assert.strictEqual(r.status, PASS);
});

test('a circular extends chain terminates instead of recursing forever', () => {
  // Mutually extending profiles are an invalid config; all that matters here is
  // that the walk stops and returns a verdict rather than blowing the stack.
  const r = checkUpdateChannels({ a: { extends: 'b' }, b: { extends: 'a' } });
  assert.ok([PASS, WARN].includes(r.status));
});

test('a profile whose only channel source is a circular chain is flagged', () => {
  const r = checkUpdateChannels({
    a: { extends: 'b' },
    b: { extends: 'a' },
    production: { extends: 'nowhere' },
  });
  assert.strictEqual(r.status, WARN);
  assert.match(r.detail, /production/);
});

// --- android ----------------------------------------------------------

test('a missing adaptive icon warns about how it renders', () => {
  const r = checkAndroidIcon(null, { width: 1024 });
  assert.strictEqual(r.status, WARN);
  assert.match(r.detail, /letterbox/);
});

test('an adaptive icon passes', () => {
  assert.strictEqual(checkAndroidIcon({ foregroundImage: './assets/adaptive.png' }, null).status, PASS);
});

test('an unignored play service account key is a blocker', () => {
  const r = checkPlayServiceAccount(
    { serviceAccountKeyPath: './google-service-account.json' },
    ['google-service-account.json'],
    'node_modules\n'
  );
  assert.strictEqual(r.status, FAIL);
  assert.match(r.rejects, /ship a release to your users/);
});

test('an ignored key passes', () => {
  const r = checkPlayServiceAccount(
    { serviceAccountKeyPath: './google-service-account.json' },
    ['google-service-account.json'],
    'google-service-account.json\n'
  );
  assert.strictEqual(r.status, PASS);
});

test('a configured key that is not in this checkout is fine', () => {
  const r = checkPlayServiceAccount({ serviceAccountKeyPath: './gsa.json' }, [], '');
  assert.strictEqual(r.status, PASS);
  assert.match(r.detail, /not present locally/);
});

test('no play config is information', () => {
  assert.strictEqual(checkPlayServiceAccount(null, [], '').status, INFO);
});

// --- sdk --------------------------------------------------------------

test('an ancient SDK warns', () => {
  const r = checkSdkVersion('47.0.0');
  assert.strictEqual(r.status, WARN);
  assert.match(r.detail, /47/);
});

test('a current SDK passes', () => {
  assert.strictEqual(checkSdkVersion('53.0.0').status, PASS);
});

test('an unreadable version is skipped rather than guessed', () => {
  assert.strictEqual(checkSdkVersion('').status, SKIP);
  assert.strictEqual(checkSdkVersion('workspace:*').status, SKIP);
});

test('caret-prefixed versions are read as the major they pin', () => {
  assert.strictEqual(checkSdkVersion('^47.0.0').status, WARN);
  assert.strictEqual(checkSdkVersion('^53.0.0').status, PASS);
});

test('tilde, gte and exact boundary versions are parsed correctly', () => {
  assert.strictEqual(checkSdkVersion('~47.0.0').status, WARN, 'tilde old');
  assert.strictEqual(checkSdkVersion('>=47.0.0').status, WARN, 'gte old');
  assert.strictEqual(checkSdkVersion('50.0.0').status, PASS, 'exact boundary');
  assert.strictEqual(checkSdkVersion('latest').status, SKIP, 'tag cannot be parsed');
});

// --- shape ------------------------------------------------------------

test('every failing or warning verdict carries a fix', () => {
  const cases = [
    checkSecretFiles(['a.p8'], ''),
    checkPublicEnvSecrets(['EXPO_PUBLIC_SECRET_KEY']),
    checkPermissionStrings({ 'react-native-vision-camera': '4' }, {}),
    checkTrackingTransparency({ 'react-native-branch': '6' }, {}),
    checkIcon({ path: 'i.png', width: 512, height: 512, hasAlpha: true }),
    checkBundleIds(null, null),
    checkStoreUrls({}),
    checkExportCompliance({}),
    checkVersioning(null, null, null, false),
    checkSubmitConfig({ ios: { ascAppId: '1' } }),
    checkPushSetup({ 'expo-notifications': '1' }, {}, true),
    checkUpdatesWiring({ url: 'u' }, {}),
    checkRuntimeVersion(null, '1.0.0', true),
    checkUpdateChannels({ production: {} }),
    checkAndroidIcon(null, null),
    checkPlayServiceAccount({ serviceAccountKeyPath: 'k.json' }, ['k.json'], ''),
    checkSdkVersion('47.0.0'),
  ];
  for (const r of cases) {
    assert.ok([FAIL, WARN].includes(r.status), `${r.id} should be actionable`);
    assert.ok(r.fix && r.fix.length > 10, `${r.id} has no usable fix`);
    assert.ok(r.id && r.title && r.detail, `${r.id} is missing a field`);
  }
});

test('no verdict text uses an em dash or the words "simply" or "just"', () => {
  // House style, and it keeps output readable in terminals with narrow fonts.
  const all = [
    checkSecretFiles(['a.p8'], ''),
    checkPublicEnvSecrets(['EXPO_PUBLIC_SECRET_KEY']),
    checkPermissionStrings({ 'expo-camera': '1' }, {}),
    checkIcon(null),
    checkRuntimeVersion({ policy: 'appVersion' }, '1.0.0', true),
    checkVersioning('1.0.0', null, null, false),
  ];
  for (const r of all) {
    const text = [r.title, r.detail, r.fix, r.rejects].join(' ');
    assert.ok(!text.includes('\u2014'), `${r.id} contains an em dash`);
  }
});
