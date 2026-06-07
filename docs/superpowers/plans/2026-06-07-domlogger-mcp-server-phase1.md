# DOMLogger MCP Server (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the DOMLogger MCP server's read/oracle half: ingest sink hits over a WebSocket, store them in SQLite, and expose query/oracle tools over MCP (stdio) so Claude Code can read sink data immediately.

**Architecture:** One Node+TypeScript process. A `ws` server accepts the extension connection and writes hits into SQLite (`better-sqlite3`, dedup on `dupKey`, autoincrement `id` = oracle cursor). Pure query functions sit on top of the DB; the MCP layer (`@modelcontextprotocol/sdk`, stdio) wraps them as tools. Control tools (set_canary etc.) are out of scope for Phase 1 — read + ingest only.

**Tech Stack:** Node ≥20, TypeScript, `@modelcontextprotocol/sdk`, `ws`, `better-sqlite3`, `vitest`, `tsx`.

---

## File structure

```
mcp-server/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    types.ts        # Hit + Scope types
    severity.ts     # severityOf(hit) — ported from panel rowSeverity
    db.ts           # HitStore class: insert (dedup), query, get, since, group, alerts, scope
    bridge.ts       # WsBridge: ws server, ingest hits -> store
    tools.ts        # registerTools(server, store): MCP tool definitions
    server.ts       # bootstrap: stdio MCP + start WsBridge
  test/
    db.test.ts
    severity.test.ts
    tools.test.ts
    bridge.test.ts
  README.md
```

Hit shape (from the extension broadcast):
`{ date, href, tag, type, frame, sink, data, trace, debug (canary), dupKey, badge, notification }`.

---

### Task 0: Scaffold the package

**Files:**
- Create: `mcp-server/package.json`, `mcp-server/tsconfig.json`, `mcp-server/vitest.config.ts`

- [ ] **Step 1: package.json**

```json
{
  "name": "domloggerpp-mcp",
  "version": "0.1.0",
  "type": "module",
  "bin": { "domloggerpp-mcp": "dist/server.js" },
  "scripts": {
    "build": "tsc",
    "start": "tsx src/server.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "better-sqlite3": "^11.0.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.0",
    "tsx": "^4.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false
  },
  "include": ["src"]
}
```

- [ ] **Step 3: vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node" } });
```

- [ ] **Step 4: install**

Run: `cd mcp-server && npm install`
Expected: dependencies installed, no errors.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/package.json mcp-server/tsconfig.json mcp-server/vitest.config.ts
git commit -m "chore(mcp): scaffold domloggerpp-mcp package"
```

---

### Task 1: Types + severity

**Files:**
- Create: `mcp-server/src/types.ts`, `mcp-server/src/severity.ts`, `mcp-server/test/severity.test.ts`

- [ ] **Step 1: types.ts**

```ts
export interface Hit {
  date: string;
  href: string;
  tag: string;
  type: string;       // function|class|attribute|event
  frame: string;
  sink: string;
  data: string;
  trace: string;
  debug: string;      // canary
  dupKey: string;
  badge?: boolean;
  notification?: boolean;
}

export type Severity = "high" | "med" | "low";

export interface StoredHit extends Hit {
  id: number;
  ts: number;         // server receive time (ms)
  severity: Severity;
}
```

- [ ] **Step 2: failing test (severity.test.ts)**

```ts
import { describe, it, expect } from "vitest";
import { severityOf } from "../src/severity.js";

describe("severityOf", () => {
  it("alert badge => high", () => {
    expect(severityOf({ badge: true, sink: "fetch" } as any)).toBe("high");
  });
  it("dangerous sink => high", () => {
    expect(severityOf({ sink: "set:Element.prototype.innerHTML" } as any)).toBe("high");
    expect(severityOf({ sink: "eval" } as any)).toBe("high");
  });
  it("set: / event / fetch => med", () => {
    expect(severityOf({ sink: "set:HTMLInputElement.prototype.value" } as any)).toBe("med");
    expect(severityOf({ type: "event", sink: "message" } as any)).toBe("med");
    expect(severityOf({ sink: "fetch" } as any)).toBe("med");
  });
  it("benign lookup => low", () => {
    expect(severityOf({ sink: "document.getElementById" } as any)).toBe("low");
  });
});
```

- [ ] **Step 3: run, expect fail**

Run: `cd mcp-server && npx vitest run test/severity.test.ts`
Expected: FAIL ("severityOf is not a function" / module not found).

- [ ] **Step 4: severity.ts (ported from app/src/devtools/panel/js/utils.js rowSeverity)**

```ts
import type { Hit, Severity } from "./types.js";

const DANGEROUS = /innerHTML|outerHTML|document\.write|writeln|insertAdjacentHTML|setHTMLUnsafe|parseHTMLUnsafe|createContextualFragment|\beval\b|execScript|setTimeout|setInterval|\bFunction\b|\.src\b|srcdoc|\.href\b|location|setAttribute|appendChild|insertBefore|postMessage|__proto__|importScripts/i;
const MEDIUM = /^set:|cookie|fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|[sS]torage|window\.open/;

export function severityOf(hit: Pick<Hit, "sink" | "type" | "badge">): Severity {
  if (hit.badge) return "high";
  const sink = String(hit.sink || "");
  if (DANGEROUS.test(sink)) return "high";
  if (hit.type === "event" || MEDIUM.test(sink)) return "med";
  return "low";
}
```

- [ ] **Step 5: run, expect pass**

Run: `cd mcp-server && npx vitest run test/severity.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/types.ts mcp-server/src/severity.ts mcp-server/test/severity.test.ts
git commit -m "feat(mcp): hit types + severity classifier"
```

---

### Task 2: HitStore (SQLite)

**Files:**
- Create: `mcp-server/src/db.ts`, `mcp-server/test/db.test.ts`

- [ ] **Step 1: failing test (db.test.ts)** — uses an in-memory DB (`:memory:`)

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { HitStore } from "../src/db.js";
import type { Hit } from "../src/types.js";

const mk = (o: Partial<Hit>): Hit => ({
  date: "d", href: "https://ex.com/", tag: "XSS", type: "attribute",
  frame: "top", sink: "set:div.innerHTML", data: "x", trace: "t",
  debug: "cy", dupKey: Math.random().toString(36), badge: false, ...o,
});

describe("HitStore", () => {
  let store: HitStore;
  beforeEach(() => { store = new HitStore(":memory:"); });

  it("inserts and queries, assigns increasing ids + severity", () => {
    const a = store.insert(mk({ dupKey: "k1", sink: "eval" }));
    const b = store.insert(mk({ dupKey: "k2", sink: "fetch" }));
    expect(b!.id).toBeGreaterThan(a!.id);
    expect(a!.severity).toBe("high");
    expect(b!.severity).toBe("med");
    expect(store.query({}).length).toBe(2);
  });

  it("dedupes on dupKey", () => {
    store.insert(mk({ dupKey: "same" }));
    const dup = store.insert(mk({ dupKey: "same" }));
    expect(dup).toBeNull();
    expect(store.query({}).length).toBe(1);
  });

  it("filters by tag/sink/canary/severity", () => {
    store.insert(mk({ dupKey: "1", tag: "XSS", sink: "eval", debug: "AAA" }));
    store.insert(mk({ dupKey: "2", tag: "CSPT", sink: "fetch", debug: "BBB" }));
    expect(store.query({ tag: "XSS" }).length).toBe(1);
    expect(store.query({ sink: "eval" }).length).toBe(1);
    expect(store.query({ canary: "BBB" }).length).toBe(1);
    expect(store.query({ severity: "high" }).length).toBe(1);
  });

  it("since returns only new hits + advancing cursor", () => {
    const a = store.insert(mk({ dupKey: "1" }))!;
    const r1 = store.since(0);
    expect(r1.hits.length).toBe(1);
    expect(r1.nextCursor).toBe(a.id);
    store.insert(mk({ dupKey: "2" }));
    const r2 = store.since(r1.nextCursor);
    expect(r2.hits.length).toBe(1);
    expect(store.since(r2.nextCursor).hits.length).toBe(0);
  });

  it("group counts by field; alerts only badge", () => {
    store.insert(mk({ dupKey: "1", sink: "eval" }));
    store.insert(mk({ dupKey: "2", sink: "eval" }));
    store.insert(mk({ dupKey: "3", sink: "fetch", badge: true }));
    const g = store.group("sink");
    expect(g.find(x => x.key === "eval")!.count).toBe(2);
    expect(store.alerts().length).toBe(1);
  });

  it("scope get/set roundtrip", () => {
    expect(store.getScope()).toEqual([]);
    store.setScope(["a.com", "b.com"]);
    expect(store.getScope()).toEqual(["a.com", "b.com"]);
  });
});
```

- [ ] **Step 2: run, expect fail**

Run: `cd mcp-server && npx vitest run test/db.test.ts`
Expected: FAIL (HitStore not found).

- [ ] **Step 3: db.ts**

```ts
import Database from "better-sqlite3";
import type { Hit, StoredHit, Severity } from "./types.js";
import { severityOf } from "./severity.js";

export interface QueryOpts {
  canary?: string; tag?: string; sink?: string; href?: string;
  frame?: string; severity?: Severity; sinceCursor?: number; limit?: number;
}

export class HitStore {
  private db: Database.Database;
  constructor(path = ":memory:") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        dupKey TEXT UNIQUE,
        canary TEXT, tag TEXT, type TEXT, sink TEXT, href TEXT,
        frame TEXT, data TEXT, trace TEXT, badge INTEGER,
        severity TEXT, raw TEXT
      );
      CREATE TABLE IF NOT EXISTS scope (domain TEXT PRIMARY KEY);
    `);
  }

  insert(hit: Hit, ts = Date.now()): StoredHit | null {
    const severity = severityOf(hit);
    try {
      const info = this.db.prepare(`
        INSERT INTO hits (ts,dupKey,canary,tag,type,sink,href,frame,data,trace,badge,severity,raw)
        VALUES (@ts,@dupKey,@canary,@tag,@type,@sink,@href,@frame,@data,@trace,@badge,@severity,@raw)
      `).run({
        ts, dupKey: hit.dupKey, canary: hit.debug, tag: hit.tag, type: hit.type,
        sink: hit.sink, href: hit.href, frame: hit.frame, data: hit.data,
        trace: hit.trace, badge: hit.badge ? 1 : 0, severity, raw: JSON.stringify(hit),
      });
      return { ...hit, id: Number(info.lastInsertRowid), ts, severity };
    } catch (e: any) {
      if (String(e.message).includes("UNIQUE")) return null; // dedup on dupKey
      throw e;
    }
  }

  private row(r: any): StoredHit {
    return { ...(JSON.parse(r.raw) as Hit), id: r.id, ts: r.ts, severity: r.severity };
  }

  query(o: QueryOpts): StoredHit[] {
    const where: string[] = []; const p: any = {};
    if (o.canary) { where.push("canary = @canary"); p.canary = o.canary; }
    if (o.tag) { where.push("tag = @tag"); p.tag = o.tag; }
    if (o.sink) { where.push("sink LIKE @sink"); p.sink = `%${o.sink}%`; }
    if (o.href) { where.push("href LIKE @href"); p.href = `%${o.href}%`; }
    if (o.frame) { where.push("frame = @frame"); p.frame = o.frame; }
    if (o.severity) { where.push("severity = @severity"); p.severity = o.severity; }
    if (o.sinceCursor != null) { where.push("id > @cur"); p.cur = o.sinceCursor; }
    const sql = `SELECT * FROM hits ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT @lim`;
    p.lim = o.limit ?? 100;
    return this.db.prepare(sql).all(p).map((r) => this.row(r));
  }

  get(id: number): StoredHit | null {
    const r = this.db.prepare("SELECT * FROM hits WHERE id = ?").get(id);
    return r ? this.row(r) : null;
  }

  since(cursor: number): { hits: StoredHit[]; nextCursor: number } {
    const rows = this.db.prepare("SELECT * FROM hits WHERE id > ? ORDER BY id ASC").all(cursor);
    const hits = rows.map((r) => this.row(r));
    const nextCursor = hits.length ? hits[hits.length - 1].id : cursor;
    return { hits, nextCursor };
  }

  group(by: "sink" | "tag" | "href" | "canary"): { key: string; count: number }[] {
    const col = by === "canary" ? "canary" : by;
    return this.db.prepare(`SELECT ${col} AS key, COUNT(*) AS count FROM hits GROUP BY ${col} ORDER BY count DESC`).all() as any;
  }

  alerts(): StoredHit[] {
    return this.db.prepare("SELECT * FROM hits WHERE badge = 1 ORDER BY id DESC").all().map((r) => this.row(r));
  }

  getScope(): string[] {
    return (this.db.prepare("SELECT domain FROM scope ORDER BY domain").all() as any[]).map((r) => r.domain);
  }

  setScope(domains: string[]): void {
    const tx = this.db.transaction((ds: string[]) => {
      this.db.prepare("DELETE FROM scope").run();
      const ins = this.db.prepare("INSERT OR IGNORE INTO scope (domain) VALUES (?)");
      for (const d of ds) ins.run(d);
    });
    tx(domains);
  }
}
```

- [ ] **Step 4: run, expect pass**

Run: `cd mcp-server && npx vitest run test/db.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/db.ts mcp-server/test/db.test.ts
git commit -m "feat(mcp): SQLite HitStore with query/since/group/alerts/scope"
```

---

### Task 3: MCP tools

**Files:**
- Create: `mcp-server/src/tools.ts`, `mcp-server/test/tools.test.ts`

The tool *handlers* are pure functions over a `HitStore`, exported separately from the MCP
registration so they can be unit-tested without spinning up a transport.

- [ ] **Step 1: failing test (tools.test.ts)**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { HitStore } from "../src/db.js";
import { handlers } from "../src/tools.js";
import type { Hit } from "../src/types.js";

const mk = (o: Partial<Hit>): Hit => ({
  date: "d", href: "https://ex.com/", tag: "XSS", type: "attribute", frame: "top",
  sink: "set:div.innerHTML", data: "x", trace: "t", debug: "cy",
  dupKey: Math.random().toString(36), badge: false, ...o,
});

describe("tool handlers", () => {
  let store: HitStore;
  beforeEach(() => { store = new HitStore(":memory:"); });

  it("sinks_query filters", () => {
    store.insert(mk({ dupKey: "1", sink: "eval" }));
    store.insert(mk({ dupKey: "2", sink: "fetch" }));
    const r = handlers.sinks_query(store, { sink: "eval" });
    expect(r.count).toBe(1);
    expect(r.hits[0].sink).toBe("eval");
  });

  it("sinks_since advances cursor", () => {
    store.insert(mk({ dupKey: "1" }));
    const r = handlers.sinks_since(store, { cursor: 0 });
    expect(r.hits.length).toBe(1);
    expect(handlers.sinks_since(store, { cursor: r.next_cursor }).hits.length).toBe(0);
  });

  it("scope_set/get + scope_get reflects", () => {
    handlers.scope_set(store, { domains: ["a.com"] });
    expect(handlers.scope_get(store, {}).domains).toEqual(["a.com"]);
  });

  it("sink_get returns full record or null", () => {
    const a = store.insert(mk({ dupKey: "1" }))!;
    expect(handlers.sink_get(store, { id: a.id }).hit!.id).toBe(a.id);
    expect(handlers.sink_get(store, { id: 9999 }).hit).toBeNull();
  });
});
```

- [ ] **Step 2: run, expect fail**

Run: `cd mcp-server && npx vitest run test/tools.test.ts`
Expected: FAIL (handlers not found).

- [ ] **Step 3: tools.ts**

```ts
import type { HitStore, QueryOpts } from "./db.js";

// Compact projection for list results (keeps tokens down)
const compact = (h: any) => ({
  id: h.id, ts: h.ts, severity: h.severity, badge: !!h.badge, tag: h.tag,
  type: h.type, sink: h.sink, frame: h.frame, href: h.href, canary: h.debug,
  data: String(h.data).slice(0, 200), dupKey: h.dupKey,
});

export const handlers = {
  sinks_query(store: HitStore, a: QueryOpts & { since_cursor?: number }) {
    const hits = store.query({ ...a, sinceCursor: a.since_cursor });
    return { count: hits.length, hits: hits.map(compact) };
  },
  sink_get(store: HitStore, a: { id: number }) {
    return { hit: store.get(a.id) };
  },
  sinks_since(store: HitStore, a: { cursor: number }) {
    const { hits, nextCursor } = store.since(a.cursor);
    return { count: hits.length, next_cursor: nextCursor, hits: hits.map(compact) };
  },
  sinks_group(store: HitStore, a: { by: "sink" | "tag" | "href" | "canary" }) {
    return { groups: store.group(a.by) };
  },
  alerts_list(store: HitStore, _a: {}) {
    const hits = store.alerts();
    return { count: hits.length, hits: hits.map(compact) };
  },
  scope_get(store: HitStore, _a: {}) {
    return { domains: store.getScope() };
  },
  scope_set(store: HitStore, a: { domains: string[] }) {
    store.setScope(a.domains);
    return { domains: store.getScope() };
  },
};
```

- [ ] **Step 4: run, expect pass**

Run: `cd mcp-server && npx vitest run test/tools.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/tools.ts mcp-server/test/tools.test.ts
git commit -m "feat(mcp): read/oracle tool handlers over HitStore"
```

---

### Task 4: WS bridge ingest

**Files:**
- Create: `mcp-server/src/bridge.ts`, `mcp-server/test/bridge.test.ts`

The bridge accepts a WS connection and treats each text message as either a single hit
object or `{type:"hit", hit}` / `{type:"hits", hits:[...]}` batch. It records connection
status for `bridge_status`.

- [ ] **Step 1: failing test (bridge.test.ts)** — start the server on an ephemeral port, connect a `ws` client, send hits, assert they land in the store.

```ts
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { HitStore } from "../src/db.js";
import { WsBridge } from "../src/bridge.js";

const mkHit = (dupKey: string) => ({
  date: "d", href: "https://ex.com/", tag: "XSS", type: "attribute", frame: "top",
  sink: "set:div.innerHTML", data: "x", trace: "t", debug: "cy", dupKey, badge: false,
});

describe("WsBridge ingest", () => {
  let bridge: WsBridge;
  afterEach(() => bridge?.close());

  it("ingests single + batched hits into the store", async () => {
    const store = new HitStore(":memory:");
    bridge = new WsBridge(store, 0); // 0 = ephemeral port
    const port = await bridge.listen();

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify(mkHit("k1")));
    ws.send(JSON.stringify({ type: "hits", hits: [mkHit("k2"), mkHit("k3")] }));
    await new Promise((r) => setTimeout(r, 100));

    expect(store.query({}).length).toBe(3);
    expect(bridge.status().connected).toBe(true);
    ws.close();
  });
});
```

- [ ] **Step 2: run, expect fail**

Run: `cd mcp-server && npx vitest run test/bridge.test.ts`
Expected: FAIL (WsBridge not found).

- [ ] **Step 3: bridge.ts**

```ts
import { WebSocketServer, WebSocket } from "ws";
import type { HitStore } from "./db.js";
import type { Hit } from "./types.js";

export class WsBridge {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private lastHitTs = 0;
  private hitCount = 0;
  constructor(private store: HitStore, private port = 8788) {}

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ host: "127.0.0.1", port: this.port }, () => {
        resolve((this.wss!.address() as any).port);
      });
      this.wss.on("connection", (ws) => {
        this.clients.add(ws);
        ws.on("message", (buf) => this.onMessage(String(buf)));
        ws.on("close", () => this.clients.delete(ws));
        ws.on("error", () => this.clients.delete(ws));
      });
    });
  }

  private ingest(hit: Hit) {
    if (!hit || !hit.dupKey) return;
    const r = this.store.insert(hit);
    if (r) { this.hitCount++; this.lastHitTs = r.ts; }
  }

  private onMessage(text: string) {
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }
    if (Array.isArray(msg)) msg.forEach((h) => this.ingest(h));
    else if (msg.type === "hits" && Array.isArray(msg.hits)) msg.hits.forEach((h: Hit) => this.ingest(h));
    else if (msg.type === "hit" && msg.hit) this.ingest(msg.hit);
    else if (msg.dupKey) this.ingest(msg); // bare hit object
  }

  status() {
    return { connected: this.clients.size > 0, clients: this.clients.size, lastHitTs: this.lastHitTs, hitCount: this.hitCount };
  }

  // Phase 3 will add: send(command) to push control down to the extension.

  close() { this.clients.forEach((c) => c.close()); this.wss?.close(); }
}
```

- [ ] **Step 4: run, expect pass**

Run: `cd mcp-server && npx vitest run test/bridge.test.ts`
Expected: PASS (1 test, 3 hits ingested).

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/bridge.ts mcp-server/test/bridge.test.ts
git commit -m "feat(mcp): WebSocket bridge ingest into HitStore"
```

---

### Task 5: Server bootstrap (MCP stdio + WS)

**Files:**
- Create: `mcp-server/src/server.ts`

Wires the MCP stdio server, registers each handler as a tool with a JSON schema, starts the
WS bridge, and adds `bridge_status`. Config via env: `DOMLOGGER_DB` (default
`./domlogger.sqlite`), `DOMLOGGER_WS_PORT` (default `8788`).

- [ ] **Step 1: server.ts**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HitStore } from "./db.js";
import { WsBridge } from "./bridge.js";
import { handlers } from "./tools.js";

const store = new HitStore(process.env.DOMLOGGER_DB || "./domlogger.sqlite");
const bridge = new WsBridge(store, Number(process.env.DOMLOGGER_WS_PORT || 8788));
const server = new McpServer({ name: "domloggerpp", version: "0.1.0" });

server.tool("sinks_query", "Query stored sink hits with optional filters.", {
  canary: z.string().optional(), tag: z.string().optional(), sink: z.string().optional(),
  href: z.string().optional(), frame: z.string().optional(),
  severity: z.enum(["high", "med", "low"]).optional(),
  since_cursor: z.number().optional(), limit: z.number().optional(),
}, async (a) => ({ content: [{ type: "text", text: JSON.stringify(handlers.sinks_query(store, a as any)) }] }));

server.tool("sink_get", "Get one full sink hit (complete trace + data) by id.",
  { id: z.number() },
  async (a) => ({ content: [{ type: "text", text: JSON.stringify(handlers.sink_get(store, a)) }] }));

server.tool("sinks_since", "Oracle: new hits since a cursor. Returns next_cursor.",
  { cursor: z.number() },
  async (a) => ({ content: [{ type: "text", text: JSON.stringify(handlers.sinks_since(store, a)) }] }));

server.tool("sinks_group", "Count hits grouped by a field (recon surface map).",
  { by: z.enum(["sink", "tag", "href", "canary"]) },
  async (a) => ({ content: [{ type: "text", text: JSON.stringify(handlers.sinks_group(store, a)) }] }));

server.tool("alerts_list", "List only hits that triggered an alert (badge=true).", {},
  async () => ({ content: [{ type: "text", text: JSON.stringify(handlers.alerts_list(store, {})) }] }));

server.tool("scope_get", "Get the authorized target allowlist.", {},
  async () => ({ content: [{ type: "text", text: JSON.stringify(handlers.scope_get(store, {})) }] }));

server.tool("scope_set", "Set the authorized target allowlist (domains/regex).",
  { domains: z.array(z.string()) },
  async (a) => ({ content: [{ type: "text", text: JSON.stringify(handlers.scope_set(store, a)) }] }));

server.tool("bridge_status", "Is the extension connected? last hit + count.", {},
  async () => ({ content: [{ type: "text", text: JSON.stringify(bridge.status()) }] }));

await bridge.listen();
await server.connect(new StdioServerTransport());
```

- [ ] **Step 2: add zod dep**

Run: `cd mcp-server && npm install zod`
Expected: zod added.

- [ ] **Step 3: typecheck + build**

Run: `cd mcp-server && npx tsc --noEmit`
Expected: no type errors. (Fix any signature drift against the SDK's `server.tool` shape.)

- [ ] **Step 4: manual smoke (MCP Inspector or raw stdio)**

Run: `cd mcp-server && npx @modelcontextprotocol/inspector tsx src/server.ts`
Expected: Inspector lists the 8 tools; `bridge_status` returns `{connected:false,...}`.
(If Inspector unavailable, run `npm run test` — all suites green — and `npm run start` to confirm it boots without throwing.)

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/server.ts mcp-server/package.json mcp-server/package-lock.json
git commit -m "feat(mcp): stdio MCP server wiring read tools + WS bridge"
```

---

### Task 6: README + Claude Code registration

**Files:**
- Create: `mcp-server/README.md`

- [ ] **Step 1: README.md** — how to build, run, set `DOMLOGGER_WS_PORT`/`DOMLOGGER_DB`, and the `.mcp.json` snippet:

```json
{
  "mcpServers": {
    "domlogger": { "command": "npx", "args": ["tsx", "/abs/path/mcp-server/src/server.ts"] }
  }
}
```

Document: Phase 1 is read-only (ingest + query). The extension Bridge (Phase 2) feeds it;
until then, tools return empty results. Note the scope allowlist is advisory in Phase 1 and
enforced on control tools in Phase 3.

- [ ] **Step 2: Commit**

```bash
git add mcp-server/README.md
git commit -m "docs(mcp): phase 1 README + Claude Code registration"
```

---

## Self-review

- **Spec coverage (Phase 1 rows):** WS ingest ✓ (Task 4), SQLite store ✓ (Task 2),
  read tools `sinks_query/get/since/group/alerts` ✓ (Tasks 3,5), meta `scope_*` + `bridge_status` ✓ (Tasks 3,5), severity filter ✓ (Task 1). Control tools + extension apply = Phase 3 (not this plan). Orchestration/Burp/Chrome = Phase 4. E2E = Phase 5.
- **Placeholders:** none — every step has full code/commands.
- **Type consistency:** `Hit.debug` is the canary throughout; store column `canary` maps from `hit.debug`; `severityOf` signature matches `db.insert` usage; `handlers.*` signatures `(store, args)` match `tools.test.ts` and `server.ts` call sites; `since`/`sinks_since` return `{hits,nextCursor}`→`{hits,next_cursor}` mapping is explicit in `tools.ts`.
- **Risk note:** `server.tool` argument shape can vary across `@modelcontextprotocol/sdk` minor versions — Task 5 Step 3 typecheck catches drift; adjust the registration calls to the installed SDK if needed (handlers/store/tests are SDK-independent).

## Next plans (after Phase 1 is green)
- **Phase 2:** extension Bridge (WS client, up-stream only) + "Bridge server URL" option.
- **Phase 3:** control tools + extension apply (`set_canary/set_mode/select_config/apply_config/arm_debug`) + scope guard + acks.
- **Phase 4:** `.mcp.json` (domlogger+burp+chrome) + `/hunt-client-loop` skill.
- **Phase 5:** local E2E smoke + docs.
