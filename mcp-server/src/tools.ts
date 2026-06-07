import type { HitStore, QueryOpts } from "./db.js";
import type { WsBridge } from "./bridge.js";

// Compact projection for list results (keeps token cost down).
// NOTE: `fingerprint` is the per-hit sink hash (hit.debug) used by arm_debug — NOT the
// user marker you embed in payloads; that lives inside `data`.
const compact = (h: any) => ({
  id: h.id,
  ts: h.ts,
  severity: h.severity,
  badge: !!h.badge,
  hitCount: h.hitCount,
  tag: h.tag,
  type: h.type,
  sink: h.sink,
  frame: h.frame,
  href: h.href,
  fingerprint: h.debug,
  data: String(h.data).slice(0, 200),
  dupKey: h.dupKey,
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
  sinks_group(store: HitStore, a: { by: "sink" | "tag" | "href" | "fingerprint" }) {
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
    store.setScope(a.domains); // throws on empty/too-broad entries
    return { domains: store.getScope() };
  },
};

// Plain-hostname scope match with explicit boundaries (no free regex).
// Allows host === d and any subdomain (host endsWith "." + d); rejects evil-ex.com,
// ex.com.evil.com, notex.com.
export function hostInScope(urlStr: string, scope: string[]): boolean {
  let host: string;
  try {
    host = new URL(urlStr).hostname.toLowerCase();
  } catch {
    return false;
  }
  return scope.some((raw) => {
    const d = String(raw).trim().toLowerCase();
    if (!d) return false;
    return host === d || host.endsWith("." + d);
  });
}

// Control handlers push commands to the extension over the WS bridge.
// Safety interlock: refuse unless a non-trivial authorization scope is set; host-targeted
// actions (arm_debug) additionally require the host to match the scope.
export function makeControl(bridge: WsBridge, store: HitStore) {
  const requireScope = (): string[] => {
    const scope = store.getScope().map((s) => s.trim()).filter(Boolean);
    if (!scope.length) {
      throw new Error("Refused: no authorization scope set. Call scope_set with the authorized host(s) first.");
    }
    return scope;
  };
  return {
    async set_canary(a: { value: string }) {
      requireScope();
      return bridge.send("set_canary", { value: a.value });
    },
    async set_mode(a: { mode: "recon" | "hunt" }) {
      requireScope();
      return bridge.send("set_mode", { mode: a.mode });
    },
    async select_config(a: { name: string }) {
      requireScope();
      return bridge.send("select_config", { name: a.name });
    },
    async apply_config(a: { name: string; content: unknown }) {
      requireScope();
      return bridge.send("apply_config", { name: a.name, content: a.content });
    },
    // Resolve the per-hit fingerprint server-side from the hit id so the caller never has
    // to copy the base64 blob and can't confuse it with the set_canary marker.
    async arm_debug(a: { id?: number; href?: string; fingerprint?: string }) {
      const scope = requireScope();
      let href = a.href;
      let fingerprint = a.fingerprint;
      if (a.id != null) {
        const h = store.get(a.id);
        if (!h) throw new Error(`no hit with id ${a.id}`);
        fingerprint = h.debug;
        href = href || h.href;
      }
      if (!href) throw new Error("href or id required");
      if (!hostInScope(href, scope)) {
        throw new Error(`Refused: ${href} is not in the authorized scope ${JSON.stringify(scope)}`);
      }
      if (!fingerprint) throw new Error("fingerprint or id required");
      return bridge.send("arm_debug", { href, canary: fingerprint });
    },
    async get_state(_a: {}) {
      return bridge.send("get_state", {});
    },
    async reset_hits(_a: {}) {
      requireScope();
      return { cleared: store.clearHits() };
    },
  };
}
