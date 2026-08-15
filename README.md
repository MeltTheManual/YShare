<img alt="YShare. Device-to-device file transfer between a computer and a phone, with no cloud copy." src="docs/assets/readme-hero-v2.png">

# YShare

Send a file or folder directly from one device to another.

**No account. No cloud storage quota. No cloud copy left behind.**

YShare works on Windows and Android. Pick something, share a code, let the other person inspect the offer,
then send. The receiving device checks every byte before it says the transfer worked.

> **Current status:** the source code is public and pre-1.0. There is no official download yet. The Windows
> installer is unsigned, Android release signing is not finished, and unrelated-network relay testing is
> still required before downloadable builds are published.

## How it works

<img alt="Four simple steps: pick a file, share a six-character code, let the receiver accept, then send directly between the two devices." src="docs/assets/readme-how-v2.png">

1. **Pick** one file or a whole folder.
2. **Share the code** with the person receiving it.
3. **They review the real offer** and choose Accept or Decline on their own device.
4. **YShare sends and verifies it.** Success appears only after the received bytes match.

Transfers work in either direction, computer to phone or phone to computer. You can also add a password.
The password itself is never sent.

## Where your file goes

<img alt="The file path runs between the two devices. A small optional signaling server only helps introduce them and never stores the file." src="docs/assets/readme-file-path-v2.png">

YShare tries a direct WebRTC connection first. The file does not get uploaded to a storage service before
the other person can download it.

The short six-character code needs a small introduction service. That service only swaps temporary
connection information. It never stores the file.

Some network pairs cannot connect directly. In that case, a TURN relay can forward the encrypted traffic.
The relay carries bytes but still does not keep a cloud copy. Relay bandwidth costs money, so YShare ships
with no server address and no owner-funded service.

You have two ways to connect:

- **Quick Connect:** enter the address of a YShare server you run or trust, then use a six-character code.
- **Manual Connect:** copy and paste the longer connection codes. This needs no server at all.

The self-hosting guide explains both signaling-only and relay setups: [run your own server](docs/SELF-HOSTING.md).

## What YShare protects

- The receiver must visibly accept every transfer.
- Names, paths, sizes, ranges, hashes, and transfer IDs from the other device are treated as untrusted.
- Files are checked with SHA-256 before success.
- Partial files are cleaned up after rejection, cancellation, or failure.
- Received folder paths are kept inside the chosen destination.

YShare does not scan files for malware or prove the real-world identity of the person using a code. Read the
plain-language [security boundary](SECURITY.md) before using it for sensitive transfers.

## Project structure

<img alt="YShare has one shared protocol rulebook used by the Windows desktop app and Android app. A separate small service provides quick codes." src="docs/assets/readme-project-map-v2.png">

```text
src/                 Windows desktop app
mobile/              Android app
shared/engine.js     Connection, validation, transfer, and hashing rules shared by both apps
signaling/           Optional short-code introduction service and TURN credential service
tests/               Shared, desktop, signaling, and end-to-end checks
docs/                Self-hosting guide and README artwork
```

The desktop and Android apps are separate programs, but they use the same protocol engine. A change to a
connection code, file range, hash, or transfer message must work on both sides.

The file is split across eight WebRTC data channels. Each channel moves a different range. The receiver puts
those ranges back in the correct positions and verifies the finished file.

For the deeper technical design, read [ARCHITECTURE.md](ARCHITECTURE.md).

## Build it from source

You need Node.js 22.11 or newer. Android development also needs Java 17 and the Android SDK.

```bash
git clone https://github.com/MeltTheManual/YShare.git
cd YShare
npm ci
npm --prefix signaling ci
npm --prefix mobile ci
```

Run the Windows desktop app:

```bash
npm start
```

Build the unsigned Windows installer:

```bash
npm run dist
```

Android setup and signing instructions are in [mobile/README.md](mobile/README.md).

Run the full local verification gate:

```bash
npm run verify
```

## What is still unfinished

- There is no official installer or APK download yet.
- Unrelated-network transfers, including a path that really uses TURN, still need release-level proof.
- Interrupted transfers restart from zero.
- Publishing to Android Downloads requires Android 10 or newer.
- One sender, one receiver, and one file or folder can be active at a time.

This is an honest source release, not a claim that version 1.0 is finished.

## Contributing

Bug reports and focused pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before
changing the transfer protocol or storage behavior.

Security problems should be reported privately through the process in [SECURITY.md](SECURITY.md).

## Licence

YShare is released under the [MIT License](LICENSE). Bundled font and library notices are in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
