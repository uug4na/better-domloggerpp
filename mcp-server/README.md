# DOMLogger++ MCP server

Exposes DOMLogger++ sink-hit data to an AI (Claude Code) over MCP, so the model can read the
client-side attack surface and use it as an **oracle** for an autonomous hunt loop.

Full system docs: `../docs/AI-HUNT-BRIDGE.md`. Design:
`../docs/superpowers/specs/2026-06-07-domlogger-ai-mcp-bridge-design.md`.

## What it does

- Runs a **WebSocket server** (`ws://127.0.0.1:8788` by default) that the DOMLogger++
  extension connects to and streams sink hits over.
- Stores hits in **SQLite** (deduped on `dupKey`; autoincrement `id` is the oracle cursor).
- Exposes **MCP tools** (stdio) over that data.

## Tools

| Tool | Purpose |
|------|---------|
| `sinks_query` | Filter hits — `data` (substring; where your marker lands), `fingerprint`, tag/sink/href/frame/severity |
| `sink_get` | One full hit (complete trace + data) by id |
| `sinks_since` | **Oracle** — new hits since a cursor (+ `next_cursor`); advances even on payload re-fires |
| `sinks_group` | Counts grouped by sink/tag/href/fingerprint (recon surface map) |
| `alerts_list` | Only hits that triggered an alert (`badge=true`) |
| `config_status` | Read back the live extension config (selected config / marker / recon-hunt mode) |
| `reset_hits` | Clear stored hits (fresh start; requires scope) |
| `scope_get` / `scope_set` | Authorized target allowlist — **plain hostnames** (subdomains included), enforced on control tools |
| `bridge_status` | Is the extension connected? last hit + count |

Two distinct values: the **marker** you embed in payloads (set via `set_canary`, lands in a
hit's `data`) vs. a hit's **`fingerprint`** (per-hit sink hash) used by `arm_debug`/the repro
URL. Pass `arm_debug` the hit **id**; the server resolves the fingerprint.

**Control tools** (push to the extension; require a scope to be set via `scope_set`):

| Tool | Purpose |
|------|---------|
| `set_canary` | Set the active config's canary marker |
| `set_mode` | Switch the active config recon (log all) ↔ hunt (canary-filtered) |
| `select_config` | Select an existing hooking config by name |
| `apply_config` | Add/replace a hooking config (`content` = the config object; reserved GLOBAL/DEFAULT protected) |
| `arm_debug` | Reload and break when a specific hit's sink fires — pass the hit `id` (host must be in scope) |

## Run

```bash
npm install
npm test          # vitest — unit + ingest integration
npm run build     # tsc -> dist/
npm start         # tsx src/server.ts (stdio MCP + WS bridge)
```

Env: `DOMLOGGER_DB` (default `./domlogger.sqlite`, use `:memory:` for ephemeral),
`DOMLOGGER_WS_PORT` (default `8788`, `0` = ephemeral), `DOMLOGGER_BRIDGE_TOKEN` (optional —
if set, the extension must connect with `?token=<value>` in the Bridge URL).

The WS bridge binds to `127.0.0.1` only and rejects real web origins (a browser tab can't
connect). For full isolation from other local processes, set `DOMLOGGER_BRIDGE_TOKEN` and
append `?token=<value>` to the extension's AI Bridge URL.

## Register with Claude Code

Add to your project `.mcp.json`:

```json
{
  "mcpServers": {
    "domlogger": { "command": "npx", "args": ["tsx", "/ABS/PATH/mcp-server/src/server.ts"] }
  }
}
```

Until the extension Bridge is connected (set the AI Bridge URL in the extension options),
the query tools return empty results and `bridge_status` shows `connected:false`. Control
tools refuse until `scope_set` declares the authorized target(s).
