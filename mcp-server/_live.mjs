// Live end-to-end: spawn the real server, connect a fake extension over the real WS port,
// and drive the MCP tools over real stdio. Exercises ingest, oracle, control + ack, auth.
import { spawn } from "node:child_process";
import WebSocket from "ws";

const PORT = "8799";
const child = spawn("npx", ["tsx", "src/server.ts"], {
  env: { ...process.env, DOMLOGGER_DB: ":memory:", DOMLOGGER_WS_PORT: PORT },
  stdio: ["pipe", "pipe", "inherit"],
});
const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
let buf = ""; const res = {};
child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; try { const m = JSON.parse(l); if (m.id != null) res[m.id] = m; } catch {} } });
const wait = (id, ms = 8000) => new Promise((ok, no) => { const t0 = Date.now(); const iv = setInterval(() => { if (res[id]) { clearInterval(iv); ok(res[id]); } else if (Date.now() - t0 > ms) { clearInterval(iv); no(new Error("timeout " + id)); } }, 25); });
const callText = (m) => JSON.parse(m.result.content[0].text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0; const ok = (c, m) => { console.log((c ? "  ok  " : "  FAIL ") + m); if (!c) fails++; };

// MCP handshake
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "live", version: "0" } } });
await wait(1);
send({ jsonrpc: "2.0", method: "notifications/initialized" });
await sleep(300); // let the WS server bind

// Fake extension connects + acks commands (returns a result for get_state)
const ext = new WebSocket(`ws://127.0.0.1:${PORT}`);
const received = [];
ext.on("message", (b) => {
  const msg = JSON.parse(String(b));
  if (msg.type !== "command") return;
  received.push(msg);
  if (msg.action === "get_state") ext.send(JSON.stringify({ type: "ack", id: msg.id, ok: true, result: { selectedConfig: "hunt", canary: "dl9z", mode: "hunt" } }));
  else ext.send(JSON.stringify({ type: "ack", id: msg.id, ok: true }));
});
await new Promise((r) => ext.on("open", r));
ext.send(JSON.stringify({ type: "hello", role: "extension" }));

// Ingest a hit
ext.send(JSON.stringify({ date: "d", href: "https://app.ex.com/p", tag: "XSS", type: "attribute", frame: "top", sink: "set:div.innerHTML", data: "hello dl9z world", trace: "at f (https://app.ex.com/a.js:1:1)", debug: "FP1", dupKey: "k1", badge: true }));
await sleep(300);

// bridge_status
send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bridge_status", arguments: {} } });
ok(callText(await wait(2)).connected === true, "bridge_status: extension connected");

// oracle: sinks_since sees the hit
send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "sinks_since", arguments: { cursor: 0 } } });
const since = callText(await wait(3));
ok(since.count === 1 && since.hits[0].data.includes("dl9z"), "sinks_since: oracle sees marker hit");
const hitId = since.hits[0].id;

// marker search via data filter
send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "sinks_query", arguments: { data: "dl9z" } } });
ok(callText(await wait(4)).count === 1, "sinks_query{data}: finds marker");

// control refused without scope
send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "set_canary", arguments: { value: "x" } } });
ok(callText(await wait(5)).ok === false, "set_canary refused without scope");

// set scope, then control works + extension receives it
send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "scope_set", arguments: { domains: ["ex.com"] } } });
await wait(6);
send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "set_canary", arguments: { value: "dl9z" } } });
ok(callText(await wait(7)).ok === true, "set_canary ok with scope");
ok(received.some((m) => m.action === "set_canary"), "extension received set_canary command");

// arm_debug by hit id -> resolves fingerprint, host in scope
send({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "arm_debug", arguments: { id: hitId } } });
ok(callText(await wait(8)).ok === true, "arm_debug by id ok");
const armed = received.find((m) => m.action === "arm_debug");
ok(armed && armed.args.canary === "FP1" && armed.args.href === "https://app.ex.com/p", "arm_debug sent resolved fingerprint + href");

// config_status round-trip
send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "config_status", arguments: {} } });
ok(JSON.stringify(callText(await wait(9))).includes("hunt"), "config_status read-back works");

// arm_debug out-of-scope refused (lookalike)
ext._fp = null;
const before = received.length;
send({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "arm_debug", arguments: { href: "https://evil-ex.com/x", fingerprint: "FP1" } } });
ok(callText(await wait(10)).ok === false, "arm_debug refuses lookalike host evil-ex.com");

// WS auth: a real web origin is rejected
const denied = await new Promise((r) => {
  const w = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: "https://evil.com" });
  w.on("open", () => { w.close(); r(false); });
  w.on("error", () => r(true));
});
ok(denied === true, "WS rejects connection from a real web origin");

console.log(fails === 0 ? "\nLIVE E2E: ALL PASS" : `\n${fails} FAILURES`);
ext.close(); child.kill();
process.exit(fails === 0 ? 0 : 1);
