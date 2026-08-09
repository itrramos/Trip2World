# Mobile

## Current state: PWA, not native

There is **no `apps/mobile`**. Trip2World on a phone is the web app, and that is a
deliberate choice rather than an omission.

The web client already does everything a mobile user needs: `getUserMedia` with
orientation-aware capture, front/back camera switching via `replaceTrack`, hardware zoom
where the platform exposes it, and a full WebRTC peer connection. It has been tested
working on Android Chrome.

Building a native client is a large, separate project — `react-native-webrtc` cannot run in
Expo Go, so it needs custom development builds, native toolchains (Xcode and Android
Studio), and App Store and Play accounts. Starting it before the web product was complete
would have stalled everything else.

---

## Making the PWA good on a phone

Already done:

| Item | Where |
| --- | --- |
| Web manifest, standalone display, `start_url: /discover` | `apps/web/src/app/manifest.webmanifest/route.ts` |
| Maskable icon for Android's adaptive shapes | `apps/web/public/icon-maskable.svg` |
| `viewport-fit=cover` for notches | `apps/web/src/app/layout.tsx` |
| Pinch-zoom left enabled (disabling it is a WCAG failure) | same |
| Portrait-first capture constraints | `apps/web/src/lib/media.ts` |
| Control bar wraps rather than overflowing | `apps/web/src/app/discover/page.tsx` |
| `playsInline` on every video element | required, or iOS Safari takes over fullscreen |

Not yet done, in rough priority order:

1. **Service worker.** The app shell should load offline and show a proper offline state
   rather than the browser's dinosaur. Must **never** cache authenticated API responses or
   anything session-related.
2. **iOS Safari verification.** Untested. WebKit is the only engine on iOS, its autoplay
   and audio-session rules differ meaningfully from Chromium's, and this is the largest
   known coverage gap.
3. **Wake lock.** The screen sleeps mid-conversation. `navigator.wakeLock` addresses it
   where supported.
4. **Safe-area padding** on the control bar for gesture-navigation devices.
5. **Install prompt.** Capture `beforeinstallprompt` and offer installation at a sensible
   moment, rather than never.

---

## If you do build native later

The groundwork is deliberately in place. `packages/types`, `packages/shared` and
`packages/validation` are **isomorphic** — no Node built-ins, no DOM globals — precisely so
the React Native bundler can consume them. A native client would share the session state
machine, matchmaking types, the realtime protocol contract, and every validation schema.
Anything requiring `node:crypto` lives in `packages/auth`, which is server-only.

What would need writing:

- `react-native-webrtc` peer connection, replacing the browser `RTCPeerConnection`.
- `expo-secure-store` or Keychain/Keystore for the refresh token, replacing the HttpOnly
  cookie. **This is the important difference:** native clients have no cookie jar, which is
  why `AuthTokens.refreshToken` is optional in the contract and why the API returns it in
  the body for `?client=native`.
- Native camera and microphone permission flows.
- Push notifications, for connection requests and moderation outcomes.
- Deep links, so a verification email opens the app rather than a browser.

### Two things that will bite

**App Store review.** Random video chat with strangers attracts elevated scrutiny under
Apple's UGC rules (guideline 1.2). Expect to need: a visible reporting mechanism, blocking,
a published moderation policy, and evidence of an active moderation process. Trip2World has
all four — but be ready to demonstrate them.

**In-app purchase.** Apple and Google require their own billing for digital goods, and
tokens are digital goods. You cannot use Stripe Checkout inside the app. That means a
second `BillingProvider` implementation and their 15–30% cut, which materially changes the
economics of the token model. `BillingProvider` already has `APPLE` and `GOOGLE` members
for this reason.

---

## Testing on a real device

The web app must be served over HTTPS — `getUserMedia` is unavailable otherwise, and
`localhost` is only exempt on the device itself.

Against the deployed instance:

```
https://trip2world.net
```

Against a local dev server, use a tunnel rather than an IP:

```bash
cloudflared tunnel --url http://localhost:3000
```

Remote-debug Android Chrome at `chrome://inspect`, and iOS Safari via Safari's Develop menu
with Web Inspector enabled on the device.

See `docs/WEBRTC.md` for the full device matrix and the TURN verification procedure —
mobile carriers are the most common source of symmetric NAT, so a phone on mobile data is
the single most valuable relay test you can run.
