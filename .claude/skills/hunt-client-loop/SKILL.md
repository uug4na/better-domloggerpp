---
name: hunt-client-loop
description: Autonomous client-side vulnerability hunt loop driven by DOMLogger++ as the oracle. Use when hunting DOM XSS / gadgets / postMessage / CSPT on an AUTHORIZED target, with the DOMLogger MCP bridge connected and a Burp/Chrome MCP available. Observe sink hits -> hypothesize -> deliver a payload (browser/HTTP) -> verify a new canary-bearing sink fired -> escalate/chain -> report.
---

# Client-side Hunt Loop (DOMLogger++ × Burp × Chrome)

Drive an autonomous observe → attack → verify loop for client-side bugs. DOMLogger++ is the
**oracle**: a *new* marker-bearing hit on a dangerous sink proves your input reached
execution. Follow `HUNT.md` doctrine — depth over breadth, chain primitives, never declare a
target "secure".

## Two distinct "canary"-ish values — do not confuse them

- **marker** — the short token YOU embed in payloads (set via `set_canary`, e.g. `dl9z`). It
  lands in a hit's **`data`**. Find your marker with `sinks_query({ data: "dl9z" })`.
- **fingerprint** — a hit's `fingerprint` field (a per-hit sink hash). It is what `arm_debug`
  needs and what the `?domloggerpp-canary=` repro URL expects. Never pass the marker to
  `arm_debug`; pass the hit **id** and the server resolves the fingerprint.

## Tools

- **DOMLogger MCP (`domlogger`)** — oracle + client control:
  - Read: `sinks_query` (`data`=marker substring, `fingerprint`, tag/sink/href/frame/severity), `sink_get({id})`, `sinks_since({cursor})` (poll after each attack — advances even on payload re-fires), `sinks_group({by:"sink"|"tag"|"href"|"fingerprint"})`, `alerts_list`, `bridge_status`, `config_status` (selected config / marker / recon|hunt mode), `reset_hits`
  - Control (scope-gated): `set_canary`, `set_mode`, `select_config`, `apply_config`, `arm_debug({id})`
  - Scope: `scope_get`, `scope_set({domains:[...]})` — **plain hostnames** (e.g. `app.target.com`), NOT regex
- **Chrome MCP (`mcp__claude-in-chrome__*`)** — deliver payloads: navigate with payloads in URL params/hash, interact, postMessage. **Reload the page after any config change** (configs apply at injection time).
- **Burp MCP (`burp`)** — send/replay HTTP for reflected/stored cases; read proxy history.

## Hard preconditions (do not skip)

1. **Authorization.** Confirm the target is in an authorized engagement (bug bounty scope / pentest / CTF / your own lab). If unsure, STOP and ask the user.
2. `scope_set({domains:["target.com"]})` — plain hostnames (subdomains auto-included). Control tools refuse without it; `arm_debug` refuses out-of-scope hosts.
3. `bridge_status` → `connected:true`. If not: the user must set the AI Bridge URL (`ws://127.0.0.1:8788`) in the extension options and add the target to allowed-domains.
4. `reset_hits` — start clean so the recon map isn't polluted by a previous target.
5. Load a hunting config and confirm it: `select_config({name:"hunt-recon"})`, reload the page, then `config_status` to verify. Set a unique marker with `set_canary({value:"dl<rand>"})`, reload, `config_status` again.

## Recon vs Hunt = a CONFIG SWAP (not just set_mode)

The flagship configs differ in dozens of per-sink rules, and per-sink `match` overrides the
global `config["*"]`. So switch by swapping the named config and reloading:
- **recon** (log every sink, map the surface): `select_config({name:"hunt-recon"})` → reload
- **hunt** (filter to your marker): `select_config({name:"hunt"})` → reload → `set_canary` → reload
Re-issue `set_canary` after a swap (both configs ship a default marker) and verify with
`config_status`. `set_mode` is only sound for a config whose gating lives solely in `config["*"]`.

## The loop

1. **Map the surface.** In recon, drive the app via Chrome MCP, then `sinks_group({by:"sink"})` / `{by:"href"}`. Note dangerous sinks (innerHTML, eval, document.write, setAttribute, postMessage, fetch/CSPT, DOMPurify).
2. **Switch to hunt** (config swap + reload + marker). `config_status` must show `mode:"hunt"` and your marker before you trust the oracle.
3. **Snapshot the cursor.** `sinks_since({cursor:0})` → keep `next_cursor`.
4. **Hypothesize** from recon + `sink_get` traces (source→sink).
5. **Deliver the attack** with the marker embedded — Chrome MCP (DOM/interaction) and/or Burp MCP (reflected/stored). Then reload via Chrome MCP so the page re-runs with your input.
6. **Verify (oracle).** `sinks_since({cursor:<last>})`; update the cursor each poll (re-fires of the same payload now advance it). A new `severity:"high"`/`badge:true` hit whose `data` contains your marker = the chain fired. Allow ~1–2s + a few bounded polls after the reload. Cross-check with `sinks_query({ data: "<marker>" })`.
7. **Escalate / chain.** On a hit: `arm_debug({ id:<hit id> })`, reload, then `sink_get({id})` for the live stack; try a stronger payload (break context, defeat the sanitizer, reach JS exec); mine the same root-cause across other `href`s/sinks. On a miss: mutate the payload (encoding, context, gadget) or pick the next hypothesis.
8. **Loop** until a working PoC is proven or the surface is genuinely exhausted (per `HUNT.md`, "no findings" ≠ "secure" — pivot techniques and keep going until the user stops you).

## Report each finding

Severity · exact sink + `href` + `frame` · source→sink flow · working payload · captured stack
trace (`sink_get`) · a repro URL: the page plus `?domloggerpp-canary=<the hit's fingerprint>`
(the per-hit fingerprint, NOT the marker) to re-trigger the debug break · suggested fix.

## Safety rules

- Only act within the declared scope. Never navigate to, send requests to, or arm debug on out-of-scope hosts.
- This is authorized-testing tooling. Surface findings to the user; do not exfiltrate data or touch third-party services.
- Kill-switch: the user clears the Bridge URL / disables the extension, or interrupts the loop.
