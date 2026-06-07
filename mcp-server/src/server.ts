import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HitStore } from "./db.js";
import { WsBridge } from "./bridge.js";
import { handlers, makeControl } from "./tools.js";

const store = new HitStore(process.env.DOMLOGGER_DB || "./domlogger.sqlite");
const bridge = new WsBridge(
  store,
  Number(process.env.DOMLOGGER_WS_PORT || 8788),
  process.env.DOMLOGGER_BRIDGE_TOKEN || ""
);
const control = makeControl(bridge, store);
const server = new McpServer({ name: "domloggerpp", version: "0.1.0" });

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
// Control tools surface refusals/failures as data, not transport errors.
const ctl = (fn: (a: any) => Promise<any>) => async (a: any) => {
  try {
    return json({ ok: true, result: await fn(a) });
  } catch (e: any) {
    return json({ ok: false, error: String((e && e.message) || e) });
  }
};

server.tool(
  "sinks_query",
  "Query stored sink hits. `data` = substring of the sink data (use this to find your canary marker). `fingerprint` = the per-hit sink hash (hit.debug). Plus tag/sink/href/frame/severity.",
  {
    data: z.string().optional(),
    fingerprint: z.string().optional(),
    tag: z.string().optional(),
    sink: z.string().optional(),
    href: z.string().optional(),
    frame: z.string().optional(),
    severity: z.enum(["high", "med", "low"]).optional(),
    since_cursor: z.number().optional(),
    limit: z.number().optional(),
  },
  async (a) => json(handlers.sinks_query(store, a as any))
);

server.tool(
  "sink_get",
  "Get one full sink hit (complete trace + data) by id.",
  { id: z.number() },
  async (a) => json(handlers.sink_get(store, a))
);

server.tool(
  "sinks_since",
  "Oracle: new hits since a cursor. Returns next_cursor. Poll after an attack to see if it fired.",
  { cursor: z.number() },
  async (a) => json(handlers.sinks_since(store, a))
);

server.tool(
  "sinks_group",
  "Count hits grouped by a field (recon surface map).",
  { by: z.enum(["sink", "tag", "href", "fingerprint"]) },
  async (a) => json(handlers.sinks_group(store, a))
);

server.tool("alerts_list", "List only hits that triggered an alert (badge=true).", {}, async () =>
  json(handlers.alerts_list(store, {}))
);

server.tool("scope_get", "Get the authorized target allowlist.", {}, async () => json(handlers.scope_get(store, {})));

server.tool(
  "scope_set",
  "Set the authorized target allowlist (domains/regex).",
  { domains: z.array(z.string()) },
  async (a) => json(handlers.scope_set(store, a))
);

server.tool("bridge_status", "Is the extension connected? last hit + count.", {}, async () =>
  json(bridge.status())
);

// ---- Control tools (push to the extension; require an authorization scope) ----

server.tool(
  "set_canary",
  "Set the active config's canary marker (requires an authorization scope).",
  { value: z.string() },
  ctl((a) => control.set_canary(a))
);

server.tool(
  "set_mode",
  "Switch the active config between recon (log all) and hunt (canary-filtered).",
  { mode: z.enum(["recon", "hunt"]) },
  ctl((a) => control.set_mode(a))
);

server.tool(
  "select_config",
  "Select an existing hooking config by name.",
  { name: z.string() },
  ctl((a) => control.select_config(a))
);

server.tool(
  "apply_config",
  "Add or replace a hooking config by name (content = the config object).",
  { name: z.string(), content: z.record(z.any()) },
  ctl((a) => control.apply_config(a))
);

server.tool(
  "arm_debug",
  "Arm a debugger breakpoint for a specific hit: reload and break when that sink fires again. Pass the hit `id` (preferred — the server resolves the fingerprint); host must be in scope.",
  { id: z.number().optional(), href: z.string().optional(), fingerprint: z.string().optional() },
  ctl((a) => control.arm_debug(a))
);

server.tool(
  "config_status",
  "Read back the live extension config: selected config name, canary marker, and recon/hunt mode. Use after a config change and a page reload.",
  {},
  ctl(() => control.get_state({}))
);

server.tool(
  "reset_hits",
  "Clear all stored sink hits (fresh start for a new target). Requires an authorization scope.",
  {},
  ctl(() => control.reset_hits({}))
);

await bridge.listen();
await server.connect(new StdioServerTransport());
