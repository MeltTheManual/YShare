# YShare

**Send a file straight from one device to another. No account, no upload, no
cloud copy sitting on somebody else's disk.**

You pick a file. YShare gives you a six-character code. The other person types
that code, sees exactly what is being offered, and taps Accept. The file then
travels device-to-device over an encrypted WebRTC connection, gets checked with a
SHA-256 hash, and only then lands in their Downloads folder.

Windows and Android today. macOS, Linux, and iOS are later, not never.

---

## Why

Sending a 2 GB folder to someone usually means uploading it to a cloud service,
waiting, sending a link, and hoping they download it before the link expires — a
round trip through a company's server for a file that only needed to go across
the room.

YShare skips the middle. There is no storage backend to fill up, no quota, and no
copy of your file left anywhere. When two devices can reach each other, the bytes
go straight across.

## What it does

- Send a **single file or a whole folder**, in either direction.
- **Six-character claim codes**, or long manual codes when you have no server.
- **Direct connection first**, with an optional relay only if that fails.
- **The receiver must accept.** A sender cannot push a file onto your device.
- **Optional password** on a transfer.
- Progress, speed, ETA, and cancel from either side.
- **SHA-256 verification** before anything is published as complete.
- Partial files are cleaned up on cancel, failure, or decline.
- Android keeps transfers alive with a foreground service and notification.

## Honest status

Pre-1.0, and built in the open. Desktop `0.0.12` and Android `0.0.10` are
verified working in both directions on real hardware — including a full
two-way transfer between a Windows PC and an Android 13 phone with matching
hashes on both ends.

What is **not** done yet, so you know before you invest time:

- **No downloadable builds yet.** You build from source today. The Windows
  installer is unsigned and the Android app still uses a development signing
  identity, and neither belongs in the hands of real users until that is fixed.
- **Cross-network transfers are not fully proven.** Same-network and direct
  transfers are tested; a full unrelated-network test with a real relay is still
  outstanding.
- Interrupted transfers restart from zero. There is no resume yet.
- Android publishing to Downloads needs Android 10 or newer.
- One sender to one receiver, one item at a time.

## Quick Connect needs a server — and it is not ours

This is the part most people ask about, so plainly:

**YShare runs no servers.** No address is compiled into the app, so nothing you
send passes through us, and nobody inherits somebody else's hosting bill.

The six-character code needs a tiny "introduce these two devices" service to
exist somewhere. This repository contains that service (`signaling/`). Run it
yourself in about five minutes, or point YShare at one you trust — the address
goes in the app's own settings, on the home screen.

The service only passes a handshake of a few kilobytes. **Your files never go
through it.**

Don't want to run anything at all? Use the **manual codes**. They need no server
whatsoever, and every safety rule stays exactly the same.

See **[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)**.

## How it works

```text
Sender                                            Receiver
┌──────────────────┐                        ┌──────────────────┐
│ pick a file      │                        │ type the code    │
│ shared engine    │◀══ 8 data channels ═══▶│ shared engine    │
│ disk reads       │      file bytes        │ disk writes      │
└────────┬─────────┘                        └────────┬─────────┘
         │                                           │
         └────── code + connection details ──────────┘
                    signaling server
                 (a few KB, no file data)
```

The file is split into eight ranges carried by eight parallel WebRTC data
channels — that is what makes it fast. Both apps share one protocol
implementation (`shared/engine.js`), so desktop and Android can never drift apart
on validation, encoding, or safety rules.

More detail: [`ARCHITECTURE.md`](ARCHITECTURE.md). Security boundaries and the
limits of what YShare protects: [`SECURITY.md`](SECURITY.md).

## Build it

You need Node.js 22.11 or newer. For Android, also Java 17 and the Android SDK.

```bash
git clone https://github.com/MeltTheManual/YShare.git
cd YShare
npm ci
npm --prefix signaling ci
npm --prefix mobile ci
```

Run the desktop app:

```bash
npm start
```

Build a Windows installer:

```bash
npm run dist
```

Build the Android app — see [`mobile/README.md`](mobile/README.md) for the SDK
setup and the release-signing rules:

```bash
cd mobile
npm run android
```

Run everything the project checks before a change is accepted:

```bash
npm run verify
```

## Repository map

```text
shared/engine.js     the protocol both apps share: codes, validation, ranges, hashing
src/                 desktop app (Electron): main process owns disk, renderer owns WebRTC
mobile/              Android app (React Native) plus its native file and service modules
signaling/           the small room-broker service you can host yourself
tests/               shared and desktop regression tests
test-harness/        network and relay experiments
docs/                self-hosting guide
marketing/teaser/    the launch teaser film, generated entirely from code
```

## Contributing

Bug reports and pull requests are welcome — please read
[`CONTRIBUTING.md`](CONTRIBUTING.md) first, especially the safety rules. Security
issues go through [`SECURITY.md`](SECURITY.md), privately, not the issue tracker.

## Licence

MIT — see [`LICENSE`](LICENSE). Bundled fonts (Instrument Serif, JetBrains Mono,
Press Start 2P) are under the SIL Open Font License and pako is MIT/Zlib; the
full texts are in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
