# WebRTC

How a Trip2World conversation is established, and how to diagnose one that is not.

---

## The shape of a call

Media is **peer-to-peer**. Video and audio travel directly between the two participants;
the server never receives, stores, or is capable of reading them. What the server does is
relay the handshake — SDP offers, answers, and ICE candidates — and decide who is talking
to whom.

```
Alice                    realtime service                    Bob
  │                             │                             │
  │──── queue:join ────────────>│                             │
  │                             │<──────────── queue:join ────│
  │                        [matchmaker pairs]                 │
  │<─── match:found ───────────│──── match:found ───────────>│
  │     isInitiator: true      │      isInitiator: false      │
  │                            │                              │
  │──── webrtc:offer ─────────>│──── webrtc:offer ──────────>│
  │<─── webrtc:answer ─────────│<─── webrtc:answer ──────────│
  │<══> webrtc:ice (both directions, repeatedly) <═══════════>│
  │                            │                              │
  │◄════════════ media, peer-to-peer ═══════════════════════►│
```

### Exactly one side offers

`match:found` carries `isInitiator`, decided server-side. Only that peer calls
`createOffer`. This removes glare — the collision where both peers offer simultaneously
and one has to roll back — rather than detecting and resolving it. There is no
`onnegotiationneeded` handler by design.

### ICE candidates are buffered

Candidates routinely arrive before the remote description has been applied. Calling
`addIceCandidate` in that window throws, and the connection then simply never completes,
with no error surfaced anywhere. The client buffers early candidates in
`pendingCandidatesRef` and flushes them immediately after `setRemoteDescription`.

If you are debugging a call that reaches `connecting` and stops there, this is the first
thing to check in any client you write against this protocol.

### Signaling is authorised per frame

Every `webrtc:*` frame is checked against the Redis match registry: the sender must be a
participant of the `matchId` they claim. Trusting the client's `matchId` would let anyone
inject SDP into a stranger's conversation — both a hijack primitive and a way to harvest
the target's IP from their candidates.

SDP is also size-capped and required to begin with `v=0`. Without that, the signaling
channel is a general-purpose text relay between two strangers, i.e. an unmoderated chat
that bypasses every safety control.

---

## STUN, TURN, and why TURN is not optional

Most peers cannot reach each other directly. The ICE process tries, in order:

| Candidate type | What it is | Works when |
| --- | --- | --- |
| `host` | The device's own LAN address | Both peers on the same network |
| `srflx` | Public address discovered via STUN | NAT is cone-shaped and predictable |
| `relay` | Traffic forwarded by a TURN server | Always — it is the fallback |

**Symmetric NAT defeats STUN.** It allocates a different external port per destination, so
the address discovered via STUN is useless to the other peer. This is common on mobile
carriers, most corporate networks, and some ISP-supplied routers. Those users connect only
through TURN.

That is why `TURN_DOMAIN` is a hard requirement in production — the API refuses to start
without it. A STUN-only deployment appears to work in testing (you and your test device
are usually on the same network) and silently fails for a meaningful slice of real users.

### Ephemeral credentials

TURN relay bandwidth is the most expensive resource in this stack, and a static credential
shipped to the browser is a free, unmetered relay for anyone who opens devtools.

Trip2World uses coturn's REST authentication (`use-auth-secret`):

```
username   = "<unix-expiry>:<userId>"
credential = base64( HMAC-SHA1( TURN_SECRET, username ) )
```

coturn recomputes the same HMAC on connect and rejects anything whose embedded timestamp
has passed. Nothing is provisioned, nothing needs revoking, and a leaked credential is
useless within two hours. The secret never leaves the server.

HMAC-SHA1 is not a free choice — it is what the coturn REST scheme specifies. It is used
as a MAC with a high-entropy key, which is unaffected by SHA-1's collision weaknesses.

Implementation: `packages/auth/src/turn.ts`. The test there reimplements coturn's own
verification to prove the derivation matches.

---

## Network requirements

TURN is UDP. **Cloudflare's proxy cannot carry it, and neither can a tunnel.** The
`turn` DNS record must be grey-cloud (DNS only) and these ports must reach the host
directly:

| Port | Protocol | Purpose |
| --- | --- | --- |
| 3478 | UDP + TCP | STUN and TURN |
| 5349 | TCP | TURN over TLS (only if `TURN_ENABLE_TLS=true`) |
| 49160–49200 | UDP | Relay allocation range |

`TURN_EXTERNAL_IP` must be the host's **public** address. Behind NAT, coturn otherwise
advertises the container's private address in its relay candidates. Those are unroutable
from the internet, so every relayed call fails while the logs look entirely healthy.

---

## Verifying TURN actually works

This is the check that automated tests cannot perform, and the one most worth doing.

1. Open the [Trickle ICE tester](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/).
2. Fetch a real credential — sign in and call `GET /api/v1/ice/servers`, or read one from
   the browser console during a call.
3. Enter the TURN URI, username and credential. Remove the default Google STUN entry.
4. Press **Gather candidates**.

**You must see at least one candidate of type `relay`.** If you see only `host` and
`srflx`, TURN is not reachable and symmetric-NAT users will never connect.

To confirm a live call actually used the relay, check `candidateType` on the
`match_participants` row — the client reports it via `stats:report`. A sudden rise in
`relay` across the population usually means STUN is being blocked somewhere upstream.

---

## Device matrix

Automated E2E uses Chromium's `--use-fake-device-for-media-stream`, which is enough to
negotiate a genuine peer connection but tests **neither real hardware nor real network
conditions**. The following has to be done by hand before a release.

| Platform | Browser | What specifically to check |
| --- | --- | --- |
| Windows | Chrome, Edge | Camera picker; another app holding the camera → `DEVICE_BUSY` copy |
| macOS | Safari | Safari's stricter autoplay rules; audio actually audible |
| macOS | Chrome | Baseline |
| iOS | Safari | **Only WebKit exists on iOS.** `playsInline` must be honoured, no fullscreen takeover |
| Android | Chrome | Front/back switch mid-call; zoom slider present |
| Android | Firefox | No zoom capability — the control must be absent, not broken |

Network conditions worth testing deliberately:

- Both peers on the same Wi-Fi (expect `host` or `srflx`)
- One peer on mobile data (expect `relay` on many carriers)
- One peer on a corporate or hotel network (expect `relay`, often TCP)
- Mid-call Wi-Fi → mobile handover (expect a brief `disconnected`, then recovery)

That last one exercises the bounded reconnect: `disconnected` is treated as transient and
given a recovery window, while `failed` is terminal. Ending the call immediately on
`disconnected` would drop conversations every time someone walked between two access
points.

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Stuck on "Connecting…" for everyone | Realtime service unreachable, or the WebSocket is failing to upgrade — check for repeated long-polls in devtools |
| Stuck for *some* users only | TURN unreachable, proxied, or `TURN_EXTERNAL_IP` wrong |
| Connects then drops after ~20s | Negotiation deadline fired; ICE never completed. Check candidate gathering |
| Video one way only | One peer's tracks were not added before `createOffer`, or their camera is disabled |
| Echo | Local preview is not muted. It must always be `muted` — an unmuted self-view is a feedback loop |
| Remote video hugely zoomed | Display used `object-cover` on a portrait stream, or capture constraints requested a landscape resolution on a portrait device |
| Black remote video, audio fine | Camera track disabled on the far side, or a decoder failure — check `inbound-rtp` stats |

Useful client-side probe:

```js
const stats = await peerConnection.getStats();
stats.forEach((r) => {
  if (r.type === 'candidate-pair' && r.state === 'succeeded') console.log('pair', r);
  if (r.type === 'local-candidate') console.log('local', r.candidateType);
});
```

---

## Related

- `apps/web/src/hooks/use-conversation.ts` — the client state machine and peer lifecycle
- `apps/web/src/lib/media.ts` — capture constraints, zoom, camera switching
- `apps/realtime/src/server.ts` — signaling relay and per-frame authorisation
- `packages/auth/src/turn.ts` — credential derivation
- `infrastructure/coturn/turnserver.conf` — relay configuration and abuse limits
