# Contributing to YShare

Thanks for looking. YShare is a small, deliberately simple app: two devices, one
file, no cloud in the middle. Contributions that keep it that way are very
welcome.

## Before you start something big

Open an issue first for anything beyond a bug fix. The project has a narrow scope
on purpose (see `VISION.md`), and it is kinder to say "that does not fit" in an
issue than on a finished pull request.

Things that are **out of scope** for version 1: user accounts, cloud storage,
chat, public file discovery, analytics, and advertising.

## Getting set up

You need Node.js 22.11+, and for Android work also Java 17 and the Android SDK.

```bash
npm ci
npm --prefix signaling ci
npm --prefix mobile ci
npm run verify
```

`npm start` runs the desktop app. `mobile/README.md` covers the Android setup.
`docs/SELF-HOSTING.md` explains how to run a signaling server for Quick Connect —
or skip it and test with the manual connection codes, which need no server.

## The rules that keep this app safe

These are not style preferences. A change that breaks one of them will be asked
to change, however good the rest of it is.

1. **`shared/engine.js` is the shared protocol.** It must stay platform-neutral
   (no DOM, no Node `fs`, no React Native imports) and free of `async`/`await`,
   because React Native's bundler consumes it from outside the mobile project.
   Anything you change there changes both apps at once.
2. **Both platforms move together.** A change to messages, metadata,
   acknowledgements, or connector codes must be implemented and tested on desktop
   *and* Android.
3. **Everything from a peer is untrusted.** Validate names, paths, sizes, counts,
   ranges, hashes, and transfer IDs, and bind them to the offer the receiver
   actually accepted.
4. **Receiving always requires a local accept.** No peer message may accept on
   the receiver's behalf, ever.
5. **One truthful ending.** Exactly one terminal acknowledgement per transfer. A
   failed write, hash, rename, or publication is not success.
6. **Clean up after yourself.** Cancel, decline, failure, and completion must
   remove partial files and temporary caches.
7. **No baked-in servers.** No signaling address, relay host, or credential may
   be hardcoded into the app. There is a test that fails if one appears.
8. **No secrets in Git.** Keys, keystores, tokens, and `.env` files stay out.

## Before you open a pull request

```bash
npm run verify
```

That runs the syntax check, the shared and desktop tests, the signaling suite,
and the mobile lint, TypeScript, and Jest checks.

There are also two end to end tests that drive the real packaged desktop app. They
are not part of `npm run verify` because they need a built app, so run them by hand
after `npm run dist` when you touch transfers, the signaling service, or the server
setting:

```bash
node tests/e2e-full.js
node tests/e2e-interrupt.js
```

`e2e-full` starts the bundled signaling service with no relay, launches two hidden
copies of the app with fresh settings, and sends a real file and a real folder
between them, then compares every byte on disk. `e2e-interrupt` proves that
removing the server kills any claim code that was still live. Both windows stay
hidden, so neither steals your focus, and both fail if the app logs a single
console error. If you touched Android code,
build the debug APK too, and say in your pull request what you actually ran and
what you could not test — an honest "I could not test this on a real phone" is
much more useful than a confident guess.

New behaviour should come with a test. The existing suites are plain
`node --test` and Jest; copy the nearest neighbour's style.

## Code style

Match the file you are editing. Comments explain *why* something is the way it
is, not what the line does — the code already says that. Plain language is
preferred everywhere, including in user-facing strings: the app is for people who
do not know what NAT is.

## If you are forking this to ship your own build

Change the Android application ID in `mobile/android/app/build.gradle` before you build:

```gradle
applicationId "com.yourname.yshare"
```

It is `app.yshare` here, and an application ID is a global name. If you keep it, your build and the original
cannot both be installed on the same phone, and you would not be able to publish yours to Google Play,
because that ID belongs to the first account that publishes it.

Sign your build with your own key, too — never with the debug key in this repository. Your key is what tells
Android that an update really came from you.

## Reporting bugs

Include your platform and version, both devices' networks (same Wi-Fi or not),
whether you used Quick Connect or a manual code, and what the app said. If a
transfer failed, the exact message from both ends helps enormously.

Security problems go through `SECURITY.md` instead, not the public issue tracker.

## Licence

By contributing you agree that your contribution is licensed under the MIT
licence in `LICENSE`.
