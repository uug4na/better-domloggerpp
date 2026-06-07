import Database from "better-sqlite3";
import type { Hit, StoredHit, Severity } from "./types.js";
import { severityOf } from "./severity.js";

export interface QueryOpts {
  data?: string;        // substring of the sink data (where the user marker lands)
  fingerprint?: string; // the per-hit sink fingerprint (hit.debug; btoa(stackframe||sink))
  tag?: string;
  sink?: string;
  href?: string;
  frame?: string;
  severity?: Severity;
  sinceCursor?: number;
  limit?: number;
}

// Reject scope entries that would match everything (empty / whitespace / wildcards).
const TOO_BROAD = new Set(["", "*", ".", ".*", ".+", "^", "$", "^$", "(.*)", "//"]);

export class HitStore {
  private db: Database.Database;
  private seq: number;

  constructor(path = ":memory:") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        hitCount INTEGER NOT NULL DEFAULT 1,
        dupKey TEXT UNIQUE,
        fingerprint TEXT, tag TEXT, type TEXT, sink TEXT, href TEXT,
        frame TEXT, data TEXT, trace TEXT, badge INTEGER,
        severity TEXT, raw TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_hits_seq ON hits(seq);
      CREATE TABLE IF NOT EXISTS scope (domain TEXT PRIMARY KEY);
    `);
    const row = this.db.prepare("SELECT MAX(seq) AS m FROM hits").get() as any;
    this.seq = (row && row.m) || 0;
  }

  // Insert a new hit, or — on a dupKey collision — advance the existing row's seq so the
  // oracle (since) still observes a re-fire of the same payload instead of dropping it.
  insert(hit: Hit, ts = Date.now()): StoredHit {
    const severity = severityOf(hit);
    const seq = ++this.seq;
    const r = this.db
      .prepare(
        `INSERT INTO hits (seq,ts,hitCount,dupKey,fingerprint,tag,type,sink,href,frame,data,trace,badge,severity,raw)
         VALUES (@seq,@ts,1,@dupKey,@fingerprint,@tag,@type,@sink,@href,@frame,@data,@trace,@badge,@severity,@raw)
         ON CONFLICT(dupKey) DO UPDATE SET seq=@seq, ts=@ts, hitCount=hitCount+1
         RETURNING id`
      )
      .get({
        seq,
        ts,
        dupKey: hit.dupKey,
        fingerprint: hit.debug,
        tag: hit.tag,
        type: hit.type,
        sink: hit.sink,
        href: hit.href,
        frame: hit.frame,
        data: hit.data,
        trace: hit.trace,
        badge: hit.badge ? 1 : 0,
        severity,
        raw: JSON.stringify(hit),
      }) as any;
    return { ...hit, id: Number(r.id), ts, severity };
  }

  private row(r: any): StoredHit {
    return { ...(JSON.parse(r.raw) as Hit), id: r.id, ts: r.ts, severity: r.severity, hitCount: r.hitCount };
  }

  query(o: QueryOpts): StoredHit[] {
    const where: string[] = [];
    const p: any = {};
    if (o.data) { where.push("data LIKE @data"); p.data = `%${o.data}%`; }
    if (o.fingerprint) { where.push("fingerprint = @fingerprint"); p.fingerprint = o.fingerprint; }
    if (o.tag) { where.push("tag = @tag"); p.tag = o.tag; }
    if (o.sink) { where.push("sink LIKE @sink"); p.sink = `%${o.sink}%`; }
    if (o.href) { where.push("href LIKE @href"); p.href = `%${o.href}%`; }
    if (o.frame) { where.push("frame = @frame"); p.frame = o.frame; }
    if (o.severity) { where.push("severity = @severity"); p.severity = o.severity; }
    if (o.sinceCursor != null) { where.push("seq > @cur"); p.cur = o.sinceCursor; }
    const sql = `SELECT * FROM hits ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY seq DESC LIMIT @lim`;
    p.lim = o.limit ?? 100;
    return this.db.prepare(sql).all(p).map((r) => this.row(r));
  }

  get(id: number): StoredHit | null {
    const r = this.db.prepare("SELECT * FROM hits WHERE id = ?").get(id);
    return r ? this.row(r) : null;
  }

  // Oracle: rows whose seq advanced past the cursor (includes re-fires of the same payload).
  since(cursor: number): { hits: StoredHit[]; nextCursor: number } {
    const rows = this.db.prepare("SELECT * FROM hits WHERE seq > ? ORDER BY seq ASC").all(cursor) as any[];
    const hits = rows.map((r) => this.row(r));
    const nextCursor = rows.length ? rows[rows.length - 1].seq : cursor;
    return { hits, nextCursor };
  }

  group(by: "sink" | "tag" | "href" | "fingerprint"): { key: string; count: number }[] {
    const col = by; // all four are real columns
    return this.db
      .prepare(`SELECT ${col} AS key, COUNT(*) AS count FROM hits GROUP BY ${col} ORDER BY count DESC`)
      .all() as any;
  }

  alerts(): StoredHit[] {
    return this.db.prepare("SELECT * FROM hits WHERE badge = 1 ORDER BY seq DESC").all().map((r) => this.row(r));
  }

  clearHits(): number {
    const info = this.db.prepare("DELETE FROM hits").run();
    this.db.prepare("DELETE FROM sqlite_sequence WHERE name = 'hits'").run();
    this.seq = 0;
    return info.changes;
  }

  getScope(): string[] {
    return (this.db.prepare("SELECT domain FROM scope ORDER BY domain").all() as any[]).map((r) => r.domain);
  }

  // Store normalized, plain hostnames. Rejects empty/whitespace/match-everything entries.
  setScope(domains: string[]): void {
    const norm = domains.map((d) => String(d).trim().toLowerCase());
    for (const d of norm) {
      if (!d || TOO_BROAD.has(d)) throw new Error(`scope entry too broad / invalid: ${JSON.stringify(d)}`);
    }
    const clean = norm.filter((d, i, arr) => arr.indexOf(d) === i);
    const tx = this.db.transaction((ds: string[]) => {
      this.db.prepare("DELETE FROM scope").run();
      const ins = this.db.prepare("INSERT OR IGNORE INTO scope (domain) VALUES (?)");
      for (const d of ds) ins.run(d);
    });
    tx(clean);
  }
}
