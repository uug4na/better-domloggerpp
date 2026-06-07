import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { HitStore } from "../src/db.js";
import { WsBridge } from "../src/bridge.js";

const mkHit = (dupKey: string) => ({
  date: "d",
  href: "https://ex.com/",
  tag: "XSS",
  type: "attribute",
  frame: "top",
  sink: "set:div.innerHTML",
  data: "x",
  trace: "t",
  debug: "cy",
  dupKey,
  badge: false,
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
