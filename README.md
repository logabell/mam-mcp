# mam-mcp

A remote [Model Context Protocol](https://modelcontextprotocol.io) (Streamable
HTTP) server that lets an AI agent **search MyAnonamouse** and **queue downloads**
through an existing [MouseSearch](https://github.com/sevenlayercookie/MouseSearch)
instance.

It is a small, stateless HTTP service. Run it on the same network as MouseSearch
for **LAN-only** use, or publish it behind a reverse proxy on a DNS name to drive
it from a hosted agent anywhere. Either way, the server authenticates callers with
a bearer token and keeps downloading as a separate, explicit step.

```
                            ┌─────────────┐        ┌──────────────┐
  agent harness ──Bearer──► │   mam-mcp   │──────► │  MouseSearch │──► qBittorrent
  (LAN or internet)         │  :8765/mcp  │        │  :5000       │
                            └──────┬──────┘        └──────┬───────┘
                                   │ MAM search API        │ same egress
                                   ▼                       ▼
                              MAM (via HTTP proxy)   qBittorrent
```

- **Search** runs inside the MCP using MAM's documented `loadSearchJSONbasic.php` API.
- **Downloads** are delegated to MouseSearch's `POST /client/add`, so buffer checks,
  freeleech handling, categories, path templates, and auto-organization behave
  exactly like a UI-initiated download.
- **Never** touches the MouseSearch web UI or its public/OIDC URL — it talks to
  MouseSearch's internal API only.

Jump to: [Deployment topologies](#deployment-topologies) ·
[Architecture](#architecture) · [Quick start](#quick-start) ·
[Configuration](#configuration-reference) · [Tools](#tools)

## Highlights

- **Full advanced search** — title/author/series/narrator/description/tags/filenames,
  category, subcategory, language, seeders/leechers/snatches, size, upload dates,
  browse flags, freeleech, sorting, paging.
- **Batch cart workflow** — add by full result, in a batch, or by MID; preview the
  buffer impact before committing; skip torrents already in your client.
- **Edition grouping** — pair the audiobook and ebook of the same title in one group.
- **Buffer-aware** — `cart_preview` splits free vs buffer-costing size and compares
  against your account buffer; `cart_download` refuses unparseable sizes and never
  silently bypasses MouseSearch's checks.
- **Freeleech transparency** — every result reports a derived `freeleech` kind
  (`free` / `vip` / `personal` / `none`) so nothing spends buffer or bonus wedges
  unexpectedly.
- **Stateless & proxy-friendly** — plain JSON-RPC responses, no long-lived SSE.

## Deployment topologies

**LAN-only.** The MCP and MouseSearch share a network; the agent runs on the same
LAN. Simplest and nothing is exposed to the internet.

```
agent (LAN) ──http──► mam-mcp :8765 ──http──► mousesearch :5000
```

**Public (remote agent).** Expose **only the MCP** through a reverse proxy with TLS;
keep MouseSearch internal.

```
agent (internet) ──https+Bearer──► reverse proxy ──http──► mam-mcp :8765 ──http──► mousesearch :5000
```

The bearer token (plus TLS, and ideally an IP allowlist) is the access control.
Do **not** put an interactive OIDC gateway in front of the MCP — MCP clients speak
bearer tokens, not browser logins. See [Exposing the MCP publicly](#exposing-the-mcp-publicly).

## Contents

- [Highlights](#highlights)
- [Deployment topologies](#deployment-topologies)
- [Requirements](#requirements)
- [Architecture](#architecture)
- [Quick start](#quick-start)
  - [1. Create a dedicated MAM session](#1-create-a-dedicated-mam-session)
  - [2. Generate an API token](#2-generate-an-api-token)
  - [3. Run the server](#3-run-the-server)
  - [4. Verify](#4-verify)
  - [5. Connect an agent harness](#5-connect-an-agent-harness)
- [Exposing the MCP publicly](#exposing-the-mcp-publicly)
- [Configuration reference](#configuration-reference)
- [Tools](#tools)
- [Usage workflow](#usage-workflow)
- [Intentional differences from the MouseSearch UI](#intentional-differences-from-the-mousesearch-ui)
- [Running from source](#running-from-source)
- [Troubleshooting](#troubleshooting)
- [Publishing the image](#publishing-the-image)
- [Security notes](#security-notes)
- [Compliance note](#compliance-note)

## Requirements

- An existing [MouseSearch](https://github.com/sevenlayercookie/MouseSearch)
  instance (it proxies MAM stats and the torrent client) with a reachable internal
  API.
- A qBittorrent client configured in MouseSearch.
- A MyAnonamouse account with a **dedicated** session cookie (see below).
- Docker (recommended) or Node.js >= 20 for [running from source](#running-from-source).
- Optional but recommended: an HTTP proxy (e.g. [gluetun](https://github.com/qdm12/gluetun))
  so MAM traffic and MouseSearch share the same egress IP/ASN.

## Architecture

```
agent harness ── Bearer token ──► mam-mcp :8765/mcp
                                     │
                    MAM search API ◄──┤ via MAM_PROXY_URL (dedicated session)
                    MouseSearch    ◄──┘ /client/add, /mam/user_data,
                                         /client/info/batch, /client/resolve_mid
```

- `search_mam` calls MAM's documented search API directly (through `MAM_PROXY_URL`).
- Everything else (account stats, client status, duplicate checks, adding torrents)
  goes to MouseSearch's internal endpoints.
- MouseSearch is addressed by its service name / internal host, so its public URL
  (and any OIDC gateway in front of it) is irrelevant to the MCP.
- MAM traffic uses the same proxy egress as MouseSearch, so both present the same
  public IP/ASN to the tracker and the dedicated session stays valid.

## Quick start

The image is published to GitHub Container Registry by
[`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml):

```
ghcr.io/logabell/mam-mcp:latest
```

If you prefer, [build the image locally](#running-from-source) instead of pulling.

1. Create a dedicated MAM session and copy its `mam_id`.
2. Generate an API token.
3. Add the `mam-mcp` service from [`compose.snippet.yaml`](compose.snippet.yaml)
   to your stack and `docker compose up -d mam-mcp`.
4. Hit `/healthz`, then point your agent at `http://<homelab-ip>:8765/mcp`.

### 1. Create a dedicated MAM session

On the MyAnonamouse [Security page](https://www.myanonamouse.net/preferences/index.php?view=security),
create a **second, dedicated** session:

| Setting | Value |
|---|---|
| Session label | `MouseSearch MCP` |
| IP or ASN | `ASN` (the VPN/proxy provider's ASN — more forgiving than a single IP) |
| Dynamic Seedbox | `No` |

Copy the `mam_id` value. This is `MAM_ID` / `MAM_MCP_ID`.

> **Do not reuse MouseSearch's cookie.** MAM rotates `mam_id` on every request;
> two apps sharing one session invalidate each other. Give each its own session.

The MCP persists any rotated `mam_id` to `MAM_STATE_FILE` (on the `mam-mcp-data`
volume), so restarts continue with the latest cookie. Supplying a new `MAM_ID`
always takes precedence and replaces the stored one.

### 2. Generate an API token

```bash
openssl rand -hex 32
```

Use it as `MCP_API_TOKEN` (and `MAM_MCP_TOKEN` in the compose snippet). The agent
must send it as `Authorization: Bearer <token>`. The token must be at least 16
characters or the server refuses to start.

### 3. Run the server

`mam-mcp` talks to MouseSearch and the MAM proxy **by their Docker service names**,
so the easiest install is to run it on the same network as your existing stack.

Create a directory (e.g. `~/docker/mam-mcp`) with a `docker-compose.yml`:

```yaml
# docker-compose.yml
services:
  mam-mcp:
    image: ghcr.io/logabell/mam-mcp:latest
    container_name: mam-mcp
    restart: unless-stopped
    networks:
      - stack
    ports:
      - "8765:8765"          # LAN access; put a reverse proxy in front for public use
    volumes:
      - mam-mcp-data:/data
    environment:
      - TZ=Etc/UTC
      - MAM_ID=${MAM_MCP_ID:?set MAM_MCP_ID in .env}
      - MAM_API_BASE=https://www.myanonamouse.net
      - MAM_PROXY_URL=http://gluetun:8888
      - MAM_STATE_FILE=/data/mam-state.json
      - CART_FILE=/data/cart.json
      - MOUSESEARCH_URL=http://mousesearch:5000
      - DEFAULT_CATEGORY=audiobooks
      - DEFAULT_LANGUAGE=English
      - MAX_RESULTS=50
      - MCP_HTTP_BIND=0.0.0.0:8765
      - MCP_API_TOKEN=${MAM_MCP_TOKEN:?set MAM_MCP_TOKEN in .env}
      - APP_LOG_LEVEL=INFO

networks:
  stack:
    external: true
    name: ${STACK_NETWORK:?set STACK_NETWORK in .env}

volumes:
  mam-mcp-data:
```

And a `.env` next to it (Compose loads it automatically):

```bash
STACK_NETWORK=<your existing stack's network; see `docker network ls`>
MAM_MCP_ID=<dedicated MAM session cookie from step 1>
MAM_MCP_TOKEN=<token from step 2>
```

Then start it:

```bash
docker compose up -d
docker compose logs -f mam-mcp
```

Adjust to match your environment:

- `MAM_PROXY_URL` — point at your HTTP proxy, or remove it if MAM is reached directly.
- `MOUSESEARCH_URL` — the internal address of MouseSearch.
- `TZ` — your timezone.

To build from a local checkout instead of pulling the image, replace `image:` with
`build: .`.

**Prefer to add it to an existing stack?** Copy just the `mam-mcp` service from
[`compose.snippet.yaml`](compose.snippet.yaml) into your stack's compose file (it
references `gluetun` and `mousesearch` directly). [`compose.standalone.yaml`](compose.standalone.yaml)
is the standalone example above as a ready-made file.

If the GHCR package is private, log Docker in once so it can pull:

```bash
echo <GITHUB_PAT> | docker login ghcr.io -u <github-user> --password-stdin
```

> **Common error:** `(root) Additional property mam-mcp is not allowed` means the
> `mam-mcp:` key is at the top level of the YAML rather than nested under
> `services:`. Keep the service block indented under the `services:` header.

### 4. Verify

Keep the token out of your shell history by sourcing a `.env` file rather than
putting it on the command line:

```bash
cat > .env <<'EOF'
MAM_MCP_URL=http://<homelab-ip>:8765/mcp
MAM_MCP_TOKEN=<MCP_API_TOKEN>
EOF
set -a && . ./.env && set +a

curl http://<homelab-ip>:8765/healthz
# {"status":"ok","service":"mam-mcp","version":"0.2.1"}

curl -s -X POST "$MAM_MCP_URL" \
  -H "Authorization: Bearer $MAM_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

The MCP SDK requires POST requests to advertise both `application/json` and
`text/event-stream` in `Accept`. This server is stateless and built with
`enableJsonResponse`, so the response body is a plain JSON-RPC object
(`Content-Type: application/json`) — no SSE parser is needed.

A `401` means the bearer token is wrong. A JSON-RPC result listing the tools means
you are ready to connect a harness. If `search_mam` returns an auth error later,
re-check that the MAM session's allowed IP/ASN matches the proxy egress.

### 5. Connect an agent harness

Endpoint: `http://<homelab-ip>:8765/mcp` (LAN) or `https://<mcp-host>/mcp`
(public — see [Exposing the MCP publicly](#exposing-the-mcp-publicly)).

Required headers on every request:

```
Authorization: Bearer <MCP_API_TOKEN>
Accept: application/json, text/event-stream
```

Both content types are required by the MCP SDK, but responses are plain JSON.
Generic remote MCP client config:

```json
{
  "mcpServers": {
    "mam": {
      "url": "http://<homelab-ip>:8765/mcp",
      "headers": { "Authorization": "Bearer <MCP_API_TOKEN>" }
    }
  }
}
```

## Exposing the MCP publicly

To use a hosted agent, publish **the MCP** on a DNS hostname and keep MouseSearch
internal.

### Where MouseSearch lives (`MOUSESEARCH_URL`)

`MOUSESEARCH_URL` is just a base URL — set it to wherever MouseSearch's **internal
API** is reachable from the MCP:

| Deployment | `MOUSESEARCH_URL` |
|---|---|
| Same Docker stack (default) | `http://mousesearch:5000` |
| MCP outside the stack, same LAN | `http://<homelab-ip>:<published-port>` |
| MouseSearch exposed publicly | **Don't** — use the internal address above |

Pointing `MOUSESEARCH_URL` at a MouseSearch hostname that sits behind an OIDC/SSO
gateway (e.g. the UI's public URL) will fail: the MCP's headless `/client/*` calls
get redirected to an HTML login page instead of returning JSON. The server detects
this and fails with a clear message telling you to use the internal address.

### Reverse proxy (example: Nginx Proxy Manager)

- **Proxy host:** `<mcp-host>` (create a DNS record for it)
- **Forward hostname/IP:** the `mam-mcp` container name (if the proxy shares the
  stack network) or the host LAN IP, **port:** `8765`, **scheme:** `http`
- **Custom location:** `/mcp` (optional; keeps the rest of the root unproxied)
- **Block common exploits:** on
- **SSL:** request a certificate, force SSL
- **Access list:** do **not** attach an interactive OIDC/OAuth gateway. An IP
  allowlist for your agent's egress is fine.
- Leave `Authorization` and `Accept` passing through untouched — the SDK requires
  `Accept` to include both `application/json` and `text/event-stream`.
- Websockets support is not required (the server returns plain JSON).
- Advanced (recommended):

  ```nginx
  # Optionally restrict to your known agent network / IPs.
  # allow 203.0.113.0/24;   # TEST-NET example range
  # deny all;

  client_max_body_size 4m;
  proxy_read_timeout 120s;
  ```

Then the harness URL becomes `https://<mcp-host>/mcp`:

```json
{
  "mcpServers": {
    "mam": {
      "url": "https://<mcp-host>/mcp",
      "headers": { "Authorization": "Bearer <MCP_API_TOKEN>" }
    }
  }
}
```

Verify the public endpoint:

```bash
curl -s https://<mcp-host>/healthz

curl -s -X POST https://<mcp-host>/mcp \
  -H "Authorization: Bearer $MCP_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `MAM_ID` | **required** | Dedicated MAM session cookie |
| `MCP_API_TOKEN` | **required** | Bearer token (>= 16 chars) |
| `MAM_API_BASE` | `https://www.myanonamouse.net` | MAM base URL |
| `MAM_PROXY_URL` | _(disabled)_ | HTTP proxy for MAM traffic, e.g. `http://gluetun:8888` |
| `MAM_STATE_FILE` | `./data/mam-state.json` | Rotated cookie persistence |
| `MAM_REQUEST_TIMEOUT_MS` | `20000` | MAM request timeout |
| `MOUSESEARCH_URL` | `http://mousesearch:5000` | MouseSearch internal base URL |
| `MOUSESEARCH_TIMEOUT_MS` | `30000` | MouseSearch request timeout |
| `DEFAULT_CATEGORY` | `audiobooks` | Torrent-client category sent to `/client/add` |
| `DEFAULT_LANGUAGE` | `English` | Default search language |
| `MAX_RESULTS` | `50` | Default results per page |
| `MCP_HTTP_BIND` | `0.0.0.0:8765` | Listen host:port |
| `MCP_PATH` | `/mcp` | HTTP path for the MCP endpoint |
| `CART_FILE` | `./data/cart.json` | Persistent cart location |
| `APP_LOG_LEVEL` | `INFO` | `DEBUG`/`INFO`/`WARNING`/`ERROR` |

`MAM_PROXY_URL` supports `http://` and `https://` proxies. SOCKS is not supported —
use your proxy's HTTP endpoint. Secrets (`MAM_ID`, `MCP_API_TOKEN`, proxy
credentials) are redacted from all log output.

## Tools

| Tool | Purpose |
|---|---|
| `search_mam` | Full advanced-filter MAM search: text scope (title/author/series/narrator/description/tags/filenames), main category, subcategory, language, seeders/leechers/snatches, size range, upload dates, browse flags, `searchType` (all/active/fl), sort, paging. Returns `total`/`hasMore`/`nextOffset` for paging, a derived `freeleech` kind, and (with `groupEditions`) results grouped by title so audiobook/ebook editions sit together. |
| `get_filter_options` | Main categories, subcategories, and languages with numeric ids. |
| `get_account_stats` | Ratio, uploaded/downloaded, buffer, seed bonus, VIP status. |
| `cart_add` | Queue torrents without downloading: `torrent` (one), `torrents` (batch), or `mids` (MIDs from a `search_mam` earlier in the session). Reports whether each item is already in the client. |
| `cart_list` / `cart_remove` / `cart_clear` | Manage the persistent cart (`cart_list` supports `verbose`/`fields`). |
| `cart_preview` | Dry run: totals the cart split into free vs buffer-costing, and compares against your buffer. |
| `cart_download` | Commit the cart to MouseSearch `/client/add`. Skips torrents already in the client (`already_present`); supports `dryRun`. |
| `get_download_status` | Live torrent status for MIDs and/or hashes (compact summary; `verbose`/`fields` for detail). |
| `check_library` | Whether a MID is already in your torrent client. |
| `get_client_status` | MouseSearch ↔ torrent-client connectivity. |
| `list_client_categories` | Categories available in your torrent client. |

### Freeleech semantics

Each result reports a derived `freeleech` value, plus the raw flags:

| `freeleech` | Meaning | Costs buffer? |
|---|---|---|
| `free` | Global freeleech | No |
| `vip` | VIP freeleech (account is VIP) | No |
| `personal` | Personal freeleech available on the torrent | Only if you opt in |
| `none` | Not freeleech | Yes |

`cart_add`'s `usePersonalFreeleech` (default `false`) spends a bonus-earned
personal wedge. `cart_preview` treats everything except `none` as zero buffer
cost, so you can confirm the paid total before committing.

## Usage workflow

1. `search_mam { query: "project hail mary", mainCats: ["Audiobooks","Ebooks"], searchInTitle: true, minSeeders: 1, groupEditions: true }`
2. `check_library { mids: ["12345", "67890"] }` to skip anything already downloaded
3. `cart_add { mids: ["12345", "67890"], usePersonalFreeleech: false }` — add picks by MID (from the search above), or pass full `torrent`/`torrents` objects
4. `cart_list` to review the queue, then `cart_preview` to see free vs paid size against your buffer
5. `cart_download {}` — MouseSearch performs its buffer check, freeleech handling,
   category assignment, and auto-organization. Items that hit `insufficient_buffer`
   stay in the cart and are reported back with the shortfall and recommended purchase.

Successful items are removed from the cart by default (`removeOnSuccess: true`);
failures remain for retry or removal. Items already in the client are reported as
`already_present` and skipped. `cart_download { dryRun: true }` previews without
committing.

> The MID → torrent cache is per-process and in-memory, so `cart_add { mids }`
> only works for MIDs returned by a `search_mam` in the same process lifetime.
> The full-object form (`torrent`/`torrents`) always works.

## Intentional differences from the MouseSearch UI

- **Ordering** uses MAM's native `sort` (`default`, `seeders`, `size`, `date`,
  `snatched`). MouseSearch applies an additional Python relevance re-rank that is
  not ported here.
- **No single-torrent tool.** MouseSearch has no per-torrent endpoint, so there is
  no `get_torrent`; use `search_mam` results.
- **`hide_downloaded`** is not a search filter because "downloaded" tracking lives in
  MouseSearch's qBittorrent comment scan. Use `check_library` instead.
- **Size safety:** `cart_download` refuses items whose size is missing or unparseable
  rather than defaulting to `0 GiB`, which would bypass MouseSearch's buffer check.

## Running from source

```bash
npm install
npm run build
MAM_ID=... \
MCP_API_TOKEN=... \
MCP_HTTP_BIND=127.0.0.1:8765 \
MAM_STATE_FILE=./data/mam-state.json \
CART_FILE=./data/cart.json \
MOUSESEARCH_URL=http://localhost:5000 \
npm start
```

Useful scripts:

```bash
npm run dev         # tsx src/index.ts (watch-free dev run)
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/
npm start           # node dist/index.js
```

Build the container locally:

```bash
docker build -t mam-mcp:local .
```

## Troubleshooting

### `search_mam` returns an authentication error

The MAM session's allowed IP/ASN does not match the MCP's egress. Confirm
`MAM_PROXY_URL` points at the same proxy MouseSearch uses, and that the dedicated
MAM session allows the provider's ASN.

### `get_client_status` fails with "MouseSearch returned HTML/redirect"

`MOUSESEARCH_URL` is pointing at a MouseSearch URL that sits behind an OIDC/SSO
gateway (the UI's public hostname) instead of the internal API. Use
`http://mousesearch:5000` (same stack) or the internal IP/port.

### `Head "https://ghcr.io/v2/logabell/mam-mcp/manifests/latest": unauthorized`

The GHCR package is private and Docker is not logged in. Authenticate with a
**classic** personal access token that has the `read:packages` scope:

1. Create one at
   <https://github.com/settings/tokens/new?scopes=read:packages&description=mam-mcp-docker-pull>
2. Log in (as the same user that runs `docker compose`):

   ```bash
   echo <PAT> | docker login ghcr.io -u <github-user> --password-stdin
   docker pull ghcr.io/logabell/mam-mcp:latest
   ```

`gh auth token` will **not** work here — it returns `403` for GHCR. If Docker runs
as root (e.g. via `sudo` or rootful Portainer), log in as root too:
`echo <PAT> | sudo docker login ghcr.io -u <github-user> --password-stdin`.

Alternative: build the image locally (`docker build -t mam-mcp:local .`) or make
the package public so no login is required (the image contains no secrets —
credentials are only supplied at runtime via env vars).

### `(root) Additional property mam-mcp is not allowed`

The `mam-mcp:` key is at the top level of the YAML instead of nested under
`services:`. Keep the service block indented under the `services:` header (see
[step 3](#3-run-the-server)).

## Publishing the image

Pushing to `main` (or a `v*` tag, or manual dispatch) triggers
[`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml):

1. `verify` runs `npm ci`, `npm run typecheck`, and `npm run build`.
2. `publish` builds the image and pushes it to `ghcr.io/logabell/mam-mcp` using
   the built-in `GITHUB_TOKEN`.

Tags produced: `latest` (default branch), branch name, and `v*` semver tags. After
the first successful run, make the GHCR package private if desired under
**GitHub → Packages → mam-mcp → Package settings**.

## Security notes

- The bearer token is the **only** gate. Treat it like a password: use a long random
  value and rotate it by updating `MCP_API_TOKEN` if it leaks.
- Anyone with the token can queue downloads and consume your ratio/buffer. Restrict
  access by IP at the proxy if your harness has a stable egress.
- TLS is required for any public exposure; never expose the plain `8765` port to
  the internet.
- Keep the MCP → MouseSearch link on the internal network. MouseSearch's
  `/client/add` API is unauthenticated and should not be exposed publicly.
- `MAM_ID` is never exposed to the model, and secrets are redacted from logs.

## Compliance note

MyAnonamouse rule 1.7 permits automation only through documented API endpoints. This
server uses only the documented search/download endpoints, never exposes your
`mam_id` to the model or to logs, and keeps downloading as a separate, explicit tool
call. You are responsible for how your agent uses it.
