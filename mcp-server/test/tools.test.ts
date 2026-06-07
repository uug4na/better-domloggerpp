import { describe, it, expect, beforeEach } from "vitest";
import { HitStore } from "../src/db.js";
import { handlers, hostInScope } from "../src/tools.js";
import type { Hit } from "../src/types.js";

describe("hostInScope", () => {
  const scope = ["ex.com"];
  it("matches exact host and subdomains", () => {
    expect(hostInScope("https://ex.com/p", scope)).toBe(true);
    expect(hostInScope("https://app.ex.com/p?q=1", scope)).toBe(true);
  });
  it("rejects lookalikes and unrelated hosts", () => {
    expect(hostInScope("https://evil-ex.com/p", scope)).toBe(false);
    expect(hostInScope("https://ex.com.evil.com/p", scope)).toBe(false);
    expect(hostInScope("https://notex.com/p", scope)).toBe(false);
    expect(hostInScope("not a url", scope)).toBe(false);
  });
});

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

describe("tool handlers", () => {
  let store: HitStore;
  beforeEach(() => {
    store = new HitStore(":memory:");
  });

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

  it("scope_set/get reflects", () => {
    handlers.scope_set(store, { domains: ["a.com"] });
    expect(handlers.scope_get(store, {}).domains).toEqual(["a.com"]);
  });

  it("sink_get returns full record or null", () => {
    const a = store.insert(mk({ dupKey: "1" }))!;
    expect(handlers.sink_get(store, { id: a.id }).hit!.id).toBe(a.id);
    expect(handlers.sink_get(store, { id: 9999 }).hit).toBeNull();
  });
});
