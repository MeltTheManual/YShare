# Security

## Reporting a vulnerability

Please report security problems privately first, using GitHub's
[private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository (Security → Report a vulnerability). Do not open a public
issue for anything that could expose people's files while it is unfixed.

Useful things to include: what you did, what happened, which build and platform,
and whether the two devices were on the same network. A proof of concept is
welcome but never required.

This is a small project maintained by one person, so please allow reasonable
time for a reply and a fix before publishing.

## What YShare tries to protect

- **Nothing is received without a person agreeing to it.** A remote peer cannot
  start a transfer on your device. The offer is shown locally and only a tap or
  click on your own screen accepts it.
- **Everything a peer sends is untrusted.** Names, paths, sizes, ranges, hashes,
  file counts, transfer IDs, and signaling payloads are validated in shared code
  and re-checked at the filesystem boundary before anything is opened.
- **What you accept is what you get.** Transfer metadata must match the offer you
  accepted, bound to the same transfer ID, or the data is rejected.
- **Success is verified, not assumed.** A transfer only reports success after the
  bytes are written, SHA-256 verified, and published. A failed write, hash, or
  publication is reported as a failure.
- **Partial work is cleaned up.** Cancel, decline, disconnect, and failure remove
  partial files and the sender's temporary cache.
- **Paths cannot escape.** Received paths are sanitized and confined to the
  chosen folder (desktop) or an app-private folder before publication (Android).
- **The desktop renderer is boxed in.** Context isolation on, Node integration
  off, a strict Content-Security-Policy, blocked navigation and popups, and IPC
  that only accepts calls from the app's own main frame.

## What YShare does not protect against

Being honest about the edges matters more than sounding strong:

- **A claim code is an invitation, not an identity.** Anyone who obtains a live
  code may attempt to join. The receiver's Accept step is the real gate.
- **The optional password is an access gate, not encryption.** It is proven as
  `sha256(transferId + ":" + password)` so the password itself never crosses the
  wire, but it is not a slow password hash and it does not authenticate a person.
- **WebRTC encrypts the transport, not the identity of the other side.** You are
  trusting that the person you gave the code to is the person who used it.
- **A signaling server sees connection metadata.** Whoever runs the server you
  configure can see that two addresses met and when. It never sees file bytes.
- **A relay operator carries your encrypted bytes.** They cannot read them, but
  they can see that traffic flowed.
- **Malicious file content is not scanned.** YShare delivers exactly what the
  sender sent. Treat received files the way you would treat any download.
- **Compromised devices are out of scope.** If either device is already
  controlled by an attacker, no transfer tool can help.

## Deployment rules that must not be relaxed

- Release builds refuse cleartext signaling to anything except your own machine.
- The signaling service refuses to start in production without a declared TLS
  proxy boundary and loopback binding.
- Relay secrets, signing keys, and environment files never belong in Git.
- Android release builds require external signing material and refuse the
  repository's debug key.

## Supported versions

YShare is pre-1.0. Only the latest commit on `main` receives fixes.
