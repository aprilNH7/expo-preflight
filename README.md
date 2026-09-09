# expo-preflight

[![test](https://github.com/aprilNH7/expo-preflight/actions/workflows/test.yml/badge.svg)](https://github.com/aprilNH7/expo-preflight/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node: >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

Catch what App Store review will reject in your Expo app, before you spend the build minutes.

An EAS build takes 15 to 25 minutes. App Review takes a day or two. Neither of them tells you that your icon has an alpha channel, that your Stripe secret is baked into the JS bundle, or that the OTA update you just published cannot reach a single installed device. You find that out at the end.

This reads your project and tells you at the start. One command, no config, no dependencies, nothing leaves your machine.

```
npx expo-preflight
```

## What it looks like

```
expo-preflight  ·  what App Review will reject, before you build
  app.json  ·  IQGen v1.0.0

FAIL  Signing credentials can be committed
       These exist in the project and .gitignore does not cover them:
       AuthKey_9F8X4K2M.p8 (an APNs or App Store Connect auth key). One
       "git add ." and they are in your history, and on a public repo that is
       unrecoverable: rotating is the only fix, rewriting history is not enough
       because forks and caches keep the blob.
       costs  A leaked .p8 lets anyone send push to every install of your app,
              under any app in your team.
       fix    Add to .gitignore: *.p8, then confirm with:
              git check-ignore -v AuthKey_9F8X4K2M.p8

FAIL  A secret is prefixed EXPO_PUBLIC_
       EXPO_PUBLIC_STRIPE_SECRET_KEY. The EXPO_PUBLIC_ prefix inlines the value
       into the JS bundle at build time. The bundle ships inside your IPA and
       APK, so this is published, not configured. Unzipping a store build and
       grepping it takes about a minute.
       costs  Not a rejection. Worse: it ships, works, and is readable by
              anyone who downloads your app.
       fix    Drop the EXPO_PUBLIC_ prefix and read it server-side, or move it
              to an EAS secret and never reference it from client code.

WARN  runtimeVersion is tied to your app version
       Policy "appVersion" means the runtime version is literally expo.version,
       currently 1.0.0. The moment you bump that, every build already installed
       stops matching and can no longer receive any update you publish. You
       have to ship a new binary to reach those users again.
       costs  Not a rejection. Updates that silently reach zero devices.
       fix    Deliberate for teams who want each store release isolated. If you
              would rather push JS fixes across version bumps, use
              { "policy": "fingerprint" }.

2 blocking problems, 1 warning.
Each blocking problem above either fails at upload or gets rejected in review.
```

Every finding names what it costs you, and the fix is something you can paste.

## What it checks

**Credential leaks.** The ones that are unrecoverable once pushed.

| Check | Catches |
| --- | --- |
| `secret-files` | `.p8`, `.p12`, `.mobileprovision`, `.keystore`, `.jks`, service account JSON sitting in the project with no `.gitignore` rule. Asks git, so global excludes and nested ignore files count. |
| `public-env-secrets` | A secret behind `EXPO_PUBLIC_`, which Expo inlines into the shipped bundle. Allowlists the keys that are genuinely public, like `PUBLISHABLE` and `ANON_KEY`. |
| `play-service-account` | A Play publishing key that `eas.json` points at and `.gitignore` does not cover. |

**Rejections.** Things review actually bounces.

| Check | Catches |
| --- | --- |
| `permission-strings` | A permission-requesting package with no `NS*UsageDescription`. Hard failure for bare RN libs that inject nothing; a warning for Expo packages, whose config plugin injects boilerplate that reviewers reject for vagueness. |
| `tracking-transparency` | An ad or attribution SDK with no ATT prompt wired up. Guideline 5.1.2. |
| `icon` | Alpha channel, non-square, or under 1024. Parsed from the PNG header, no image library. This one fails at upload, so it costs a whole build cycle. |
| `bundle-ids` | Missing, or still `com.example` / `com.anonymous`. Neither store lets you change it after the first release. |
| `store-urls` | Privacy policy and support URL not recorded anywhere in the repo. |

**Mechanics.** Things that waste a cycle rather than getting rejected.

| Check | Catches |
| --- | --- |
| `versioning` | No `autoIncrement`, so a resubmission collides with a build number you already used, including builds you deleted. |
| `export-compliance` | `usesNonExemptEncryption` unset, so every submission stalls behind the encryption questionnaire. |
| `submit-config` | `eas submit` missing `ascAppId` or `appleTeamId`, so it prompts interactively and dies in CI right after a successful build. |
| `sdk-version` | An Expo SDK old enough that builds start failing for reasons unrelated to your code. |

**Over-the-air updates.** The quietest failures in the whole pipeline.

| Check | Catches |
| --- | --- |
| `ota-wiring` | An `updates.url` with no `expo-updates` installed. `eas update` reports success and reaches nobody. |
| `ota-runtime` | No `runtimeVersion` at all, which lets an incompatible update hard-crash on launch. Or the `appVersion` policy, which orphans every installed build the moment you bump your version. |
| `ota-channels` | A build profile with no channel, so builds from it can never receive an update. Understands `extends` inheritance, and does not flag base profiles or dev clients. |
| `push` | `expo-notifications` with no `aps-environment` in a bare `ios/`. Ships fine, installs fine, cannot receive a single notification. |

## In CI

Exits 1 on any blocking problem, so it gates a pipeline as-is.

```yaml
- run: npx expo-preflight
```

Warnings do not fail the build by default. Add `--strict` if you want them to.

```yaml
- run: npx expo-preflight --strict
```

```
--json          machine-readable output
--verbose       include checks skipped as not applicable
--dir <path>    project directory, default cwd
--no-warn-exit  exit 0 even with warnings (default already ignores warnings)
--strict        exit 1 on warnings too
```

Skipped checks are hidden by default; add `--verbose` to see them.

Exit codes are `0` clean, `1` problems found, `2` no Expo project in that directory. A missing project is deliberately not `1`, so a misconfigured CI path does not look like a failing app.

## What it does not do

It reads your repo. It cannot see App Store Connect, so it cannot verify the privacy policy URL you typed into the console, whether you attached a demo account, or whether your screenshots are the right size. Those are on you.

It also cannot know your intent. The `appVersion` runtime policy is the right call for plenty of teams; the warning exists because it should be a decision rather than something copied out of the docs.

If your `app.config.js` cannot be evaluated, the report says so instead of quietly checking a stale `app.json`.

## Privacy

Reads `app.json` / `app.config.*`, `eas.json`, `package.json`, `.gitignore`, your icon, and any `ios/*.entitlements`. Collects environment variable **names** only, never values, so a secret cannot end up in your CI logs by way of this tool. No network calls. No telemetry. Zero runtime dependencies.

## Related

[**expo-push-doctor**](https://github.com/aprilNH7/expo-push-doctor) picks up where the `push` check stops. This one tells you the entitlement is missing from your repo; that one walks the whole chain including credentials, tokens and the device handshake, and tells you why a build that looks correct still receives nothing.

## Why this exists

Every check here is something that actually happened while shipping a React Native app to the App Store, in the order it hurt. The push entitlement that built cleanly and then issued no token. The export compliance prompt that parked a finished build for two days. The build number collision on the resubmission. The service account key that nearly got committed.

None of it was hard to fix. All of it was invisible until it had already cost a cycle.

## License

MIT
