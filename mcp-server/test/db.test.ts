import { describe, it, expect, beforeEach } from "vitest";
import { HitStore } from "../src/db.js";
import type { Hit } from "../src/types.js";

const mk = (o: Partial<Hit>): Hit => ({
  date: "d",
  href: "https://ex.com/",
  tag: "XSS",
  type: "attribute",
  frame: "top",
  sink: "set:div.innerHTML",
  data: "x",
  trace: "t",
  debug: "cy",
  dupKey: Math.random().toString(36),
  badge: false,
  ...o,
});

describe("HitStore", () => {
  let store: HitStore;
  beforeEach(() => {
    store = new HitStore(":memory:");
  });

  it("inserts and queries, assigns increasing ids + severity", () => {
    const a = store.insert(mk({ dupKey: "k1", sink: "eval" }));
    const b = store.insert(mk({ dupKey: "k2", sink: "fetch" }));
    expect(b!.id).toBeGreaterThan(a!.id);
    expect(a!.severity).toBe("high");
    expect(b!.severity).toBe("med");
    expect(store.query({}).length).toBe(2);
  });

  it("upserts on dupKey: one row, but re-fire is observable via since", () => {
    const a = store.insert(mk({ dupKey: "same" }));
    const c1 = store.since(0);
    expect(c1.hits.length).toBe(1);
    const b = store.insert(mk({ dupKey: "same" })); // re-fire of the same payload
    expect(b.id).toBe(a.id); // same row
    expect(store.query({}).length).toBe(1); // still one row
    const c2 = store.since(c1.nextCursor); // cursor advances on re-fire
    expect(c2.hits.length).toBe(1);
    expect(c2.hits[0].hitCount).toBe(2);
  });

  it("filters by tag/sink/fingerprint/data/severity", () => {
    store.insert(mk({ dupKey: "1", tag: "XSS", sink: "eval", debug: "AAA", data: "x dl9z" }));
    store.insert(mk({ dupKey: "2", tag: "CSPT", sink: "fetch", debug: "BBB", data: "nope" }));
    expect(store.query({ tag: "XSS" }).length).toBe(1);
    expect(store.query({ sink: "eval" }).length).toBe(1);
    expect(store.query({ fingerprint: "BBB" }).length).toBe(1);
    expect(store.query({ data: "dl9z" }).length).toBe(1);
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
    expect(g.find((x) => x.key === "eval")!.count).toBe(2);
    expect(store.alerts().length).toBe(1);
  });

  it("scope get/set roundtrip (normalized, lowercased)", () => {
    expect(store.getScope()).toEqual([]);
    store.setScope(["B.com", "a.com", "a.com"]);
    expect(store.getScope()).toEqual(["a.com", "b.com"]);
  });

  it("scope rejects empty / match-everything entries", () => {
    expect(() => store.setScope([""])).toThrow();
    expect(() => store.setScope([".*"])).toThrow();
    expect(() => store.setScope(["  "])).toThrow();
  });

  it("clearHits resets the store and cursor", () => {
    store.insert(mk({ dupKey: "1" }));
    store.insert(mk({ dupKey: "2" }));
    expect(store.clearHits()).toBe(2);
    expect(store.query({}).length).toBe(0);
    const a = store.insert(mk({ dupKey: "3" }));
    expect(a.id).toBe(1); // autoincrement reset
  });
});
