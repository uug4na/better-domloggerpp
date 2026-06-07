// DOMLogger++ AI Bridge — a WebSocket client that streams sink hits up to the local
// DOMLogger MCP server and applies control commands (canary/mode/config/debug) coming down.
// Enabled only when bridgeConfig.url is set (localhost by default). See mcp-server/.

DLBridge = new class {
    constructor() {
        this.ws = null;
        this.url = "";
        this.enabled = false;
        this.queue = [];
        this.maxQueue = 2000;
        this.reconnectTimer = null;
    }

    // cfg: { url, enabled } from storage.local.bridgeConfig
    configure(cfg) {
        const url = (cfg && cfg.url) || "";
        const enabled = !!(cfg && cfg.enabled) && !!url;
        if (url === this.url && enabled === this.enabled) return;
        this.url = url;
        this.enabled = enabled;
        this.disconnect();
        if (this.enabled) this.connect();
    }

    connect() {
        if (!this.enabled || !this.url) return;
        // MV3 (Chromium service worker) is terminated when idle; an alarm wakes it so the
        // bridge can reconnect during quiet periods. Firefox is persistent — no-op there.
        if (typeof browser === "undefined" && extensionAPI.alarms) {
            extensionAPI.alarms.create("dlbridge-keepalive", { periodInMinutes: 0.5 });
        }
        try {
            this.ws = new WebSocket(this.url);
        } catch (e) {
            this.scheduleReconnect();
            return;
        }
        this.ws.onopen = () => {
            this.rawSend({ type: "hello", role: "extension" });
            this.flush();
        };
        this.ws.onmessage = (e) => this.onCommand(e.data);
        this.ws.onclose = () => { this.ws = null; this.scheduleReconnect(); };
        this.ws.onerror = () => { try { this.ws && this.ws.close(); } catch (e) {} };
    }

    scheduleReconnect() {
        if (!this.enabled || this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, 2000);
    }

    disconnect() {
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        if (typeof browser === "undefined" && extensionAPI.alarms) {
            extensionAPI.alarms.clear("dlbridge-keepalive");
        }
        if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
    }

    // Called from the keepalive alarm: reconnect if the socket dropped, else keep traffic alive.
    keepAlive() {
        if (!this.enabled) return;
        if (!this.ws || this.ws.readyState !== 1) this.connect();
        else this.rawSend({ type: "ping" });
    }

    rawSend(obj) {
        if (this.ws && this.ws.readyState === 1) {
            try { this.ws.send(JSON.stringify(obj)); return true; } catch (e) {}
        }
        return false;
    }

    // Hits (objects with dupKey) are queued when offline; transient messages are dropped.
    send(hit) {
        if (this.rawSend(hit)) return;
        if (hit && hit.dupKey) {
            this.queue.push(hit);
            if (this.queue.length > this.maxQueue) this.queue.shift();
        }
    }

    flush() {
        const q = this.queue;
        this.queue = [];
        for (const h of q) this.send(h);
    }

    // ---- Control (commands coming down from the MCP server) ----

    onCommand(raw) {
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { return; }
        if (!msg || msg.type !== "command") return;
        this.applyCommand(msg.action, msg.args || {})
            .then((result) => this.rawSend({ type: "ack", id: msg.id, ok: true, ...(result !== undefined ? { result } : {}) }))
            .catch((err) => this.rawSend({ type: "ack", id: msg.id, ok: false, error: String(err && err.message || err) }));
    }

    getLocal(keys) {
        return new Promise((resolve) => extensionAPI.storage.local.get(keys, resolve));
    }
    setLocal(obj) {
        return new Promise((resolve) => extensionAPI.storage.local.set(obj, resolve));
    }

    async selectedContent(hooksData) {
        const s = hooksData.hooksSettings[hooksData.selectedHook];
        if (!s) throw new Error("no selected config");
        if (!s.content) s.content = {};
        return s.content;
    }

    async applyCommand(action, args) {
        const data = await this.getLocal("hooksData");
        const hooksData = data.hooksData;

        switch (action) {
            case "set_canary": {
                if (!hooksData) throw new Error("no hooksData");
                const content = await this.selectedContent(hooksData);
                content.globals = content.globals || {};
                content.globals.canary = String(args.value || "");
                await this.setLocal({ hooksData });
                return;
            }
            case "set_mode": {
                if (!hooksData) throw new Error("no hooksData");
                if (args.mode !== "recon" && args.mode !== "hunt") throw new Error("mode must be recon|hunt");
                const content = await this.selectedContent(hooksData);
                content.config = content.config || {};
                content.config["*"] = content.config["*"] || {};
                content.config["*"].match = args.mode === "hunt"
                    ? ["exec:return new RegExp(domlogger.globals.canary)"]
                    : ["exec:return /.*/"];
                await this.setLocal({ hooksData });
                return;
            }
            case "select_config": {
                if (!hooksData) throw new Error("no hooksData");
                const idx = hooksData.hooksSettings.findIndex((c) => c.name === args.name);
                if (idx === -1) throw new Error(`no config named ${args.name}`);
                hooksData.selectedHook = idx;
                await this.setLocal({ hooksData });
                return;
            }
            case "apply_config": {
                if (!hooksData) throw new Error("no hooksData");
                const content = args.content;
                if (!content || typeof content !== "object" || Array.isArray(content))
                    throw new Error("content must be an object");
                if (content.hooks && typeof content.hooks !== "object") throw new Error("hooks must be an object");
                if (content.config && typeof content.config !== "object") throw new Error("config must be an object");
                if (JSON.stringify(content).length > 1000000) throw new Error("config too large");
                const name = String(args.name || "ai-config");
                // Protect the reserved GLOBAL (0) and DEFAULT (1) configs from the bridge.
                if (name === "GLOBAL" || name === "DEFAULT") throw new Error("cannot overwrite reserved config");
                const idx = hooksData.hooksSettings.findIndex((c) => c.name === name);
                if (idx === 0 || idx === 1) throw new Error("cannot overwrite reserved config");
                if (idx > 1) hooksData.hooksSettings[idx].content = content;
                else hooksData.hooksSettings.push({ name, content });
                await this.setLocal({ hooksData });
                return;
            }
            case "arm_debug": {
                if (!args.href) throw new Error("href required");
                await this.setLocal({ debugCanary: { href: String(args.href), canary: String(args.canary || "") } });
                return;
            }
            case "get_state": {
                if (!hooksData) throw new Error("no hooksData");
                const s = hooksData.hooksSettings[hooksData.selectedHook];
                const content = (s && s.content) || {};
                const match = (content.config && content.config["*"] && content.config["*"].match) || [];
                const matchStr = Array.isArray(match) ? match.join(" ") : String(match);
                let mode = "unknown";
                if (matchStr.includes("globals.canary")) mode = "hunt";
                else if (/return\s+\/\.\*\//.test(matchStr)) mode = "recon";
                return {
                    selectedConfig: s ? s.name : null,
                    selectedHook: hooksData.selectedHook,
                    canary: (content.globals && content.globals.canary) || "",
                    mode,
                };
            }
            default:
                throw new Error(`unknown action ${action}`);
        }
    }
};

// MV3 keepalive: the alarm wakes the service worker; revive the bridge connection.
if (typeof browser === "undefined" && extensionAPI.alarms) {
    extensionAPI.alarms.onAlarm.addListener((alarm) => {
        if (alarm && alarm.name === "dlbridge-keepalive") DLBridge.keepAlive();
    });
}
