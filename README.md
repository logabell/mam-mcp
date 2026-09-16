# mam-mcp

A remote (Streamable HTTP) [Model Context Protocol](https://modelcontextprotocol.io)
server that lets an AI agent search MyAnonamouse and queue downloads through an
existing [MouseSearch](https://github.com/sevenlayercookie/MouseSearch) instance.

- **Search** happens inside the MCP using MAM's documented `loadSearchJSONbasic.php` API.
- **Downloads** are delegated to MouseSearch's `POST /client/add`, so buffer checks,
  freeleech handling, categories, path templates, and auto-organization all behave
  exactly as a UI-initiated download.
- **Never** touches your MouseSearch web UI or its public/NPM/PocketID URL — it talks
  to MouseSearch by Docker service name on the internal network.

## Contents

- [Architecture](#architecture)
- [Quick start](#quick-start)
- [1. Create a dedicated MAM session](#1-create-a-dedicated-mam-session)
- [2. Generate an API token](#2-generate-an-api-token)
- [3. Add the container to your stack](#3-add-the-container-to-your-stack)
- [4. Verify](#4-verify)
- [5. Connect an agent harness](#5-connect-an-agent-harness)
- [Configuration reference](#configuration-reference)
- [Tools](#tools)
- [Usage workflow](#usage-workflow)
- [Intentional differences from the MouseSearch UI](#intentional-differences-from-the-mousesearch-ui)
- [Running from source](#running-from-source)
- [Publishing the image](#publishing-the-image)
- [Compliance note](#compliance-note)

## Architecture

```
agent harness (LAN) ── Bearer token ──► mam-mcp :8765/mcp
                                          │
                     http://gluetun:8888 ◄─┤ MAM search API (dedicated session)
                     http://mousesearch:5000 ◄─┘ /client/add, /mam/user_data,
                                                 /client/info/batch, /client/resolve_mid
```

- The MCP reaches MouseSearch by Docker service name, so it never needs the public
  NPM/PocketID URL.
- MAM traffic uses the same proxy egress as MouseSearch (`MAM_PROXY_URL`), so both
  present the same public IP/ASN to the tracker.

## Quick start

The published image is `ghcr.io/logabell/mam-mcp:latest` (built by
[`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml)).

1. Create a dedicated MAM session and copy its `mam_id`.
2. Generate an API token.
3. Add the `mam-mcp` service from [`compose.snippet.yaml`](compose.snippet.yaml)
   to your stack and `docker compose up -d mam-mcp`.
4. Hit `/healthz`, then point your agent at `http://<homelab-ip>:8765/mcp`.

Details for each step below.

## 1. Create a dedicated MAM session

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

## 2. Generate an API token

```bash
openssl rand -hex 32
```

Use it as `MCP_API_TOKEN` (and `MAM_MCP_TOKEN` in the compose snippet). The agent
must send it as `Authorization: Bearer <token>`. The token must be at least 16
characters or the server refuses to start.

## 3. Add the container to your stack

Copy the service from [`compose.snippet.yaml`](compose.snippet.yaml) into the compose
file that already runs `gluetun`, `mousesearch`, and `qbittorrent`, then replace:

| Placeholder | Meaning |
|---|---|
| `<YOUR_STACK_NETWORK>` | The network your services share (`docker network ls`, pick the compose project's net) |
| `MAM_MCP_ID` | The dedicated `mam_id` from step 1 |
| `MAM_MCP_TOKEN` | The token from step 2 |

If the GHCR package is private, log Docker in once so it can pull:

```bash
echo <GITHUB_PAT> | docker login ghcr.io -u <github-user> --password-stdin
```

Then start it:

```bash
docker compose up -d mam-mcp
docker compose logs -f mam-mcp
```

To build from a local checkout instead of pulling, comment out `image:` in the
snippet and uncomment `build: .`.

## 4. Verify

```bash
curl http://<homelab-ip>:8765/healthz
# {"status":"ok","service":"mam-mcp","version":"0.1.0"}

TOKEN=<MCP_API_TOKEN>
curl -s -X POST http://<homelab-ip>:8765/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

A `401` means the bearer token is wrong. A JSON-RPC result listing the tools means
you are ready to connect a harness. If `search_mam` returns an auth error later,
re-check that the MAM session's allowed IP/ASN matches the proxy egress.

## 5. Connect an agent harness

Endpoint: `http://<homelab-ip>:8765/mcp` (LAN only; no PocketID involved).

Required headers on every request:

```
Authorization: Bearer <MCP_API_TOKEN>
Accept: application/json, text/event-stream
```

Generic remote MCP client config:

```json
{
  "mcpServers": {
    "mam": {
      "url": "http://192.168.1.50:8765/mcp",
      "headers": { "Authorization": "Bearer <MCP_API_TOKEN>" }
    }
  }
}
```

Because this is a LAN endpoint it is independent of your NPM/PocketID setup. If you
later expose it publicly through NPM, keep the bearer token and put PocketID in
front of it as an additional layer.

## Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `MAM_ID` | **required** | Dedicated MAM session cookie |
| `MCP_API_TOKEN` | **required** | Bearer token (>= 16 chars) |
| `MAM_API_BASE` | `https://www.myanonamouse.net` | MAM base URL |
| `MAM_PROXY_URL` | _(disabled)_ | HTTP proxy for MAM traffic, e.g. `http://gluetun:8888` |
| `MAM_STATE_FILE` | `./data/mam-state.json` | Rotated cookie persistence |
| `MAM_REQUEST_TIMEOUT_MS` | `20000` | MAM request timeout |
| `MOUSESEARCH_URL` | `http://mousesearch:5000` | MouseSearch base URL |
| `MOUSESEARCH_TIMEOUT_MS` | `30000` | MouseSearch request timeout |
| `DEFAULT_CATEGORY` | `audiobooks` | Torrent-client category sent to `/client/add` |
| `DEFAULT_LANGUAGE` | `English` | Default search language |
| `MAX_RESULTS` | `50` | Default results per page |
| `MCP_HTTP_BIND` | `0.0.0.0:8765` | Listen host:port |
| `MCP_PATH` | `/mcp` | HTTP path for the MCP endpoint |
| `CART_FILE` | `./data/cart.json` | Persistent cart location |
| `APP_LOG_LEVEL` | `INFO` | `DEBUG`/`INFO`/`WARNING`/`ERROR` |

`MAM_PROXY_URL` supports `http://` and `https://` proxies. SOCKS is not supported —
use gluetun's HTTP proxy. Secrets (`MAM_ID`, `MCP_API_TOKEN`, proxy credentials) are
redacted from all log output.

## Tools

| Tool | Purpose |
|---|---|
| `search_mam` | Full advanced-filter MAM search: text scope (title/author/series/narrator/description/tags/filenames), main category, subcategory, language, seeders/leechers/snatches, size range, upload dates, browse flags, `searchType` (all/active/fl), sort, paging. |
| `get_filter_options` | Main categories, subcategories, and languages with numeric ids. |
| `get_account_stats` | Ratio, uploaded/downloaded, buffer, seed bonus, VIP status. |
| `cart_add` | Queue a search result (does not download). |
| `cart_list` / `cart_remove` / `cart_clear` | Manage the persistent cart. |
| `cart_download` | Commit the cart to MouseSearch `/client/add`. |
| `get_download_status` | Live torrent status for MIDs and/or hashes. |
| `check_library` | Whether a MID is already in your torrent client. |
| `get_client_status` | MouseSearch ↔ torrent-client connectivity. |
| `list_client_categories` | Categories available in your torrent client. |

## Usage workflow

1. `search_mam { query: "project hail mary", mainCats: ["Audiobooks"], searchInAuthor: true, minSeeders: 1 }`
2. `check_library { mids: ["12345", "67890"] }` to skip anything already downloaded
3. `cart_add { torrent: <result object>, usePersonalFreeleech: false }` for each pick
4. `cart_list` to review the queue
5. `cart_download {}` — MouseSearch performs its buffer check, freeleech handling,
   category assignment, and auto-organization. Items that hit `insufficient_buffer`
   stay in the cart and are reported back with the shortfall and recommended purchase.

Successful items are removed from the cart by default (`removeOnSuccess: true`);
failures remain for retry or removal.

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
MAM_ID=... \
MCP_API_TOKEN=... \
MCP_HTTP_BIND=127.0.0.1:8765 \
MAM_STATE_FILE=./data/mam-state.json \
CART_FILE=./data/cart.json \
MOUSESEARCH_URL=http://localhost:5000 \
npm run dev
```

Useful scripts:

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/
npm start           # node dist/index.js
```

Build the container locally:

```bash
docker build -t mam-mcp:local .
```

## Publishing the image

Pushing to `main` (or a `v*` tag, or manual dispatch) triggers
[`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml):

1. `verify` runs `npm ci`, `npm run typecheck`, and `npm run build`.
2. `publish` builds the image and pushes it to `ghcr.io/<owner>/<repo>` using the
   built-in `GITHUB_TOKEN`.

Tags produced: `latest` (default branch), branch name, and `v*` semver tags. After
the first successful run, make the GHCR package private if desired under
**GitHub → Packages → mam-mcp → Package settings**.

## Compliance note

MyAnonamouse rule 1.7 permits automation only through documented API endpoints. This
server uses only the documented search/download endpoints, never exposes your
`mam_id` to the model or to logs, and keeps downloading as a separate, explicit tool
call. You are responsible for how your agent uses it.
