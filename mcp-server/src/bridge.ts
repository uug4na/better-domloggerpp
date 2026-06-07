import { WebSocketServer, WebSocket } from "ws";
import type { HitStore } from "./db.js";
import type { Hit } from "./types.js";

interface Pending {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WsBridge {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private lastHitTs = 0;
  private hitCount = 0;
  private pending = new Map<number, Pending>();
  private cmdId = 0;

  constructor(private store: HitStore, private port = 8788, private token = "") {}

  // Reject real web origins (a browser tab can't connect) and, if a token is configured,
  // require it in the connection query string. Binding to 127.0.0.1 only blocks remote hosts.
  private verifyClient = ({ req }: { req: import("http").IncomingMessage }): boolean => {
    const origin = req.headers.origin;
    if (origin && /^https?:\/\//i.test(origin)) return false; // web page → reject
    if (this.token) {
      try {
        const u = new URL(req.url || "", "ws://127.0.0.1");
        if (u.searchParams.get("token") !== this.token) return false;
      } catch {
        return false;
      }
    }
    return true;
  };

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ host: "127.0.0.1", port: this.port, verifyClient: this.verifyClient }, () => {
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
    if (r) {
      this.hitCount++;
      this.lastHitTs = r.ts;
    }
  }

  private onMessage(text: string) {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === "ack") return this.onAck(msg);
    if (msg.type === "hello") return; // handshake, no-op
    if (Array.isArray(msg)) msg.forEach((h) => this.ingest(h));
    else if (msg.type === "hits" && Array.isArray(msg.hits)) msg.hits.forEach((h: Hit) => this.ingest(h));
    else if (msg.type === "hit" && msg.hit) this.ingest(msg.hit);
    else if (msg.dupKey) this.ingest(msg); // bare hit object
  }

  private onAck(msg: any) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(msg.error || "command failed"));
  }

  // Push a control command to the connected extension; resolves on its ack.
  send(action: string, args: any = {}, timeoutMs = 5000): Promise<any> {
    const client = [...this.clients].find((c) => c.readyState === 1);
    if (!client) return Promise.reject(new Error("extension not connected"));
    const id = ++this.cmdId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("command timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        client.send(JSON.stringify({ type: "command", id, action, args }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  status() {
    return {
      connected: this.clients.size > 0,
      clients: this.clients.size,
      lastHitTs: this.lastHitTs,
      hitCount: this.hitCount,
    };
  }

  close() {
    this.clients.forEach((c) => c.close());
    this.wss?.close();
  }
}
