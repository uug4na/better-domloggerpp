import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { HitStore } from "../src/db.js";
import { WsBridge } from "../src/bridge.js";
import { makeControl } from "../src/tools.js";
import type { Hit } from "../src/types.js";

const hit = (o: Partial<Hit>): Hit => ({
  date: "d", href: "https://ex.com/", tag: "XSS", type: "attribute", frame: "top",
  sink: "set:div.innerHTML", data: "x", trace: "t", debug: "FP", dupKey: "k", badge: false, ...o,
});

function fakeExtension(port: number, opts: { failOn?: string } = {}) {
  const received: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on("message", (buf) => {
    const msg = JSON.parse(String(buf));
    if (msg.type === "command") {
      received.push(msg);
      if (opts.failOn === msg.action) ws.send(JSON.stringify({ type: "ack", id: msg.id, ok: false, error: "boom" }));
      else ws.send(JSON.stringify({ type: "ack", id: msg.id, ok: true }));
    }
  });
  const ready = new Promise<void>((r) => ws.on("open", () => r()));
  return { ws, received, ready };
}

describe("control round-trip + scope guard", () => {
  let bridge: WsBridge;
  afterEach(() => bridge?.close());

  it("refuses control when no scope is set", async () => {
    const store = new HitStore(":memory:");
    bridge = new WsBridge(store, 0);
    await bridge.listen();
    const control = makeControl(bridge, store);
    await expect(control.set_canary({ value: "x" })).rejects.toThrow(/no authorization scope/i);
  });

  it("sends a command and resolves on the extension ack", async () => {
    const store = new HitStore(":memory:");
    store.setScope(["ex.com"]);
    bridge = new WsBridge(store, 0);
    const port = await bridge.listen();
    const ext = fakeExtension(port);
    await ext.ready;
    const control = makeControl(bridge, store);
    const res = await control.set_canary({ value: "dl9z" });
    expect(res.ok).toBe(true);
    expect(ext.received[0]).toMatchObject({ action: "set_canary", args: { value: "dl9z" } });
    ext.ws.close();
  });

  it("arm_debug refuses out-of-scope and lookalike hosts, allows in-scope by id", async () => {
    const store = new HitStore(":memory:");
    store.setScope(["ex.com"]);
    bridge = new WsBridge(store, 0);
    const port = await bridge.listen();
    const ext = fakeExtension(port);
    await ext.ready;
    const control = makeControl(bridge, store);

    await expect(control.arm_debug({ href: "https://evil.test/x", fingerprint: "fp" })).rejects.toThrow(/not in the authorized scope/i);
    // lookalikes that an unanchored regex would have wrongly allowed:
    await expect(control.arm_debug({ href: "https://evil-ex.com/x", fingerprint: "fp" })).rejects.toThrow(/scope/i);
    await expect(control.arm_debug({ href: "https://ex.com.evil.com/x", fingerprint: "fp" })).rejects.toThrow(/scope/i);

    const stored = store.insert(hit({ dupKey: "k1", href: "https://app.ex.com/p", debug: "FP123" }));
    const ok = await control.arm_debug({ id: stored.id });
    expect(ok.ok).toBe(true);
    const armed = ext.received.find((m) => m.action === "arm_debug");
    expect(armed.args.canary).toBe("FP123"); // resolved fingerprint, not a marker
    expect(armed.args.href).toBe("https://app.ex.com/p");
    ext.ws.close();
  });

  it("propagates an extension nack as a rejection", async () => {
    const store = new HitStore(":memory:");
    store.setScope(["ex.com"]);
    bridge = new WsBridge(store, 0);
    const port = await bridge.listen();
    const ext = fakeExtension(port, { failOn: "set_mode" });
    await ext.ready;
    const control = makeControl(bridge, store);
    await expect(control.set_mode({ mode: "hunt" })).rejects.toThrow(/boom/);
    ext.ws.close();
  });

  it("rejects when no extension is connected", async () => {
    const store = new HitStore(":memory:");
    store.setScope(["ex.com"]);
    bridge = new WsBridge(store, 0);
    await bridge.listen();
    const control = makeControl(bridge, store);
    await expect(control.set_canary({ value: "x" })).rejects.toThrow(/not connected/i);
  });
});
