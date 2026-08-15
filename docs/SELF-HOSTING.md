# Run your own YShare server

YShare does not run a server for you. The apps ship with no address in them, so
Quick Connect (the 6-character code) stays switched off until you point YShare at
a server you control or trust.

**You do not edit YShare's code to add a server.** Run the included service, then
paste its `wss://` address into the Quick connect server setting on both devices.

**You may not need to configure a YShare server.** Manual Connect lets the two
devices exchange the longer offer and reply codes by hand. Without a configured
TURN service, that path is direct/STUN-only and can still fail on a restrictive
network. Quick Connect exists to replace the long codes with a short code.

---

## What this server does and does not do

The service in `signaling/` is small on purpose:

- it hands out short-lived 6-character room codes;
- it passes two connection descriptions between the two devices;
- it forgets everything about a room after 10 minutes or when both sides leave;
- **your files never touch it.** File bytes go device-to-device over WebRTC.

Optionally it also mints short-lived credentials for a TURN relay (coturn). A
relay is only used when the two devices cannot reach each other directly — most
often when one side is behind carrier-grade NAT. Relayed bytes are still
encrypted, but they do use your server's bandwidth, so this is where hosting
costs come from.

---

## Option A — signaling only (recommended to start)

No relay, no bandwidth bill worth worrying about: the server only brokers a
handshake of a few kilobytes per transfer. Direct connections work for most home
and office networks.

You need a small machine with a public address and a domain name pointing at it.

**1. Get the code onto the server**

```bash
git clone https://github.com/MeltTheManual/YShare.git
cd YShare/signaling
npm ci --omit=dev
```

**2. Run it**

```bash
NODE_ENV=production \
YSHARE_NO_TURN=1 \
YSHARE_TLS_PROXY=1 \
YSHARE_TRUST_PROXY=1 \
PORT=8443 \
node server.js
```

In production the service binds to `127.0.0.1` only and refuses to start unless
you confirm a TLS proxy sits in front of it. That is deliberate — it must never
be exposed directly to the internet in cleartext.

**3. Put TLS in front of it**

Caddy gets a certificate automatically. A whole `Caddyfile` is two lines:

```text
signal.example.com {
	reverse_proxy 127.0.0.1:8443
}
```

Caddy sets `X-Forwarded-For`; YShare reads `X-Real-IP` for its per-IP limits, so
add that header if you want per-client rate limiting to be accurate:

```text
signal.example.com {
	reverse_proxy 127.0.0.1:8443 {
		header_up X-Real-IP {remote_host}
	}
}
```

**4. Check it**

```bash
curl https://signal.example.com/health
```

`{"ok":true}` means you are done.

**5. Point YShare at it**

Open YShare, and on the home screen use **Quick connect server → Change**:

```text
wss://signal.example.com
```

Do the same on the phone. Both devices must use the same server to swap a code.

---

## What a failed connection means

Quick Connect and file transport are two separate steps:

1. The server introduces the devices and swaps temporary connection information.
2. WebRTC tries to find a network path for the file.

Receiving a six-character code only proves step 1 worked. The transfer can still fail at step 2 when guest
Wi-Fi isolates devices, a firewall blocks peer traffic, or a mobile carrier uses restrictive NAT.

| Situation | What happens | What to try |
| --- | --- | --- |
| Same normal Wi-Fi | Usually connects directly. No relay is needed. | Keep both devices on that Wi-Fi. |
| Same guest or isolated Wi-Fi | Devices may be blocked from reaching each other. | Use a normal private Wi-Fi network or TURN. |
| Different networks | YShare tries a direct route first. | If it fails, try another network or enable TURN. |
| Direct route blocked, TURN configured | Encrypted file bytes can pass through your relay. | Check coturn, its firewall ports, and bandwidth limits. |
| Direct route blocked, no TURN configured | The devices have no usable route for the file. | Add TURN or move one device to a less restrictive network. |

Manual Connect avoids the introduction server, but it does not bypass a blocked network. If both devices
are online and a code works but the connection still fails, this can be a network limitation rather than an
app defect.

---

## Option B — add a TURN relay

Add this only if transfers fail to connect for you, which usually means one side
is behind carrier-grade NAT. **This is the part that can cost real money:**
every relayed byte is your bandwidth, and a relayed 2 GB transfer costs you 2 GB
of traffic. Check your provider's pricing before you enable it, and prefer a host
with generous or unmetered transfer.

Install coturn, then in `/etc/turnserver.conf`:

```text
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=PUT_A_LONG_RANDOM_SECRET_HERE
realm=signal.example.com
# The public address of this machine. On a cloud box with a private NIC, use
# external-ip=PUBLIC_IP/PRIVATE_IP — a wrong value here is the single most
# common reason a relay looks alive but never actually relays.
external-ip=203.0.113.10
min-port=49160
max-port=49200
no-tlsv1
no-tlsv1_1
```

Generate the secret with `openssl rand -base64 48`. Open UDP/TCP 3478 and the
UDP media range in your firewall.

Then start the signaling service with the relay configured instead of
`YSHARE_NO_TURN`:

```bash
NODE_ENV=production \
TURN_SECRET='the same secret as static-auth-secret' \
TURN_HOST=signal.example.com \
TURN_PORT=3478 \
YSHARE_TLS_PROXY=1 \
YSHARE_TRUST_PROXY=1 \
PORT=8443 \
node server.js
```

YShare mints a fresh credential per room, valid for two hours by default, so no
long-lived relay password ever ships inside the app.

---

## Keeping it running

A minimal systemd unit, with the secrets in a root-only environment file
(`/etc/yshare-signal.env`, `chmod 600`) rather than in the unit itself:

```ini
[Unit]
Description=YShare signaling
After=network.target

[Service]
Type=simple
User=yshare
WorkingDirectory=/opt/YShare/signaling
EnvironmentFile=/etc/yshare-signal.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

---

## Settings reference

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8443` | Port to listen on. `0` picks a free one. |
| `NODE_ENV` | unset | `production` turns on the safety rules below. |
| `YSHARE_NO_TURN` | unset | `1` = signaling only. Mints no relay credentials. Cannot be combined with `TURN_SECRET`/`TURN_HOST`. |
| `TURN_SECRET` | — | coturn `static-auth-secret`. Required unless `YSHARE_NO_TURN=1`; at least 32 characters in production. |
| `TURN_HOST` | — | Public hostname or IP of your relay. Hostname or IP only — no scheme, no path. |
| `TURN_PORT` | `3478` | Relay port advertised to clients. |
| `TURN_TTL_SECS` | `7200` | Lifetime of a minted relay credential. Maximum 6 hours. |
| `YSHARE_TLS_PROXY` | unset | Must be `1` in production: you confirm a proxy terminates TLS. |
| `YSHARE_TRUST_PROXY` | unset | Must be `1` in production: trust `X-Real-IP` from the loopback proxy. |
| `YSHARE_BIND_HOST` | `0.0.0.0`, or `127.0.0.1` in production | Interface to bind. Production accepts loopback only. |
| `YSHARE_ENABLE_TURN_HTTP` | unset | `1` exposes `GET /turn` for local testing. Refused outside development/test. |
| `YSHARE_MAX_ROOMS` | `500` | Live rooms allowed at once. |
| `YSHARE_MAX_CONNECTIONS` | `2000` | Total WebSocket connections. |
| `YSHARE_MAX_CONNECTIONS_PER_IP` | `40` | Per-address connection cap. |
| `YSHARE_MAX_MSG_BYTES` | `131072` | Largest accepted WebSocket message. |
| `YSHARE_CREATE_PER_MIN` | `10` | Room creations per address per minute. |
| `YSHARE_JOIN_PER_MIN` | `30` | Joins per address per minute. |
| `YSHARE_MESSAGE_PER_MIN` | `120` | Relayed messages per address per minute. |
| `YSHARE_UNKNOWN_PER_MIN` | `20` | Unrecognised messages before an address is cut off. |
| `YSHARE_TURN_PER_MIN` | `10` | `GET /turn` requests per address per minute. |

Endpoints: `GET /health`, WebSocket on `/` or `/signal`. `GET /turn` exists only
when explicitly enabled outside production.

---

## Local testing

For development you can skip TLS entirely, because YShare allows cleartext to
your own machine:

```bash
cd signaling
YSHARE_NO_TURN=1 PORT=8443 NODE_ENV=development node server.js
```

Then set the server in the app to `ws://localhost:8443`. For a phone connected by
USB, forward the port to the device first:

```bash
adb reverse tcp:8443 tcp:8443
```

Cleartext to any *other* host is refused by both apps and by the desktop
Content-Security-Policy, so a half-configured server cannot quietly downgrade a
real transfer.

---

## Before you share your server with other people

- Every person you give the address to can create rooms and use your bandwidth.
- Room codes are short invitations, not identity. Anyone holding a live code may
  try to join, which is why the receiving side must still tap Accept.
- If you enable a relay, watch your traffic bill for the first weeks.
- Keep `TURN_SECRET` out of Git. Rotate it if it leaks; existing credentials
  expire on their own within `TURN_TTL_SECS`.
