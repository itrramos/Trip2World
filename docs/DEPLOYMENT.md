# Deploying Trip2World

Written for the reference deployment: an Ubuntu VPS running CasaOS, with `trip2fun.com`
on Cloudflare and an **existing** Cloudflare Tunnel providing ingress.

---

## 1. What you are deploying

| Hostname | Reaches | Serves |
| --- | --- | --- |
| `call.trip2fun.com` | host port **8181** | Web app, HTTP API, realtime WebSocket |
| `admin.trip2fun.com` | host port **8182** | Admin panel, HTTP API (same container) |
| `turn.trip2fun.com` | UDP/TCP **3478** direct | coturn STUN/TURN. **Must bypass Cloudflare.** |

Nine containers behind one Caddy instance. Only Caddy (8181, 8182) and coturn are
reachable from outside the Docker network; Postgres, Redis and every application
container stay internal and are never published to the host.

Trip2World does **not** bundle a tunnel. Ingress is yours, managed outside this stack.

---

## 2. Ingress

Your existing Cloudflare Tunnel maps two host ports to two public hostnames. The service
target depends on where `cloudflared` runs:

| Public hostname | cloudflared on this host | cloudflared elsewhere |
| --- | --- | --- |
| `call.trip2fun.com` | `http://localhost:8181` | `http://<vps-public-ip>:8181` |
| `admin.trip2fun.com` | `http://localhost:8182` | `http://<vps-public-ip>:8182` |

In the reference deployment cloudflared runs on a **different machine**, so the targets are
the VPS public IP and `BIND_ADDRESS=0.0.0.0`. That combination means the ports are
internet-facing — see the warning below.

Cloudflare terminates TLS. Caddy speaks plain HTTP behind it and routes by **port**, not
by `Host` header — so the admin panel cannot be reached by spoofing a `Host` header at
the public port.

Add both as public hostnames on your tunnel; Cloudflare creates the DNS records
automatically. `http://localhost:8181` is a *service target* inside the tunnel
configuration, not a DNS value — pasting it into a CNAME's Target field is rejected with
"Content for CNAME record is invalid", because a CNAME must point at a hostname.

### Bind address — the decision that matters here

`BIND_ADDRESS` in `.env` controls which host interface Caddy attaches to.

**`127.0.0.1` (default, recommended).** The tunnel becomes the only way in. Nobody can
reach the app — or the admin panel — by hitting the VPS public IP directly, so
Cloudflare, and any Access policy on `admin.trip2fun.com`, cannot be bypassed. Requires
cloudflared to run on the same host, which is the normal setup. Point the tunnel at
`http://localhost:8181` and `http://localhost:8182`.

**`0.0.0.0`.** Required when cloudflared runs elsewhere, which is the case in the
reference deployment.

The ports are then internet-facing. `http://<vps-ip>:8182` serves the **moderation panel
login** to anyone who port-scans that address — bypassing Cloudflare and any Access policy
on the hostname. This is not theoretical: 8181/8182 on a public VPS will be scanned within
hours.

Two mitigations, and you want both:

```bash
# 1. Only the tunnel host may reach these ports.
sudo ufw delete allow 8182/tcp 2>/dev/null || true
sudo ufw allow from <TUNNEL_HOST_IP> to any port 8181 proto tcp comment 'Trip2World app'
sudo ufw allow from <TUNNEL_HOST_IP> to any port 8182 proto tcp comment 'Trip2World admin'
```

2. A **Cloudflare Access** policy in front of `admin.trip2fun.com` (Zero Trust →
   Access → Applications). Free at this scale, and it puts an independent authentication
   layer ahead of the panel so a stolen moderator password is not sufficient on its own.

If cloudflared runs as a container on the same host, either attach it to this stack's
`edge` network (then target `http://caddy:8181`) or give it `network_mode: host` and keep
`127.0.0.1`.

### Why the admin panel gets its own port

An origin is the browser's security boundary. On `admin.trip2fun.com` the admin session
cookie is never attached to a request made by code running on `call.trip2fun.com`, so a
cross-site scripting flaw in the public bundle cannot ride a moderator's session to ban
accounts or read reports.

That only holds if the admin UI authenticates **same-origin**, which is why Caddy serves
`/api/*` on both ports, pointing at the same `api` container. Neither cookie is set with
`Domain=.trip2fun.com`, which would hand it to every subdomain and undo the arrangement.

Consider putting a Cloudflare Access policy in front of `admin.trip2fun.com`. It costs
nothing at this scale and puts an independent authentication layer ahead of the panel.

---

## 3. DNS records

Your tunnel creates `call` and `admin` when you add the public hostnames above. Do not
create those by hand.

The **only** record you create manually:

| Name | Type | Value | Proxy |
| --- | --- | --- | --- |
| `turn` | **A** | your VPS public IP | grey cloud — **DNS only** |

### TURN must not be proxied or tunnelled

TURN is UDP. Cloudflare's proxy carries HTTP and WebSocket only, and a tunnel cannot
carry it either. A proxied `turn` record does not "work a bit worse" — it does not work
at all, and the symptom is confusing: most calls succeed (those that negotiated a direct
path via STUN) while a subset silently never connect.

The users who need TURN are those behind symmetric NAT: most mobile carriers, many
corporate networks, some ISP routers. That is a substantial minority of real traffic, and
without a reachable relay they see a permanent "connecting…" state.

**Ports that must reach the VPS directly:**

| Port | Protocol | Purpose |
| --- | --- | --- |
| 3478 | UDP + TCP | STUN / TURN |
| 5349 | TCP | TURN over TLS (only if `TURN_ENABLE_TLS=true`) |
| 49160–49200 | UDP | Relay allocation range |

Also set `TURN_EXTERNAL_IP` to your VPS public IP. coturn otherwise advertises the
container's private address in its relay candidates, which is unroutable from the
internet — every relayed call then fails while the logs look perfectly healthy.

---

## 4. Email via Gmail

Verification and password reset need outbound SMTP. Cloudflare does not provide it.

1. Enable **2-Step Verification** on the Google account.
2. Create an **App Password** at <https://myaccount.google.com/apppasswords>.
   Google removed plain-password SMTP; your normal password will be rejected.
3. Fill in `.env`:

```ini
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-account@gmail.com
SMTP_PASSWORD=<the 16-character app password>
SMTP_SECURE=false
MAIL_FROM="Trip2World <your-account@gmail.com>"
```

Three Gmail-specific gotchas:

- **`MAIL_FROM` must match the account** (or a verified "Send mail as" alias). Gmail
  rewrites the `From` header on anything else, breaking SPF/DKIM alignment and pushing
  verification mail to spam. It is "delivered", just never seen.
- **`SMTP_SECURE=false` is correct for port 587** (STARTTLS). Set it `true` only if you
  move to implicit TLS on 465. Getting this backwards produces a connection that hangs
  until timeout rather than a clear error.
- **Gmail caps sending** at roughly 500 recipients/day (consumer) or 2000 (Workspace).
  Fine to launch on; a signup spike will hit it and verification mail starts bouncing.
  Move to a transactional provider before you need to.

To test matchmaking before mail works, set `REQUIRE_EMAIL_VERIFICATION=false` — new
accounts are then usable immediately. Turn it back on before you are publicly reachable,
or you are accepting registrations on unverified addresses.

---

## 5. First deployment (Ubuntu + CasaOS)

Persistent data lives at `/DATA/AppData/Trip2World`, the CasaOS convention. Postgres,
Redis and Caddy bind-mount subdirectories of it, so it is the single path to back up and
the single path to restore into. It also means the data survives `docker compose down -v`,
which would silently destroy a named volume.

The trade-off is that those directories must exist with the right ownership **before**
the first start — Postgres refuses to start on a directory it does not own and reports it
as "data directory has invalid permissions", which reads like corruption.

```bash
sudo mkdir -p /DATA/AppData/Trip2World
sudo chown "$USER":"$USER" /DATA/AppData/Trip2World
cd /DATA/AppData/Trip2World

git clone <your-repo> app && cd app

# Git does not carry the executable bit unless it is set in the index. If you
# uploaded rather than cloned, run this after every upload.
chmod +x infrastructure/scripts/*.sh

# Creates data directories with correct ownership, applies kernel tuning for many
# long-lived WebSocket connections, and opens ONLY the TURN ports if ufw is active.
sudo ./infrastructure/scripts/setup-casaos.sh

cp .env.example .env
node infrastructure/scripts/generate-secrets.mjs
```

Then edit `.env` for the values a script cannot know:

| Variable | Value |
| --- | --- |
| `TURN_EXTERNAL_IP` | `curl -s ifconfig.me` — your VPS public IP |
| `SMTP_USER` / `SMTP_PASSWORD` | Gmail address + 16-character App Password |
| `MAIL_FROM` | must match `SMTP_USER` or a verified alias |
| `BIND_ADDRESS` | leave at `127.0.0.1` unless cloudflared runs elsewhere |

Bring it up:

```bash
docker compose up -d
docker compose logs -f migrate     # confirm migrations applied cleanly
```

Create the first administrator. There is deliberately no default admin account and no
default password anywhere in this repository or in the images:

```bash
docker compose exec api pnpm admin:create
```

---

## 6. Portainer

**Stacks → Add stack → Repository**

- Repository URL: your fork
- Compose path: `docker-compose.yml`
- Load the contents of your `.env` into the stack's **Environment variables**

Portainer does not read a `.env` file from the repository, so the variables must be
pasted into the stack environment. Everything in `.env.example` is documented inline for
exactly this reason.

---

## 7. Verifying it actually works

Health endpoints, from the host:

```bash
curl -s localhost:8181/healthz        # public port
curl -s localhost:8182/healthz        # admin port
docker compose exec api      wget -qO- localhost:4000/ready
docker compose exec realtime wget -qO- localhost:4001/health
```

Then confirm the parts that fail silently:

1. **End to end through the tunnel.**
   `curl -s -o /dev/null -w '%{http_code}\n' https://call.trip2fun.com/api/v1/ice/servers`
   should return **401** — proving DNS, the tunnel, Caddy routing and the API all work,
   and that the endpoint correctly refused an unauthenticated request. `530`/`1033` means
   the tunnel is not connected; `502` means cloudflared reached Caddy but Caddy could not
   reach the API.

2. **Port isolation.** `curl -s -o /dev/null -w '%{http_code}\n' https://call.trip2fun.com/admin`
   should be **404**, not the admin panel. The admin app is only on 8182.

3. **WebSocket upgrade.** Open `https://call.trip2fun.com`, devtools → Network → WS. You
   should see `/rt` connected, not a repeating long-poll. A failed upgrade still "works"
   via polling but adds a round trip to every signaling message.

4. **TURN reachability.** Paste your ICE config into the
   [Trickle ICE tester](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/).
   You must see at least one candidate of type `relay`. Only `host` and `srflx` means
   TURN is unreachable and symmetric-NAT users will never connect.

5. **Two-browser match.** Sign in as two different accounts in two browser profiles (not
   two tabs of the same session) and confirm video both ways, then that **Next** tears
   down and rematches.

---

## 8. Updating

```bash
git pull
docker compose build
docker compose up -d
```

The `migrate` service runs `prisma migrate deploy` and exits before the applications
start, so a release cannot begin serving against an old schema.

---

## 9. Backups

Postgres is the only thing that must be backed up. Redis holds exclusively ephemeral
state — queues, presence, match locks — and losing it on a restart is expected: clients
simply re-enter matchmaking.

```bash
./infrastructure/scripts/backup.sh
./infrastructure/scripts/restore.sh trip2world-20260808-030000.tar.gz
```

Nightly at 03:00:

```bash
(crontab -l 2>/dev/null; echo "0 3 * * * cd /DATA/AppData/Trip2World/app && ./infrastructure/scripts/backup.sh >> /DATA/AppData/Trip2World/backups/cron.log 2>&1") | crontab -
```

The archive contains your `.env` and is written mode 0600. Copy it off the machine — a
backup on the same disk is not a backup.

---

## 10. Troubleshooting

| Symptom | Cause |
| --- | --- |
| Cloudflare 530 / 1033 | Tunnel not connected. Check `cloudflared` on the host. |
| Cloudflare 502 | Tunnel reached Caddy, but the target service is down. `docker compose ps`. |
| Tunnel cannot connect to `localhost:8181` | cloudflared is containerised and cannot see the host loopback. Use `network_mode: host`, or set `BIND_ADDRESS=0.0.0.0`. |
| Login succeeds then immediately logs out | `APP_URL` is `http://`, or `TRUST_PROXY=false`. Secure cookies are dropped without a trusted `https` scheme. |
| Some users stuck on "connecting…" | TURN unreachable, proxied, or `TURN_EXTERNAL_IP` unset/wrong. |
| Verification email never arrives | Account password used instead of an App Password, or `MAIL_FROM` does not match the Gmail account. |
| Admin panel rejects a valid login | `CORS_ALLOWED_ORIGINS` missing `https://admin.trip2fun.com`. |
| `Permission denied` running a script | `chmod +x infrastructure/scripts/*.sh` — the executable bit is not carried by upload. |
| Postgres won't start, "invalid permissions" | Data directory ownership. Re-run `sudo ./infrastructure/scripts/setup-casaos.sh`. |
