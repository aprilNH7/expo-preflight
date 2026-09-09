'use strict';

// Every check in here is a pure function. It takes plain data that bin/cli.js
// has already read off disk and returns a verdict. Nothing in this file touches
// the filesystem, the network, or process.env, which is why the test suite can
// drive all of it directly without fixture directories.
//
// A verdict is:
//   { id, title, status, detail, fix, rejects }
//
// `rejects` is the part that matters. A linter that says "consider adding a
// privacy policy" gets ignored. One that says "Guideline 5.1.1 - Data
// Collection and Storage, and this is the single most common rejection reason"
// gets acted on. Every check names the concrete failure it prevents, whether
// that is an App Store review rejection, a Play Console upload error, or a
// build that succeeds and then cannot do the thing you built it for.

const FAIL = 'fail';
const WARN = 'warn';
const PASS = 'pass';
const INFO = 'info';
const SKIP = 'skip';

const v = (id, title, status, detail, fix, rejects) => ({
  id,
  title,
  status,
  detail,
  fix: fix || '',
  rejects: rejects || '',
});

// ---------------------------------------------------------------------------
// Credential leaks
// ---------------------------------------------------------------------------

// Files that hand over your signing identity or a Play publishing account if
// they ever reach a public remote. p8 is the one people underestimate: a single
// leaked APNs auth key can push notifications to every install of your app,
// it is valid for every app under the team, and Apple does not let you see the
// key again to compare, only revoke.
const SECRET_FILE_PATTERNS = [
  { glob: '*.p8', what: 'an APNs or App Store Connect API auth key' },
  { glob: '*.p12', what: 'an exported signing certificate with its private key' },
  { glob: '*.mobileprovision', what: 'a provisioning profile' },
  { glob: '*.keystore', what: 'an Android signing keystore' },
  { glob: '*.jks', what: 'an Android signing keystore' },
  { glob: 'google-service-account.json', what: 'a Play publishing service account' },
  { glob: 'google-services.json', what: 'Firebase client config' },
  { glob: 'GoogleService-Info.plist', what: 'Firebase client config' },
];

// .gitignore matching, reduced to what actually shows up in these files.
// Deliberately not a full gitwildmatch implementation: a leading directory or
// a trailing slash means we treat the entry as covering everything under it,
// and `*.p8` style suffix globs are matched on extension.
function gitignoreCovers(gitignore, filename) {
  const lines = String(gitignore || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const base = filename.replace(/^.*\//, '');

  for (const raw of lines) {
    if (raw.startsWith('!')) continue; // a negation cannot be what covers us
    const line = raw.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!line) continue;
    if (line === filename || line === base) return true;
    if (line.startsWith('*.') && base.endsWith(line.slice(1))) return true;
    if (line.endsWith('*') && base.startsWith(line.slice(0, -1))) return true;
    // A bare directory entry covers anything beneath it.
    if (filename.startsWith(line + '/')) return true;
  }
  return false;
}

// presentFiles: filenames (repo-relative) that exist and are NOT already
// ignored by git. The caller is responsible for that filtering, because only
// git knows the full ignore chain including global excludes.
function checkSecretFiles(presentFiles, gitignore) {
  const exposed = [];
  for (const f of presentFiles || []) {
    const base = f.replace(/^.*\//, '');
    const rule = SECRET_FILE_PATTERNS.find((p) =>
      p.glob.startsWith('*.') ? base.endsWith(p.glob.slice(1)) : base === p.glob
    );
    if (rule && !gitignoreCovers(gitignore, f)) exposed.push({ file: f, what: rule.what });
  }

  if (!exposed.length) {
    return v(
      'secret-files',
      'Signing credentials are not committable',
      PASS,
      'No signing keys, keystores, provisioning profiles or service account files are sitting untracked-but-unignored in the project.'
    );
  }

  const list = exposed.map((e) => `${e.file} (${e.what})`).join(', ');
  return v(
    'secret-files',
    'Signing credentials can be committed',
    FAIL,
    `These exist in the project and .gitignore does not cover them: ${list}. One "git add ." and they are in your history, and on a public repo that is unrecoverable: rotating is the only fix, rewriting history is not enough because forks and caches keep the blob.`,
    `Add to .gitignore: ${exposed.map((e) => '*' + (e.file.includes('.') ? e.file.slice(e.file.lastIndexOf('.')) : e.file)).filter((x, i, a) => a.indexOf(x) === i).join(' ')}, then confirm with: git check-ignore -v ${exposed[0].file}`,
    'A leaked .p8 lets anyone send push to every install of your app, under any app in your team.'
  );
}

// EXPO_PUBLIC_ is not a suggestion about intent. Expo inlines every variable
// with that prefix into the JavaScript bundle at build time, and the bundle
// ships inside the IPA and APK. Anyone can unzip either one.
const SECRET_NAME_RE = /(SECRET|PRIVATE|PASSWORD|PASSWD|CREDENTIAL|_TOKEN|TOKEN_|APIKEY|API_KEY|_KEY$|ACCESS_KEY|SERVICE_ROLE|WEBHOOK)/i;

// Names that match the pattern above but are legitimately public.
const PUBLIC_KEY_ALLOWLIST = /(PUBLISHABLE|PUBLIC_KEY$|_PUBLIC$|ANON_KEY|CLIENT_ID)/i;

function checkPublicEnvSecrets(envNames) {
  const suspect = (envNames || [])
    .filter((n) => n.startsWith('EXPO_PUBLIC_'))
    .filter((n) => SECRET_NAME_RE.test(n) && !PUBLIC_KEY_ALLOWLIST.test(n));

  if (!suspect.length) {
    const total = (envNames || []).filter((n) => n.startsWith('EXPO_PUBLIC_')).length;
    return v(
      'public-env-secrets',
      'No secrets are prefixed EXPO_PUBLIC_',
      PASS,
      total
        ? `${total} EXPO_PUBLIC_ variable(s) found, none of them named like a secret.`
        : 'No EXPO_PUBLIC_ variables are declared.'
    );
  }

  return v(
    'public-env-secrets',
    'A secret is prefixed EXPO_PUBLIC_',
    FAIL,
    `${suspect.join(', ')}. The EXPO_PUBLIC_ prefix inlines the value into the JS bundle at build time. The bundle ships inside your IPA and APK, so this is published, not configured. Unzipping a store build and grepping it takes about a minute.`,
    'Drop the EXPO_PUBLIC_ prefix and read it server-side, or move it to an EAS secret and never reference it from client code: eas secret:create --name MY_SECRET --value ...',
    'Not a rejection. Worse: it ships, works, and is readable by anyone who downloads your app.'
  );
}

// ---------------------------------------------------------------------------
// Things Apple rejects outright
// ---------------------------------------------------------------------------

// dep -> the Info.plist strings iOS requires before the API will even prompt.
// `auto` means the package ships an Expo config plugin that injects a generic
// default, so a missing entry is a warning rather than a hard failure: you will
// get a build, and then a reviewer reading "Allow $(PRODUCT_NAME) to use your
// camera" who cannot tell why your app needs it.
const PERMISSION_DEPS = [
  { dep: 'expo-camera', keys: ['NSCameraUsageDescription'], auto: true },
  { dep: 'expo-image-picker', keys: ['NSPhotoLibraryUsageDescription'], auto: true },
  { dep: 'expo-media-library', keys: ['NSPhotoLibraryUsageDescription'], auto: true },
  { dep: 'expo-location', keys: ['NSLocationWhenInUseUsageDescription'], auto: true },
  { dep: 'expo-contacts', keys: ['NSContactsUsageDescription'], auto: true },
  { dep: 'expo-calendar', keys: ['NSCalendarsUsageDescription'], auto: true },
  { dep: 'expo-local-authentication', keys: ['NSFaceIDUsageDescription'], auto: true },
  { dep: 'expo-av', keys: ['NSMicrophoneUsageDescription'], auto: true },
  { dep: 'expo-audio', keys: ['NSMicrophoneUsageDescription'], auto: true },
  { dep: 'expo-speech-recognition', keys: ['NSSpeechRecognitionUsageDescription'], auto: true },
  { dep: 'expo-sensors', keys: ['NSMotionUsageDescription'], auto: true },
  { dep: 'react-native-vision-camera', keys: ['NSCameraUsageDescription'], auto: false },
  { dep: 'react-native-ble-plx', keys: ['NSBluetoothAlwaysUsageDescription'], auto: false },
  { dep: '@react-native-community/geolocation', keys: ['NSLocationWhenInUseUsageDescription'], auto: false },
  { dep: 'react-native-health', keys: ['NSHealthShareUsageDescription'], auto: false },
];

// Generic strings that satisfy the build but read as boilerplate to a reviewer.
const VAGUE_PURPOSE_RE = /^(allow\s+\$\(PRODUCT_NAME\)|this app (needs|requires|uses)|we need|for better experience|app needs access)/i;

function checkPermissionStrings(deps, infoPlist) {
  const plist = infoPlist || {};
  const missingHard = [];
  const missingSoft = [];
  const vague = [];

  for (const entry of PERMISSION_DEPS) {
    if (!deps || !deps[entry.dep]) continue;
    for (const key of entry.keys) {
      const val = plist[key];
      if (!val || !String(val).trim()) {
        (entry.auto ? missingSoft : missingHard).push(`${key} (needed by ${entry.dep})`);
      } else if (VAGUE_PURPOSE_RE.test(String(val).trim()) || String(val).trim().length < 15) {
        vague.push(`${key}: "${val}"`);
      }
    }
  }

  if (!missingHard.length && !missingSoft.length && !vague.length) {
    const covered = PERMISSION_DEPS.filter((e) => deps && deps[e.dep]).length;
    return v(
      'permission-strings',
      'Permission purpose strings are present and specific',
      PASS,
      covered
        ? `${covered} permission-requesting package(s) found, each with a usage description that says something.`
        : 'No packages that request an iOS permission are installed.'
    );
  }

  if (missingHard.length) {
    return v(
      'permission-strings',
      'A required permission purpose string is missing',
      FAIL,
      `Missing: ${missingHard.join(', ')}. These packages have no Expo config plugin to inject a default, so the key will be absent from Info.plist. iOS does not show a prompt at all when the string is missing, it kills the process, and App Review checks for the strings directly.`,
      'Add them under expo.ios.infoPlist in your app config, each explaining the concrete user-facing feature that needs it.',
      'Guideline 5.1.1 - Data Collection and Storage. The most frequently cited rejection reason there is.'
    );
  }

  const parts = [];
  if (missingSoft.length) parts.push(`Not set explicitly: ${missingSoft.join(', ')}`);
  if (vague.length) parts.push(`Too vague to pass review: ${vague.join('; ')}`);

  return v(
    'permission-strings',
    'Permission purpose strings are weak',
    WARN,
    `${parts.join('. ')}. The Expo config plugin will inject a generic default so the build succeeds, which is exactly why this gets missed until review. A reviewer who cannot tell why you need the camera rejects it.`,
    'Set each string under expo.ios.infoPlist and name the feature: "IQGen uses your camera to photograph the meter panel during a site survey" rather than "This app needs camera access".',
    'Guideline 5.1.1 - purpose strings that do not explain the use.'
  );
}

const TRACKING_DEPS = [
  'react-native-google-mobile-ads',
  'expo-ads-admob',
  '@react-native-firebase/analytics',
  'react-native-appsflyer',
  'react-native-branch',
  '@amplitude/analytics-react-native',
  'react-native-fbsdk-next',
];

function checkTrackingTransparency(deps, infoPlist) {
  const found = TRACKING_DEPS.filter((d) => deps && deps[d]);
  if (!found.length) {
    return v(
      'tracking-transparency',
      'No cross-app tracking SDKs to declare',
      PASS,
      'No ad or attribution SDK that triggers App Tracking Transparency is installed.'
    );
  }
  const hasString = infoPlist && infoPlist.NSUserTrackingUsageDescription;
  const hasDep = deps && deps['expo-tracking-transparency'];

  if (hasString && hasDep) {
    return v(
      'tracking-transparency',
      'App Tracking Transparency is wired up',
      PASS,
      `${found.join(', ')} present, with both NSUserTrackingUsageDescription and expo-tracking-transparency.`
    );
  }
  return v(
    'tracking-transparency',
    'Tracking SDK without an ATT prompt',
    FAIL,
    `${found.join(', ')} can access the IDFA, but ${
      !hasString && !hasDep
        ? 'neither NSUserTrackingUsageDescription nor expo-tracking-transparency is set up'
        : !hasString
        ? 'NSUserTrackingUsageDescription is missing'
        : 'expo-tracking-transparency is not installed, so nothing ever calls requestTrackingPermissionsAsync()'
    }. Apple tests this by watching whether the prompt appears before any tracking call.`,
    'npx expo install expo-tracking-transparency, add NSUserTrackingUsageDescription under expo.ios.infoPlist, and await requestTrackingPermissionsAsync() before initialising the SDK.',
    'Guideline 5.1.2 - Data Use and Sharing. Rejected, and repeat offences risk the developer account.'
  );
}

// PNG colour types 4 and 6 carry an alpha channel, and a tRNS chunk adds
// transparency to types 0/2/3. Apple rejects the 1024 marketing icon for any
// of them at upload time, which is a 20 minute build you do not get back.
function checkIcon(iconInfo) {
  if (!iconInfo) {
    return v(
      'icon',
      'App icon not found',
      FAIL,
      'No icon could be read from the path in your app config. A missing or unreadable icon fails at upload, not at build, so you find out after the build minutes are spent.',
      'Set expo.icon to a 1024x1024 PNG with no alpha channel.',
      'Rejected by App Store Connect on upload before review even starts.'
    );
  }
  if (iconInfo.unsupported) {
    return v(
      'icon',
      'App icon is not a valid PNG',
      FAIL,
      `${iconInfo.path}: the file at that path is not a PNG. App Store Connect only accepts a 1024x1024 PNG as the marketing icon, and an invalid image fails at upload rather than at build.`,
      'Convert your icon to a 1024x1024 PNG with no alpha channel.',
      'Rejected by App Store Connect on upload before review even starts.'
    );
  }
  const problems = [];
  if (iconInfo.width !== iconInfo.height) problems.push(`it is ${iconInfo.width}x${iconInfo.height}, not square`);
  else if (iconInfo.width < 1024) problems.push(`it is ${iconInfo.width}x${iconInfo.width}, below the required 1024x1024`);
  if (iconInfo.hasAlpha) problems.push('it has an alpha channel, which Apple rejects on the marketing icon');

  if (!problems.length) {
    return v(
      'icon',
      'App icon meets Apple requirements',
      PASS,
      `${iconInfo.width}x${iconInfo.height}, opaque, no alpha channel.`
    );
  }
  return v(
    'icon',
    'App icon will be rejected at upload',
    FAIL,
    `${iconInfo.path}: ${problems.join(', ')}.`,
    iconInfo.hasAlpha
      ? 'Flatten it onto an opaque background: sips -s format png --setProperty hasAlpha false icon.png, or export from your design tool with transparency off.'
      : 'Export a square 1024x1024 PNG.',
    'ITMS-90717 / invalid large app icon. Fails on upload, so it costs you a whole build cycle.'
  );
}

const PLACEHOLDER_ID_RE = /(^|\.)(example|anonymous|yourcompany|yourname|myapp|test|placeholder|acme)(\.|$)/i;

function checkBundleIds(iosBundleId, androidPackage) {
  const problems = [];
  if (!iosBundleId) problems.push('expo.ios.bundleIdentifier is not set');
  else if (PLACEHOLDER_ID_RE.test(iosBundleId)) problems.push(`iOS bundle id "${iosBundleId}" still looks like a placeholder`);
  if (!androidPackage) problems.push('expo.android.package is not set');
  else if (PLACEHOLDER_ID_RE.test(androidPackage)) problems.push(`Android package "${androidPackage}" still looks like a placeholder`);

  if (!problems.length) {
    return v(
      'bundle-ids',
      'Bundle identifiers are set',
      PASS,
      `iOS ${iosBundleId}, Android ${androidPackage}.`
    );
  }
  return v(
    'bundle-ids',
    'Bundle identifier problem',
    FAIL,
    `${problems.join('; ')}. These are effectively permanent: the identifier is how both stores recognise your app, and neither lets you change it after the first release.`,
    'Set expo.ios.bundleIdentifier and expo.android.package to a reverse-DNS id on a domain you control, before your first upload.',
    'Submission fails outright, or worse, succeeds under an id you are then stuck with forever.'
  );
}

function checkStoreUrls(extra) {
  const e = extra || {};
  const missing = [];
  if (!e.privacyPolicyUrl) missing.push('privacy policy URL');
  if (!e.supportUrl) missing.push('support URL');

  if (!missing.length) {
    return v(
      'store-urls',
      'Privacy policy and support URLs are recorded',
      PASS,
      'Both are noted in your app config, so whoever fills in App Store Connect has them to hand.'
    );
  }
  return v(
    'store-urls',
    'Privacy policy / support URL not recorded',
    WARN,
    `Not found in your app config: ${missing.join(' and ')}. Both are mandatory fields in App Store Connect and Play Console for every app with no exceptions, and the privacy policy has to be a live, reachable page that actually describes what you collect.`,
    'Record them under expo.extra.privacyPolicyUrl and expo.extra.supportUrl so they live in the repo, then paste into App Store Connect. This check cannot verify what you typed into the console.',
    'Guideline 5.1.1(i). A dead or placeholder privacy URL is an instant rejection.'
  );
}

function checkExportCompliance(iosConfig) {
  const cfg = iosConfig || {};
  if (typeof cfg.usesNonExemptEncryption === 'boolean') {
    return v(
      'export-compliance',
      'Export compliance is answered in config',
      PASS,
      `ITSAppUsesNonExemptEncryption is set to ${cfg.usesNonExemptEncryption}, so submissions stop asking.`
    );
  }
  return v(
    'export-compliance',
    'Export compliance will be asked on every submission',
    WARN,
    'expo.ios.config.usesNonExemptEncryption is not set. App Store Connect then blocks each build behind the encryption questionnaire, and because it is a per-build prompt it is easy to leave a build sitting in "Missing Compliance" for days without noticing.',
    'Almost every app is exempt: it only uses HTTPS and the platform crypto. Set expo.ios.config.usesNonExemptEncryption to false to declare that once, in the repo. If you ship your own non-standard cryptography, leave it unset and answer manually.',
    'Not a rejection, a stall. The build cannot be submitted until answered.'
  );
}

// ---------------------------------------------------------------------------
// Build and submit mechanics
// ---------------------------------------------------------------------------

function checkVersioning(version, iosBuildNumber, androidVersionCode, autoIncrement) {
  if (!version) {
    return v(
      'versioning',
      'No app version set',
      FAIL,
      'expo.version is missing. It is the version users see and the one both stores order releases by.',
      'Set expo.version to a semver string such as "1.0.0".',
      'Submission is rejected with a missing CFBundleShortVersionString.'
    );
  }
  if (autoIncrement) {
    return v(
      'versioning',
      'Build numbers auto-increment',
      PASS,
      `Version ${version}, with autoIncrement on the production profile. EAS bumps the build number per build, which is the one thing that reliably prevents duplicate-version upload failures.`
    );
  }
  const have = [];
  if (iosBuildNumber) have.push(`iOS buildNumber ${iosBuildNumber}`);
  if (androidVersionCode) have.push(`Android versionCode ${androidVersionCode}`);

  return v(
    'versioning',
    'Build numbers are managed by hand',
    WARN,
    `Version ${version}${have.length ? ', ' + have.join(', ') : ', with no explicit build number'}, and no autoIncrement in eas.json. Every store upload must carry a build number strictly higher than anything previously uploaded for that version, including builds you deleted or that were rejected. Hand-managing it is the most common reason a resubmission bounces.`,
    'Add "autoIncrement": true to the production profile in eas.json and let EAS own it.',
    'ITMS-90186 / "The bundle version must be higher than the previously uploaded version".'
  );
}

function checkSubmitConfig(submitProfile) {
  const p = submitProfile || {};
  const ios = p.ios || {};
  const missing = [];
  if (!ios.ascAppId) missing.push('ascAppId');
  if (!ios.appleTeamId) missing.push('appleTeamId');

  if (!Object.keys(ios).length) {
    return v(
      'submit-config',
      'No eas.json submit profile',
      INFO,
      'No submit.production.ios block. Fine if you upload through Transporter or Xcode; needed if you want eas submit to run unattended.',
      'Add submit.production.ios with ascAppId and appleTeamId to make submission scriptable.'
    );
  }
  if (!missing.length) {
    return v(
      'submit-config',
      'eas submit can run unattended',
      PASS,
      `submit.production.ios has ascAppId ${ios.ascAppId} and appleTeamId ${ios.appleTeamId}.`
    );
  }
  return v(
    'submit-config',
    'eas submit will stop and ask',
    WARN,
    `submit.production.ios is missing ${missing.join(' and ')}. The command then prompts interactively, which fails in CI with no useful error, usually after the build has already succeeded.`,
    'Fill in ascAppId (the numeric App Store Connect app id) and appleTeamId in eas.json.',
    'Not a store rejection. A CI pipeline that dies at the last step.'
  );
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

function checkPushSetup(deps, entitlements, hasBareIos) {
  if (!deps || !deps['expo-notifications']) {
    return v(
      'push',
      'No push notification setup to verify',
      SKIP,
      'expo-notifications is not installed.'
    );
  }
  // Managed projects have no ios/ directory to inspect, and the entitlement is
  // injected during the cloud build, so absence proves nothing.
  if (!hasBareIos) {
    return v(
      'push',
      'Push entitlement is applied at build time',
      INFO,
      'expo-notifications is installed and this is a managed project, so aps-environment gets injected during the build rather than living in the repo. That also means a misconfigured credential shows up only once the build is on a device.',
      'After installing a build, confirm a token is actually issued. npx expo-push-doctor checks the whole chain including credentials and entitlements.'
    );
  }
  const ents = entitlements || {};
  if (ents['aps-environment']) {
    return v(
      'push',
      'Push entitlement present',
      PASS,
      `ios/ contains an entitlements file with aps-environment set to "${ents['aps-environment']}".`
    );
  }
  return v(
    'push',
    'Push entitlement missing from ios/',
    FAIL,
    'expo-notifications is installed and this project has a bare ios/ directory, but no aps-environment entitlement was found. The build will succeed and getDevicePushTokenAsync will then fail at runtime with "no valid aps-environment entitlement string found for application".',
    'Add the Push Notifications capability in Xcode, or delete ios/ and let prebuild regenerate it. For the full diagnosis including credentials: npx expo-push-doctor',
    'Not a rejection. Ships, installs, and silently cannot receive a single notification.'
  );
}

// ---------------------------------------------------------------------------
// Over-the-air updates
// ---------------------------------------------------------------------------

function checkUpdatesWiring(updatesConfig, deps) {
  const configured = !!(updatesConfig && updatesConfig.url);
  const installed = !!(deps && deps['expo-updates']);

  if (!configured && !installed) {
    return v('ota-wiring', 'No OTA updates configured', SKIP, 'Neither expo-updates nor an updates URL is present.');
  }
  if (configured && !installed) {
    return v(
      'ota-wiring',
      'Updates URL without expo-updates',
      FAIL,
      'expo.updates.url is set but expo-updates is not in dependencies, so nothing in the app ever checks for an update. eas update will publish successfully and reach nobody.',
      'npx expo install expo-updates'
    );
  }
  if (installed && !configured) {
    return v(
      'ota-wiring',
      'expo-updates without an updates URL',
      WARN,
      'expo-updates is installed but expo.updates.url is not set, so the client has no endpoint to poll.',
      'Run eas update:configure to have it written for you.'
    );
  }
  return v(
    'ota-wiring',
    'OTA updates are wired up',
    PASS,
    'expo-updates is installed and expo.updates.url is set.'
  );
}

// The appVersion policy is the trap. runtimeVersion becomes the value of
// expo.version, so the day you bump 1.0.0 to 1.0.1 every build already on a
// device stops matching, and updates you publish reach none of them. It is the
// correct policy for many teams, but it needs to be a decision rather than the
// thing you copied out of the docs.
function checkRuntimeVersion(runtimeVersion, version, hasUpdatesUrl) {
  if (!hasUpdatesUrl) {
    return v('ota-runtime', 'No OTA runtime version to check', SKIP, 'OTA updates are not configured.');
  }
  if (!runtimeVersion) {
    return v(
      'ota-runtime',
      'No runtimeVersion set',
      FAIL,
      'expo.updates.url is configured but expo.runtimeVersion is not. Without it the client cannot tell which published updates are compatible with its native code, and an update built against different native modules will crash on launch rather than being skipped.',
      'Set expo.runtimeVersion, usually { "policy": "appVersion" } or { "policy": "fingerprint" }.',
      'Not a rejection. An update that hard-crashes every device that pulls it.'
    );
  }
  const policy = typeof runtimeVersion === 'object' ? runtimeVersion.policy : null;
  const literal = typeof runtimeVersion === 'string' ? runtimeVersion : null;

  if (policy === 'appVersion') {
    return v(
      'ota-runtime',
      'runtimeVersion is tied to your app version',
      WARN,
      `Policy "appVersion" means the runtime version is literally expo.version, currently ${version || 'unset'}. The moment you bump that, every build already installed stops matching and can no longer receive any update you publish. You have to ship a new binary to reach those users again.`,
      'Deliberate for teams who want each store release isolated. If you would rather push JS fixes across version bumps, use { "policy": "fingerprint" }, which changes only when native code actually changes.',
      'Not a rejection. Updates that silently reach zero devices.'
    );
  }
  if (policy === 'fingerprint' || policy === 'nativeVersion' || literal) {
    return v(
      'ota-runtime',
      'runtimeVersion is set',
      PASS,
      literal
        ? `Pinned to "${literal}". You own compatibility by hand, which is fine as long as you bump it whenever native code changes.`
        : `Policy "${policy}".`
    );
  }
  return v(
    'ota-runtime',
    'Unrecognised runtimeVersion',
    WARN,
    `expo.runtimeVersion is ${JSON.stringify(runtimeVersion)}, which is not a policy this tool recognises.`,
    'Use { "policy": "appVersion" } or { "policy": "fingerprint" }, or a literal string.'
  );
}

// A build carries the channel it was built with. Publishing to a channel no
// build uses is the quietest possible failure: eas update reports success,
// prints a URL, and not one device is listening.
function checkUpdateChannels(buildProfiles) {
  const profiles = buildProfiles || {};
  const names = Object.keys(profiles);
  if (!names.length) {
    return v('ota-channels', 'No build profiles found', SKIP, 'eas.json has no build profiles.');
  }

  // A profile that other profiles extend is a base, not something anyone runs
  // eas build against, so it does not need a channel of its own.
  const extendedBy = new Set(names.map((n) => profiles[n] && profiles[n].extends).filter(Boolean));

  const withoutChannel = names.filter((n) => {
    if (extendedBy.has(n)) return false;
    let cur = profiles[n] || {};
    const seen = new Set([n]);
    while (cur) {
      if (cur.channel) return false;
      if (cur.developmentClient) return false; // dev clients do not consume channels
      const ext = cur.extends;
      if (!ext || seen.has(ext)) break;
      seen.add(ext);
      cur = profiles[ext];
    }
    return true;
  });

  if (!withoutChannel.length) {
    return v(
      'ota-channels',
      'Every build profile declares a channel',
      PASS,
      `${names.length} profile(s), each resolving to a channel directly, through extends, or exempt as a base or dev client.`
    );
  }
  return v(
    'ota-channels',
    'Build profile with no channel',
    WARN,
    `No channel resolves for: ${withoutChannel.join(', ')}. Builds from these profiles cannot receive any OTA update, and eas update will still report success when you publish to a channel they do not listen on.`,
    'Give each store-bound profile a "channel" in eas.json, or inherit one via "extends".',
    'Not a rejection. An update that reports success and reaches nobody.'
  );
}

// ---------------------------------------------------------------------------
// Android
// ---------------------------------------------------------------------------

function checkAndroidIcon(adaptiveIcon, iconInfo) {
  if (adaptiveIcon && adaptiveIcon.foregroundImage) {
    return v(
      'android-icon',
      'Adaptive icon configured',
      PASS,
      'expo.android.adaptiveIcon.foregroundImage is set, so Android can mask it to whatever shape the launcher wants.'
    );
  }
  return v(
    'android-icon',
    'No adaptive icon',
    WARN,
    `Android will fall back to ${iconInfo ? 'your single square icon' : 'a default'} and letterbox it inside whatever shape the launcher uses. On most devices that renders as a small square floating in a circle.`,
    'Set expo.android.adaptiveIcon.foregroundImage to a 1024x1024 PNG with the artwork inside the middle 66%, plus a backgroundColor.',
    'Not a rejection. Looks unfinished on every Android home screen.'
  );
}

function checkPlayServiceAccount(androidSubmit, presentFiles, gitignore) {
  const path = androidSubmit && androidSubmit.serviceAccountKeyPath;
  if (!path) {
    return v(
      'play-service-account',
      'No Play service account configured',
      INFO,
      'submit.production.android.serviceAccountKeyPath is not set, so Play submission has to be done by hand.',
      'Create a service account in Google Cloud, grant it release access in Play Console, and point serviceAccountKeyPath at the JSON.'
    );
  }
  const clean = String(path).replace(/^\.\//, '');
  const exists = (presentFiles || []).some((f) => f === clean);
  const ignored = gitignoreCovers(gitignore, clean);

  if (exists && !ignored) {
    return v(
      'play-service-account',
      'Play service account key is committable',
      FAIL,
      `${clean} exists and .gitignore does not cover it. That file can publish releases to your Play listing.`,
      `Add "${clean}" to .gitignore, then verify with: git check-ignore -v ${clean}`,
      'Whoever has it can ship a release to your users.'
    );
  }
  return v(
    'play-service-account',
    'Play service account is configured safely',
    PASS,
    exists
      ? `${clean} is present and covered by .gitignore.`
      : `Configured as ${clean}, not present locally, so nothing to leak from this checkout.`
  );
}

// ---------------------------------------------------------------------------
// Advisory
// ---------------------------------------------------------------------------

function checkSdkVersion(sdkVersion) {
  const major = parseInt(String(sdkVersion || '').split('.')[0], 10);
  if (!major) {
    return v('sdk-version', 'Expo SDK version unknown', SKIP, 'Could not read the expo dependency version.');
  }
  if (major < 50) {
    return v(
      'sdk-version',
      `Expo SDK ${major} is well out of support`,
      WARN,
      `EAS Build maintains roughly the last handful of SDKs, and Apple periodically raises the minimum iOS SDK a submission may be built against. SDK ${major} is old enough that a build can start failing for reasons that have nothing to do with your code.`,
      'Upgrade with npx expo install --fix, one SDK at a time, following the changelog for each.',
      'Advisory. Manifests as sudden build or submission failures rather than a review rejection.'
    );
  }
  return v('sdk-version', `Expo SDK ${major}`, PASS, 'Recent enough for EAS Build and current store requirements.');
}

module.exports = {
  FAIL,
  WARN,
  PASS,
  INFO,
  SKIP,
  gitignoreCovers,
  SECRET_FILE_PATTERNS,
  PERMISSION_DEPS,
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
};
