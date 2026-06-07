# DOMLogger++ AI Hunt Bridge

Let an AI (Claude Code) autonomously hunt **client-side** vulnerabilities, using DOMLogger++
as the observation **oracle**, Claude-in-Chrome for client-side payload delivery, and Burp
Suite (its official MCP) for HTTP. The model observes sink hits → forms a hypothesis →
delivers an attack → verifies success when a *new canary-bearing sink hit* appears → escalates
and chains. Authorized targets only.

```
DOMLogger++ ext (Bridge WS client) ──hits up / control down── DOMLogger MCP server ──MCP(stdio)──▶ Claude Code
                                                               (WS + SQLite + tools)            ├─ Claude-in-Chrome MCP  (deliver payloads)
                                                                                                └─ Burp official MCP     (HTTP send/replay)
```

## Components

- **`mcp-server/`** — Node+TS. WebSocket server (extension connects), SQLite store, MCP tools (stdio). The only new build. See `mcp-server/README.md`.
- **Extension Bridge** — `app/src/background/bridge.js` (`DLBridge`): reconnecting WS client; streams hits up, applies control commands down. Enabled by the **AI Bridge URL** setting (Options → Webhook tab → *AI Bridge*).
- **`.mcp.json`** — registers the `domlogger` server (and a `burp` SSE entry) for Claude Code.
- **`.claude/skills/hunt-client-loop/`** — the autonomous loop methodology Claude follows.
- **Reused** — Claude-in-Chrome MCP (browser), Burp official MCP Server BApp (HTTP).

## Setup

1. **Build the MCP server**
   ```bash
   cd mcp-server && npm install && npm test
   ```
2. **Register it** — `.mcp.json` (repo root) already points Claude Code at it (`npx tsx mcp-server/src/server.ts`, WS port 8788) plus the `burp` server. Burp's MCP (BApp "MCP Server") serves SSE at the **root** `http://127.0.0.1:9876` (NOT `/sse`) — verified `serverInfo: burp-suite`, 27 tools incl. `send_http1_request`/`create_repeater_tab`/`send_to_intruder`. Remove the `burp` entry if unused. Claude-in-Chrome is configured at the session level.
3. **Load the extension** (Chrome/Brave): `cd app && make copy-configs && ln -sf manifest-chrome.json manifest.json`, then load the `app/` folder unpacked. (Firefox: `manifest-firefox.json`.)
4. **Wire the bridge** — extension Options → **Webhook** tab → **AI Bridge**: set `ws://127.0.0.1:8788`, check *Enable AI bridge*, Save. Add your target to **Domains**. Pick/load the **hunt** config (Options → Config library).
5. **Verify** — in Claude Code, `bridge_status` should show `connected:true` once the extension is loaded with the bridge enabled.

## Run the loop

Set the authorized scope (**plain hostnames**, subdomains included), then invoke the skill:

```
scope_set({ domains: ["target.example.com"] })
reset_hits()
/hunt-client-loop
```

Claude maps the surface (recon config), swaps to the hunt config with a marker, delivers
payloads via Chrome/Burp, polls `sinks_since` as the oracle (re-fires advance the cursor), and
escalates on hits via `arm_debug({id})`. It reports each finding with the sink, source→sink
flow, payload, captured stack trace, and a repro URL (`?domloggerpp-canary=<hit fingerprint>`).

Two distinct values: the **marker** you embed (`set_canary`; found via `sinks_query({data})`)
vs. a hit's **`fingerprint`** (used by `arm_debug`/the repro URL — pass the hit `id`).
Recon↔hunt is a **config swap** (`select_config` "hunt-recon" / "hunt") + page reload, not just
`set_mode`. Confirm state with `config_status` after each change.

## Safety

- **Authorized testing only** (bug bounty / pentest / CTF / your lab), per `HUNT.md`.
- Control tools refuse until `scope_set` declares the target; `arm_debug` refuses out-of-scope hosts; the loop stays in scope for every navigation/request.
- Bridge is localhost-only. Kill-switch: clear the AI Bridge URL / disable the extension / interrupt the loop.

## Protocol (WS, JSON messages)

- Up (extension→server): bare hit objects `{sink,data,trace,href,frame,tag,debug(canary),dupKey,badge,...}`; deduped on `dupKey`.
- Down (server→extension): `{type:"command", id, action, args}` → extension replies `{type:"ack", id, ok, error?, result?}`.
- Actions: `set_canary`, `set_mode`, `select_config`, `apply_config`, `arm_debug`, `get_state`.
- Auth: WS binds to 127.0.0.1, rejects real web origins; optional `DOMLOGGER_BRIDGE_TOKEN` (`ws://127.0.0.1:8788/?token=…`). The extension also independently protects reserved configs and caps config size.

## Status

All five phases complete: MCP server (read/oracle), extension Bridge (up), control tools +
extension apply + scope guard, orchestration (`.mcp.json` + skill), and tests/docs.
`cd mcp-server && npm test` covers store, tools, severity, WS ingest, and the control
round-trip (fake extension acking commands). The extension `applyCommand` paths and the panel
logic are covered by standalone Node checks. Live, in-DevTools verification requires loading
the unpacked extension (browser-extension panels aren't drivable via automation).
