# DOMLogger++ AI Hunt Bridge — Design Spec

**Date:** 2026-06-07
**Status:** Approved (design); pending implementation plan
**Approach:** A — three MCPs + Claude Code orchestrator

## Goal

Let an AI (Claude Code) autonomously hunt client-side vulnerabilities using DOMLogger++
as the observation oracle, Claude-in-Chrome for client-side payload delivery, and Burp
Suite (its official MCP) for HTTP send/replay. The AI observes sink hits, forms a
hypothesis, delivers an attack, and verifies success when a *new* canary-bearing sink hit
appears — looping observe → attack → verify → escalate until a finding is proven or the
attack surface is exhausted, strictly within an authorized scope.

## Non-goals

- No headless browser or Burp-traffic re-implementation inside our server (that is
  Approach B; rejected for YAGNI — reuse Claude-in-Chrome and Burp's MCP).
- No standalone productized agent (Approach C / Agent SDK) in this iteration — Claude Code
  is the loop driver. Can graduate later.
- No remote/hosted exposure. Localhost only.

## Decisions

- **Server language:** Node.js + TypeScript. First-class MCP TS SDK, shares the
  extension's JS ecosystem, easy `ws` + `better-sqlite3`.
- **Transport to extension:** a single **WebSocket** (hits up, control down) — simpler and
  lower-latency than the existing 1s webhook + a separate control poll, and the extension
  already ships a WS lib (`background/libs/graphql-ws.js`).
- **MCP transport to Claude:** stdio (Claude Code spawns the server).
- **Store:** SQLite (`better-sqlite3`), file-backed, resettable. Monotonic autoincrement
  `id` doubles as the oracle cursor.

## Architecture

```
DOMLogger++ ext (background + Bridge WS client)
   │  hits up                ▲ control down
   ▼                         │
DOMLogger MCP server  ── WS server + SQLite + MCP(stdio) ──▶ Claude Code (loop driver)
                                                              ├─ Claude-in-Chrome MCP (deliver client-side payloads)
                                                              └─ Burp official MCP (HTTP send/replay/history)
```

Single new build: **DOMLogger MCP server**. Plus a small extension **Bridge** addition.
Burp MCP and Claude-in-Chrome MCP are reused as-is.

## Components

### 1. DOMLogger MCP server (new) — `mcp-server/`

One Node process, three faces sharing one SQLite DB:

- **WS server** (default `ws://127.0.0.1:8788`): accepts the extension connection.
  - Up: hit objects (the same shape the extension broadcasts to devtools:
    `{date, href, tag, type, frame, sink, data, trace, debug(canary), dupKey, badge, notification}`).
    Inserted into SQLite; deduped on `dupKey`.
  - Down: control commands (JSON `{action, args, id}`) → extension applies, returns
    `{id, ok|error}` ack.
- **SQLite store:** table `hits(id INTEGER PK AUTOINCREMENT, ts, dupKey UNIQUE, canary,
  tag, type, sink, href, frame, data, trace, badge, raw JSON)`. `id` = oracle cursor.
  Also `scope(domain)` table.
- **MCP face (stdio):** tools below.

**Read / oracle tools**
- `sinks_query({canary?, tag?, sink?, href?, frame?, severity?, since_cursor?, limit?})` → compact hits
- `sink_get({id})` → full record incl. complete trace + data
- `sinks_since({cursor})` → new hits since cursor + `next_cursor` (the oracle poll)
- `sinks_group({by: "sink"|"tag"|"href"|"canary"})` → counts (recon map)
- `alerts_list()` → `badge=true` hits only

**Control tools (scope-guarded; sent over WS, await extension ack)**
- `set_canary({value})`
- `set_mode({mode: "recon"|"hunt"})`
- `select_config({name})`
- `apply_config({name, content})` — server validates with ported `checkHookConfig` rules before sending
- `arm_debug({href, canary})` — next matching sink breaks in the debugger

**Meta tools**
- `scope_get()` / `scope_set({domains:[...]})` — authorized allowlist (mirrors extension `allowedDomains`)
- `bridge_status()` → `{connected, lastHitTs, hitCount}`

**Scope guard:** every control tool, and any tool that takes a target `href`/host, checks
the host against the `scope` allowlist; refuses with a clear error if out of scope.

### 2. Extension Bridge (addition) — `app/src/background/bridge.js`

- Reconnecting WS client, **enabled only when a "Bridge server URL" is set** in options
  (new setting; reuse the webhook/Caido settings pattern; localhost default).
- Up: tap the existing `MessagesHandler.broadcast`/queue path; also flush a backlog queue
  on reconnect (reuse the `webhookQueue` idea). Drop-with-log on overflow.
- Down: handle control commands by writing `storage.local` and reusing existing flows:
  - `set_canary` → selected config `globals.canary`
  - `set_mode` → selected config `config["*"].match` (`/.*/` vs `new RegExp(globals.canary)`)
  - `select_config` → `hooksData.selectedHook`
  - `apply_config` → validate via existing `checkHookConfig`, then add/replace in `hooksData`
  - `arm_debug` → set `debugCanary` (reuse the existing debugSink reload-and-break flow)
  - each returns an ack `{id, ok|error}`
- Config changes take effect on the next page load (the loop reloads via the browser MCP).
- Cross-browser: MV2 (Firefox persistent bg) and MV3 (service worker) — keep the WS in the
  background; on MV3 the worker can sleep, so reconnect on wake and rely on the extension's
  existing storage as the source of truth.

### 3. Orchestration (Claude Code)

- `.mcp.json` registering three servers: `domlogger` (ours), `burp`, `chrome`.
- `/hunt-client-loop` skill encoding the loop (see Data flow). Honors scope; autonomous
  within scope with a kill-switch (clear bridge URL / Esc / `loop_abort`).

## Data flow / the loop

1. Sync scope + current config; `sinks_group` (Recon surface map) / `sinks_query` (Hunt canary flows)
2. Hypothesis (e.g., "hash → `innerHTML`, no sanitizer"; "DOMPurify output → replace-gadget")
3. Deliver attack — browser nav with payload (Chrome MCP) and/or HTTP replay (Burp MCP)
4. `sinks_since(cursor)` → new canary-bearing dangerous sink fired? *(oracle)*
5. Hit → escalate (`arm_debug` to capture the stack, stronger payload, chain the gadget);
   miss → mutate payload/hypothesis
6. Loop until proven or surface exhausted → report PoC (payload + sink + trace + repro URL)

## Error handling & robustness

- Extension auto-reconnects; queues hits while server is down; bounded queue with drop-log.
- `sinks_since` cursor monotonic; dedup on `dupKey` so retries never double-count.
- `apply_config` validated server-side (ported `checkHookConfig`) and extension-side; nack
  surfaces the exact error to the tool caller.
- Oracle polling is bounded (timeout + max polls); sink hits arrive ~1–2s after page load.
- Server tolerates extension restarts; extension tolerates server restarts.

## Safety / authorization boundary

- Autonomous actions only within the **scope allowlist** (authorized targets). Server and
  loop both refuse out-of-scope hosts. Bridge localhost-only; no remote exposure.
- Authorized-testing tooling (pentest / bug-bounty / CTF / research) per the project's HUNT
  doctrine. Surfaces findings; never targets third parties or exfiltrates data.
- Kill-switch: clear the bridge URL, disable the extension, or Esc the loop.

## Testing

- **Server unit:** store + each tool against in-memory SQLite; a fake extension WS client
  feeding canned hits; scope-guard refusal cases; `apply_config` validation.
- **Oracle:** `sinks_since` returns exactly the new hits; dedup holds across retries.
- **Extension bridge:** mock WS server — hits stream up; each control command mutates
  `storage.local` correctly and validates (node-stub pattern, `globalThis.chrome` stub).
- **E2E smoke (local, in-scope):** a deliberately-vulnerable local page + real extension +
  server + one scripted loop iteration proving observe → attack → verify closes.

## Build order (phases)

1. **MCP server**: WS ingest + SQLite + read tools (`sinks_query/get/since/group`, `alerts_list`). → Claude can read sink data.
2. **Extension bridge (up only)** + "Bridge server URL" setting. → live hits.
3. **Control tools + extension apply** (`set_canary/set_mode/select_config/apply_config/arm_debug`) + scope guard.
4. **Orchestration**: `.mcp.json` (domlogger + burp + chrome) + `/hunt-client-loop` skill.
5. **E2E smoke + docs.**

Each phase is independently useful and testable.
