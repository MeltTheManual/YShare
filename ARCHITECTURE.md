# YShare - Architecture

> Technical source of truth for the current desktop, Android, shared protocol, and signaling design.
> Product decisions belong in `VISION.md`; live completion evidence belongs in `BUILD.md` and
> `CHANGELOG.md`.

## 1. System shape

YShare has four code surfaces:

1. **Shared protocol engine** - `shared/engine.js` is loaded by Electron as a browser global and imported by
   React Native as CommonJS. It owns connector encoding, WebRTC tuning, ranges, hashes/password proof, and
   peer-metadata validation.
2. **Desktop app** - Electron main process owns disk and native dialogs; the isolated renderer owns WebRTC,
   transfer state, and the COURIER UI; preload exposes a narrow IPC bridge.
3. **Android app** - React Native owns WebRTC, transfer state, and UI. Small Kotlin modules provide fast
   positioned file I/O, folder-cache materialization, and the foreground transfer service.
4. **Signaling/TURN service** - a small Node/WebSocket service brokers short-lived handshake rooms and mints
   coturn REST credentials. It never handles file bytes. coturn forwards encrypted WebRTC traffic only when
   direct networking fails.

```text
Sender app                           Receiver app
┌──────────────────┐               ┌──────────────────┐
│ COURIER UI/state │               │ COURIER UI/state │
│ WebRTC controller│◀═════════════▶│ WebRTC controller│  file bytes
│ shared engine    │   8 channels  │ shared engine    │
│ platform disk I/O│               │ platform disk I/O│
└────────┬─────────┘               └────────┬─────────┘
         │ short-lived SDP codes            │
         └──────── signaling server ────────┘
                         │
                    TURN credentials
                         │
                    coturn fallback
```

One application instance handles one active send or receive at a time.

## 2. Shared engine contract

`shared/engine.js` must remain:

- platform-neutral: no DOM, Node filesystem, React Native, or Electron imports;
- async/await-free because Metro consumes it from outside the mobile project;
- the one implementation of connector code parsing, connection ranges, hashing/password proof, and the
  common validation rules used by both clients.

Current transport constants:

| Constant | Value |
| --- | --- |
| Parallel peer connections/data channels | 8 |
| Binary chunk | 64 KiB |
| Pause threshold per channel | 1 MiB buffered |
| Resume threshold per channel | 256 KiB buffered |
| Maximum declared transfer | 8 TiB |
| Maximum folder files | 100,000 |
| Maximum connector code | 1 MiB |
| Maximum SDP string | 1 MiB per description |

Connector codes contain exactly eight WebRTC session descriptions. Current codes use
`YS1.` + base64(DEFLATE(JSON)); the decoder still accepts the older plain-base64 form. Decompression is
bounded before JSON acceptance.

The shared validators reject malformed or inconsistent:

- transfer IDs;
- names and relative paths;
- byte sizes and folder totals;
- file counts and indexes;
- SHA-256 values;
- per-connection start/end ranges;
- SDP counts, types, and lengths.

Platform adapters must still perform a canonical containment check immediately before opening a path.

## 3. Connection establishment

### 3.1 Quick Connect

1. Sender opens a signaling socket and requests a room.
2. Server returns a 6-character room code and short-lived TURN grant.
3. Sender creates exactly eight WebRTC offers and relays the compressed code as
   `{kind: "offers", code: "..."}`.
4. Receiver joins the room, validates and applies exactly eight RTC offers, creates eight answers, and relays
   `{kind: "answers", code: "..."}`.
5. Both peers close signaling after the handshake; file bytes use only WebRTC.

The room code is an invitation, not authenticated identity. The later local offer review and optional
password remain mandatory product gates.

### 3.2 Manual fallback

When quick signaling is unavailable, the sender exposes the long offer code and the receiver returns a long
answer code through any existing communication channel. The same WebRTC, consent, validation, transfer, and
integrity paths are used.

Without a safe TURN grant the manual path is direct/STUN-only. That can fail for CGNAT/symmetric-NAT pairs;
it must not silently fall back to insecure production transport.

### 3.3 Signaling server limits

`signaling/server.js` currently provides:

- in-memory rooms, 10-minute TTL, 500-room default cap;
- 128 KiB WebSocket payload default;
- 2,000 total / 40 per-IP WebSocket defaults;
- fixed 60-second per-IP defaults: create 10, join 30, relay 120, unknown 20, `/turn` 10;
- heartbeat termination and cleanup;
- exact two-field `{kind, code}` relay validation;
- 2-hour unique coturn REST credentials, with a maximum configured lifetime of 6 hours;
- `GET/HEAD /health` with no-store responses;
- public `/turn` disabled by default and allowed only when explicitly enabled in development/test.

Production startup requires a 32+ character TURN secret, safe TURN host, loopback bind, declared TLS
termination, and trusted `X-Real-IP` forwarding from a loopback reverse proxy. It refuses a direct public
cleartext production bind.

`YSHARE_NO_TURN=1` runs the service with signaling only: it mints no credentials and every transfer must
find a direct path. This is the practical self-hosting mode and it must be declared deliberately — a missing
`TURN_SECRET` remains a startup error, so a half-finished deployment can never silently downgrade every user
to direct-only. Setting it alongside TURN credentials, or with the public `/turn` endpoint requested, is also
refused. Operational detail lives in `docs/SELF-HOSTING.md`.

### 3.4 No endpoint is compiled in

YShare ships with no signaling address. `shared/engine.js` owns the whole policy:

- `parseSignalEndpoint()` accepts only `host` plus an optional port, with an optional `ws/wss/http/https`
  scheme. Paths, query strings, embedded credentials, and malformed hosts are rejected rather than repaired.
- A bare `host:port` resolves to **secure** (`wss`). Cleartext is never inferred on the user's behalf.
- `signalEndpointIssue()` refuses cleartext to a remote host; loopback cleartext is allowed so a person can
  test against a server on their own machine. Platforms pass `allowInsecure` only for development builds.
- `configureSignaling()` is the single entry point; nothing else may set the active endpoint. With none set,
  `signalDial()` rejects and `fetchTurnCreds()` resolves null, so Quick Connect fails closed to manual codes.

Each platform stores the chosen address itself — desktop in `settings.json` (validated in main before it is
stored), Android in a small app-private JSON file — and re-validates on load. A regression test fails the
build if any shipped file ever hardcodes a server address again.

## 4. WebRTC data plane

YShare creates eight ordered data channels, one per peer connection. For a single file, `connRange(i, size,
8)` assigns each channel a contiguous non-overlapping range. The sender performs positioned 64 KiB reads;
the receiver performs positioned writes at the declared absolute offsets.

Backpressure pauses a sender above 1 MiB queued on that channel and resumes below 256 KiB. Drain/flush waits
must settle when a channel closes, errors, or a transfer is cancelled; they must never leave an abandoned
Promise holding the transfer alive.

There is no per-chunk hash. A single-file sender calculates one SHA-256 for the source; the receiver hashes
the complete reassembled file before publication. A folder calculates and verifies one SHA-256 per file.

Folder files are processed sequentially. Each current file uses the same eight range channels as a single
file. The tradeoff is per-file hash/control setup and no cross-file pipelining, which can add overhead for a
folder containing very many small files.

## 5. Protocol and lifecycle invariants

Control JSON and binary chunks share the data channels. The exact internal message set evolves with both
clients together, but the lifecycle is fixed:

1. Receiver sends `ready` after its listeners are installed.
2. Sender publishes one file/folder offer on the control channel.
3. Receiver validates the offer and shows it locally. No peer message can press Accept.
4. Receiver sends a transfer-ID-bound `accept` (and password proof if locked) or `decline`.
5. Sender sends transfer-ID-bound metadata. Each channel's metadata must match the accepted name, size,
   hash, and exact range before binary data is accepted.
6. Sender queues every declared range and, for folders, `folder-sent`; only then is local send completion
   true.
7. Receiver writes, verifies, and publishes. It sends exactly one terminal `ack {ok, reason}`.
8. Sender accepts an ACK only for the current transfer and only after local send completion.

Every terminal path—success, decline, cancellation, password exhaustion, protocol rejection, write/hash/
publication failure, channel failure, app reset, or process exit—must be idempotent. A stale callback from an
old transfer must not mutate a replacement transfer. Desktop owner objects, Quick Connect attempt/socket
tokens, and Android refs/terminal flags are captured and rechecked after asynchronous work.

The optional password is represented as `sha256(transferId + ':' + password)`. This prevents the raw
password crossing the channel and scopes a proof to one transfer, but it is not a slow password KDF or a
cryptographic identity system.

## 6. Desktop implementation

### 6.1 Process boundary

- `src/main.js`: BrowserWindow, dialogs, settings, source handles, positioned writes, hashing, exclusive final
  publication, collision naming, and cleanup.
- `src/main-security.js`: testable exact-local-URL and main-frame IPC trust checks.
- `src/preload.js`: explicit `window.yshare` IPC methods only.
- `src/renderer/renderer.js`: WebRTC, state machines, validation orchestration, UI, and progress.
- `src/renderer/lifecycle.js`: small testable helpers for channel drain/flush settlement, ACK-once logic,
  and stale Quick Connect attempt rejection.

Electron uses context isolation with Node integration off. The renderer never receives arbitrary filesystem
authority; it asks main for specific operations. Main accepts IPC only from the exact local main frame,
blocks unexpected frame/top-level navigation, and denies renderer-created windows.

### 6.2 Single-file receive

Main sanitizes the accepted leaf name, chooses a collision-free final destination, synchronously reserves
the receive owner, creates `<name>.part` with exclusive creation, preallocates the declared size, and
performs bounded positioned writes. It closes and hashes the part, then publishes only on an exact match
using an exclusive hard link or Windows `COPYFILE_EXCL`; it never uses an overwrite-capable rename. A losing
concurrent open can delete only an artifact it created. Failure/cancel closes handles and retries cleanup.

### 6.3 Folder receive

Main sanitizes the folder leaf, collision-avoids its root, canonicalizes every relative path underneath that
root, rejects duplicate case-insensitive paths, reserves file indexes/paths before asynchronous filesystem
work, and uses per-file `.part` files. Each file is exclusively published after its own exact hash. Any
terminal folder failure removes the whole receive root; `complete-folder` releases cleanup ownership only
after no file remains open.

### 6.4 Transport boundary

Main owns the signaling setting. `get/set/clear-signal-endpoint` cross the same trusted-frame IPC wrapper as
every other channel, and `set` stores nothing unless the shared validator accepts it, so an invalid or
cleartext-remote address never reaches `settings.json`. The renderer starts in the closed state and opens
Quick Connect only after main confirms a usable endpoint; a failed IPC call leaves it closed.

The renderer's Content-Security-Policy states the same rule rather than naming a host: `connect-src` allows
`wss:`/`https:` plus cleartext to `localhost`/`127.0.0.1` only. CSP and `signalEndpointIssue()` must stay in
agreement — if one is relaxed, the other has to be as well, deliberately.

## 7. Android implementation

### 7.1 Layers

- `mobile/App.tsx`: React Native UI, WebRTC, protocol/lifecycle, notification control, and publication.
- `react-native-webrtc`: peer connections and data channels.
- `@react-native-documents/picker`: single-file and SAF folder selection.
- `react-native-file-access`: positioned source reads.
- `react-native-blob-util`: app directories and MediaStore publication.
- `YRawFileModule.kt`: batched positioned receive writes and SAF folder materialization into sender cache.
- `TransferService.kt` / foreground bridge: Android data-sync foreground service and timeout notification.

### 7.2 Sender cache

Android copies a selected file to app cache and materializes a selected SAF folder under
`cache/yshare_send` because content URIs are not reliable positioned-read files. Every sender terminal path
cleans this cache. For single-file picks, cleanup deletes the exact picked copy and removes its parent only
when a pure path guard proves that parent is one direct child beneath the cache root; it never grants cleanup
authority over the cache root, nested ancestors, or prefix lookalikes. A native folder-copy exception deletes
the partially materialized tree before rejecting.

### 7.3 Receiver staging and publication

Each receive gets a random app-private root under the document directory; no peer value controls that root.
Single bytes go to `payload.part`; folder relative paths are sanitized and contained under a private
`folder` root. Native handles close before hashing.

Only Android 10/API 29+ can use the current `MediaStore.Downloads`/`RELATIVE_PATH` publication path. On API
24-28, YShare completes private verification, sends a truthful failure ACK, preserves the verified private
copy, and explains that Android 10+ is required. It does not crash or request broad legacy storage access.
That retained copy is terminal-screen recovery state, not durable user storage: New Transfer or the next
receive force-cleans it before assigning a new private root.

For a single file, successful MediaStore publication removes the private copy. If publication fails, the
verified private copy is retained and ACK is false.

For a folder, every private file is verified before publication begins. MediaStore copies are then made one
file at a time. Android cannot transactionally roll back already published public files, so publication may
fail after `N/count` files are visible in Downloads. YShare reports that exact partial result, sends ACK
false, and preserves the full verified private tree. Public all-or-nothing is therefore not claimed.

Empty files are supported. Empty folders are currently rejected on Android because MediaStore cannot create
an empty public folder item through the file-publication path.

### 7.4 Android build boundary

The main/release manifest sets `usesCleartextTraffic="false"`; only the debug manifest overlay allows
cleartext, which is what makes a `ws://localhost` test server usable over `adb reverse` during development.
Release Gradle tasks fail without four external signing environment variables and never fall back to the
tracked debug keystore. The public Android application ID is `app.yshare`. The internal Kotlin namespace
remains `com.ysharemobile`, which is normal and not user-visible. minSdk 24 remains provisional because the
current public Downloads path requires Android 10 / API 29 or newer.

Normal React Native debug APKs do not embed the JavaScript bundle and require Metro. Release APKs bundle JS
and Gradle requires real external signing. A release build therefore reaches a `wss://` server only, and
falls back to manual codes when the person has configured nothing.

## 8. Trust and security boundary

- All peer metadata and signaling payloads are untrusted.
- The receiver's accepted offer is immutable input for later metadata checks.
- Binary data before acceptance and validated metadata is a protocol failure.
- Paths are sanitized in shared code and contained again at the filesystem boundary.
- The signaling service never logs room codes, TURN credentials, or full client addresses.
- Relay secrets, release keystores, passwords, tokens, and environment files stay outside Git.
- Electron CSP restricts renderer connections; context isolation is on and Node integration is off.
- Electron blocks unexpected navigation/windows and validates every IPC caller as the exact local main frame.
- WebRTC encryption protects transport, including through TURN, but claim codes do not authenticate a
  person's real-world identity.

## 9. Verification architecture

- `tests/shared-engine.test.js`: connector, decompression, validation, ranges, paths, and password proof.
- desktop lifecycle/security Node tests: channel-close settlement, terminal ACK-once, stale Quick attempt
  rejection, local-main-frame IPC trust, destination reservation/own-artifact cleanup, navigation/window
  blocking, and packaged cleartext guard.
- `signaling/test-client.js`: normal room/TURN behavior, schema rejection, oversized/deep payload survival,
  rate limits, connection caps, and production fail-closed startup.
- mobile Jest: render smoke, the API 29 publication boundary, and single-file picker-cache path authority.
- mobile lint and TypeScript checks.
- Gradle merged-manifest checks and debug APK build.
- packaged desktop build plus hidden/off-screen runtime smoke tests where relevant.
- connected Android local smoke in both directions; unrelated-network and real-TURN proof remain separate
  public-launch gates.
- a regression test that fails if any shipped file hardcodes a signaling address, plus endpoint-validation
  and signaling-only-server coverage.

Automated checks do not replace real storage/network tests, and a debug APK does not prove release safety.

## 10. Known architecture limits and next technical decisions

- Quick Connect depends on a server the person supplies. Without one the product is manual-code only, which
  works but is a visibly rougher first experience.
- Cross-network behaviour is unproven at the level a release needs: direct/same-network transfers are
  verified, but a full unrelated-network run through a real TURN relay has not been completed.
- Android public Downloads currently requires API 29+ even though install minSdk remains 24.
- Android folder publication cannot be transactionally rolled back through MediaStore.
- Empty Android folder receive is unsupported.
- Android release signing is still open. The application ID is settled as `app.yshare`, and Windows builds
  will ship unsigned with an honest SmartScreen explanation and a published SHA-256 checksum.
- Resume/retry, multi-recipient transfer, and more advanced folder scheduling remain future work.
