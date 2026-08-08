# Deploying Trip2World

Written for the reference deployment: a ZimaOS box behind a domestic connection,
`trip2fun.com` on Cloudflare, everything served through one host port — **8181**.

---

## 1. What you are deploying

| Hostname | Serves |
| --- | --- |
| `call.trip2fun.com` | Web app, HTTP API, realtime WebSocket |
| `admin.trip2fun.com` | Admin panel, HTTP API (same container) |
| `turn.trip2fun.com` | coturn — STUN/TURN. **Must bypass Cloudflare.** |

Ten containers behind one Caddy instance. Only Caddy (8181) and coturn are
reachable from outside; Postgres, Redis and every application container stay on
the internal Docker network.

### Why the admin panel gets its own hostname

An origin is the browser's security boundary. With the admin panel on
`admin.trip2fun.com`, its session cookie is never attached to a request made by
code running on `call.trip2fun.com` — so a cross-site scripting flaw in the
public web bundle cannot ride a moderator's session to ban accounts or read
reports.

That only holds if the admin UI can authenticate *without* a cross-origin
request, which is why Caddy serves `/api/*` under **both** hostnames, pointing at
the same `api` container. Each panel calls its own origin, each cookie is
host-scoped, and neither is set with `Domain=.trip2fun.com` (which would hand the
cookie back to every subdomain and undo the whole arrangement).

---

## 2. The Cloudflare port problem, and the three ways around it

**Cloudflare's proxy will not connect to origin port 8181.** With the orange
cloud enabled it only dials a fixed list:

- HTTP: `80, 8080, 8880, 2052, 2082, 2086, 2095`
- HTTPS: `443, 2053, 2083, 2087, 2096, 8443`

A proxied record pointing at `:8181` returns a 52x error. Pick one of these:

### Mode A — Cloudflare Tunnel (recommended)

`DEPLOY_MODE=tunnel`

`cloudflared` dials **out** to Cloudflare, so no origin port is ever negotiated
and the restricted list simply does not apply. No port forwarding, no inbound
firewall rule, and it works behind CGNAT — which is the usual situation on a home
connection.

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel**.
2. Copy the tunnel token into `CLOUDFLARE_TUNNEL_TOKEN` in `.env`.
3. Add two public hostnames on the tunnel, both pointing at the same service:

   | Public hostname | Service |
   | --- | --- |
   | `call.trip2fun.com` | `http://caddy:8181` |
   | `admin.trip2fun.com` | `http://caddy:8181` |

4. Start with the profile enabled:

```bash
docker compose --profile tunnel up -d
```

Cloudflare creates the DNS records for you. Caddy still routes by `Host`, so both
hostnames land on the right application.

### Mode B — Proxied DNS + port forward

`DEPLOY_MODE=proxied`

Orange-cloud both records. Your router must present **443 externally** and
forward to `8181` on the ZimaOS host. Cloudflare connects to 443 (allowed), your
router translates to 8181. Requires a static or dynamic-DNS-updated WAN IP and
does not work behind CGNAT.

### Mode C — Direct

`DEPLOY_MODE=direct`

Grey-cloud both records. Caddy obtains its own certificates. The HTTP-01
challenge cannot work on a non-standard port, so you need the **DNS-01**
challenge: a Cloudflare API token with `Zone:DNS:Edit`, and the
`caddy-dns/cloudflare` plugin compiled into the Caddy image. See the commented
block at the foot of `infrastructure/caddy/Caddyfile`. Publish `443:443` instead
of `8181:8181`.

---

## 3. DNS records

| Name | Type | Value | Proxy | Notes |
| --- | --- | --- | --- | --- |
| `call` | CNAME/A | tunnel or WAN IP | 🟠 orange (A/B), grey (C) | Web app |
| `admin` | CNAME/A | tunnel or WAN IP | 🟠 orange (A/B), grey (C) | Admin panel |
| `turn` | **A** | **your WAN IP** | ⚪ **grey — DNS only** | **Never proxy this** |

### TURN must not be proxied — this is not optional

TURN is UDP. Cloudflare's proxy carries HTTP and WebSocket only. A proxied
`turn` record does not "work a bit worse"; it does not work at all, and the
symptom is confusing — most calls succeed (those are the ones that negotiated a
direct path via STUN) while a subset silently never connect.

The users who need TURN are those behind symmetric NAT: most mobile carriers,
many corporate networks, and some ISP-supplied routers. That is a substantial
minority of real traffic, and without a reachable relay they see a permanent
"connecting…" state.

**Required port forwards to the ZimaOS host:**

| Port | Protocol | Purpose |
| --- | --- | --- |
| 3478 | UDP + TCP | STUN / TURN |
| 5349 | TCP | TURN over TLS (only if `TURN_ENABLE_TLS=true`) |
| 49160–49200 | UDP | Relay allocation range |

Also set `TURN_EXTERNAL_IP` to your **WAN address**. Behind NAT, coturn otherwise
advertises the container's private address in its relay candidates, which are
unroutable from the internet — every relayed call then fails while the logs look
healthy.

If you are behind CGNAT and cannot forward ports, self-hosted TURN is not
possible. Use a hosted provider (Cloudflare Calls TURN, Twilio, Metered) and
point `TURN_DOMAIN` at it — the credential interface in
`packages/auth/src/turn.ts` is the standard REST scheme and works unchanged.

---

## 4. Email via Gmail

Verification and password reset need outbound SMTP. Cloudflare does not offer it.

1. Enable **2-Step Verification** on the Google account.
2. Create an **App Password** at <https://myaccount.google.com/apppasswords>.
   Google removed plain-password SMTP; your normal password will be rejected.
3. Fill in `.env`:

```ini
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-account@gmail.com
SMTP_PASSWORD=<the 16-character app password>
SMTP_SECURE=false          # STARTTLS on 587
MAIL_FROM="Trip2World <your-account@gmail.com>"
```

Three Gmail-specific gotchas:

- **`MAIL_FROM` must match the account** (or a verified "Send mail as" alias).
  Gmail rewrites the `From` header on anything else, breaking SPF/DKIM alignment
  and pushing your verification mail to spam.
- **`SMTP_SECURE=false` is correct for port 587.** Set it `true` only if you move
  to implicit TLS on 465. Getting this backwards produces a connection that hangs
  rather than a clear error.
- **Gmail caps sending** at roughly 500 recipients/day (consumer) or 2000
  (Workspace). Fine to launch on; a signup spike will hit it and verification
  mail will start bouncing. Move to a transactional provider before you need to.

To test matchmaking before mail is working, set
`REQUIRE_EMAIL_VERIFICATION=false` — new accounts are then usable immediately.
Turn it back on before you are publicly reachable, or you are accepting
registrations on unverified addresses.

---

## 5. First deployment (Ubuntu + CasaOS)

Persistent data lives at `/DATA/AppData/Trip2World`, the CasaOS convention. Postgres,
Redis and Caddy bind-mount subdirectories of it, so it is the single path to back up and
the single path to restore into. It also means the data survives
`docker compose down -v`, which would silently destroy a named volume.

The trade-off is that those directories must exist with the right ownership **before**
the first start — Postgres refuses to start on a directory it does not own, and reports
it as "data directory has invalid permissions", which reads like corruption.

```bash
sudo mkdir -p /DATA/AppData/Trip2World
sudo chown "$USER":"$USER" /DATA/AppData/Trip2World
cd /DATA/AppData/Trip2World

git clone <your-repo> app && cd app

# Creates the data directories with correct ownership, applies kernel tuning for
# many long-lived WebSocket connections, and opens firewall ports if ufw is active.
sudo ./infrastructure/scripts/setup-casaos.sh

cp .env.example .env
node infrastructure/scripts/generate-secrets.mjs
```

Then edit `.env` for the values a script cannot know:

| Variable | Value |
| --- | --- |
| `CLOUDFLARE_TUNNEL_TOKEN` | from the Cloudflare Zero Trust dashboard (Mode A) |
| `TURN_EXTERNAL_IP` | `curl -s ifconfig.me` — your VPS public IP |
| `SMTP_USER` / `SMTP_PASSWORD` | Gmail address + 16-character App Password |
| `MAIL_FROM` | must match `SMTP_USER` or a verified alias |

Bring it up:

```bash
docker compose --profile tunnel up -d
docker compose logs -f migrate     # confirm migrations applied cleanly
```

Create the first administrator. There is deliberately no default admin account
and no default password anywhere in this repository or in the images:

```bash
docker compose exec api pnpm admin:create
```

You will be prompted for email, username, display name and a password, entered
with echo suppressed. Sign in at `https://admin.trip2fun.com`.

---

## 6. Portainer

**Stacks → Add stack → Repository**

- Repository URL: your fork
- Compose path: `docker-compose.yml`
- Load the contents of your `.env` into the stack's **Environment variables**
- Enable the `tunnel` profile if using Mode A

Portainer does not read a `.env` file from the repository, so the variables must
be pasted into the stack environment. Everything in `.env.example` is documented
inline for exactly this reason.

---

## 7. Verifying it actually works

Health endpoints, from the host:

```bash
curl -s localhost:8181/healthz                          # Caddy itself
docker compose exec api      wget -qO- localhost:4000/health
docker compose exec realtime wget -qO- localhost:4001/health
```

Then confirm the parts that fail silently:

1. **WebSocket upgrade** — open `https://call.trip2fun.com`, devtools → Network →
   WS. You should see `/rt` connected, not a repeating long-poll. A failed
   upgrade still "works" via polling but adds latency to every signaling message.
2. **TURN reachability** — paste your ICE config into the
   [Trickle ICE tester](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/).
   You must see at least one candidate of type `relay`. If you only see `host`
   and `srflx`, TURN is not reachable and symmetric-NAT users will not connect.
3. **Two-browser match** — sign in as two different accounts in two profiles (not
   two tabs of the same session) and confirm video both ways, then that **Next**
   tears down and rematches.

---

## 8. Updating

```bash
git pull
docker compose build
docker compose up -d
```

The `migrate` service runs `prisma migrate deploy` and exits before the
applications start, so a release cannot begin serving against an old schema.

## 9. Backups

Postgres is the only thing that must be backed up. Redis holds exclusively
ephemeral state — queues, presence, match locks — and losing it on a restart is
expected: clients simply re-enter matchmaking. See `docs/BACKUP_RESTORE.md` and
`infrastructure/scripts/backup.sh`.

---

## 10. Troubleshooting

| Symptom | Cause |
| --- | --- |
| Cloudflare 521/522 | Proxied record pointing at `:8181`. Use Mode A, or forward 443→8181. |
| Login succeeds then immediately logs out | `APP_URL` is `http://`. Secure cookies are dropped over plain HTTP. |
| Some users stuck on "connecting…" | TURN unreachable, proxied, or `TURN_EXTERNAL_IP` unset/wrong. |
| Verification email never arrives | Using account password instead of an App Password, or `MAIL_FROM` does not match the Gmail account. |
| Admin panel rejects a valid login | `CORS_ALLOWED_ORIGINS` missing `https://admin.trip2fun.com`. |
| `502` from Caddy on boot | An app container is still starting; Caddy waits on healthchecks. Check `docker compose ps`. |
