import { describe, it, expect } from "vitest";
import { severityOf } from "../src/severity.js";

describe("severityOf", () => {
  it("alert badge => high", () => {
    expect(severityOf({ badge: true, sink: "fetch" } as any)).toBe("high");
  });
  it("dangerous sink => high", () => {
    expect(severityOf({ sink: "set:Element.prototype.innerHTML" } as any)).toBe("high");
    expect(severityOf({ sink: "eval" } as any)).toBe("high");
  });
  it("set: / event / fetch => med", () => {
    expect(severityOf({ sink: "set:HTMLInputElement.prototype.value" } as any)).toBe("med");
    expect(severityOf({ type: "event", sink: "message" } as any)).toBe("med");
    expect(severityOf({ sink: "fetch" } as any)).toBe("med");
  });
  it("benign lookup => low", () => {
    expect(severityOf({ sink: "document.getElementById" } as any)).toBe("low");
  });
});
