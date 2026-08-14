# YShare for Android

This directory contains the React Native Android client for YShare. It speaks the same WebRTC transfer
protocol as the Electron desktop app through `../shared/engine.js`.

For product status and decisions, start at the repository-level `README.md`, `CHANGELOG.md`, `VISION.md`,
`BUILD.md`, and `ARCHITECTURE.md`. This file is only the practical mobile setup and build guide.

## Local requirements

- Node.js 22.11 or newer (the version required by `package.json`).
- A Java 17 JDK.
- Android SDK 36 with build tools 36.0.0.
- An Android emulator or a trusted device with USB or wireless debugging.

The project can currently install on Android 7 (API 24), but verified publication into the public Downloads
collection uses APIs introduced in Android 10 (API 29). On Android 7-9 the app must stop with a clear error;
it must not crash or request broad legacy storage access. Before public launch, the owner will choose between
formally requiring Android 10+ and funding a separate legacy storage implementation.

Set `JAVA_HOME` and `ANDROID_HOME`. `GRADLE_USER_HOME` is optional. The two Windows build scripts first use
the current process environment and then fall back to the current user's environment variables, so they do
not depend on this repository living on a particular drive.

## Install and verify

From `mobile/`:

```powershell
npm.cmd ci
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test -- --runInBand --watch=false
```

From the repository root, `npm.cmd run verify` runs the shared protocol tests, signaling tests, mobile
lint, TypeScript, and mobile Jest suite together.

## Development build

For a development APK that is safe to sideload while Metro is running:

```powershell
cd android
.\gradlew.bat assembleDebug
```

Or double-click `build-app.bat`. It writes its log to `build-debug.log` and reports success only when Gradle
actually returns success. React Native's normal debug variant does not embed the JavaScript bundle, so launch
Metro with `npm.cmd start` before exercising the installed app. The APK is:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

A debug APK uses Android's standard debug identity and has a debug-only manifest override that permits the
temporary cleartext test signaling endpoint. The main/release manifest blocks cleartext. A debug APK is not
a public release.

## Release build safety gate

The project deliberately refuses to build a release with the tracked debug key. After the permanent Android
application identity and private signing key are chosen, keep the keystore outside this repository and set:

```text
YSHARE_RELEASE_STORE_FILE
YSHARE_RELEASE_STORE_PASSWORD
YSHARE_RELEASE_KEY_ALIAS
YSHARE_RELEASE_KEY_PASSWORD
```

Then run `build-release.bat` or `gradlew.bat assembleRelease`. Never commit those values or the keystore.

Quick Connect in a release build needs a `wss://` signaling server, which each person configures in the app
itself — nothing is compiled in. See `docs/SELF-HOSTING.md`.

## Application ID

The application ID is **`app.yshare`** (settled 14 August 2026). This is permanent: Android identifies and
updates an app by this string, so changing it after anyone installs YShare would produce a second, separate
app rather than an update.

The internal Kotlin package is still `com.ysharemobile`, and that is fine — `namespace` and `applicationId`
are different things, and only the latter is user-visible. Renaming the internal package is optional tidying
with no user benefit.

If you previously sideloaded a test build under the old ID, the new build installs **alongside** it instead
of replacing it. Uninstall the old one to avoid confusion.

The release signing identity is still outstanding. Create the keystore yourself so its password never passes
through anyone else, keep it outside this repository, and back it up somewhere you control — losing it means
never being able to update the published app again:

```powershell
keytool -genkeypair -v -storetype PKCS12 -keystore D:\Claude\keys\yshare-release.keystore `
  -alias yshare -keyalg RSA -keysize 4096 -validity 10000
```

## Device connection

Wireless debugging uses two different Android ports: the temporary pairing port shown beside the pairing
code, and the connection port shown on the main Wireless debugging screen. Pair once if needed, then connect:

```powershell
adb pair PHONE_IP:PAIRING_PORT
adb connect PHONE_IP:CONNECTION_PORT
adb devices -l
```

If `adb devices -l` already shows the phone as `device`, it is connected and no new pairing step is needed.
