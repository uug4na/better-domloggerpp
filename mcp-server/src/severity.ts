import type { Hit, Severity } from "./types.js";

// Ported from app/src/devtools/panel/js/utils.js rowSeverity — keep in sync.
const DANGEROUS =
  /innerHTML|outerHTML|document\.write|writeln|insertAdjacentHTML|setHTMLUnsafe|parseHTMLUnsafe|createContextualFragment|\beval\b|execScript|setTimeout|setInterval|\bFunction\b|\.src\b|srcdoc|\.href\b|location|setAttribute|appendChild|insertBefore|postMessage|__proto__|importScripts/i;
const MEDIUM = /^set:|cookie|fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|[sS]torage|window\.open/;

export function severityOf(hit: Pick<Hit, "sink" | "type" | "badge">): Severity {
  if (hit.badge) return "high";
  const sink = String(hit.sink || "");
  if (DANGEROUS.test(sink)) return "high";
  if (hit.type === "event" || MEDIUM.test(sink)) return "med";
  return "low";
}
