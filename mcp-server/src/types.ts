export interface Hit {
  date: string;
  href: string;
  tag: string;
  type: string; // function|class|attribute|event
  frame: string;
  sink: string;
  data: string;
  trace: string;
  debug: string; // canary
  dupKey: string;
  badge?: boolean;
  notification?: boolean;
}

export type Severity = "high" | "med" | "low";

export interface StoredHit extends Hit {
  id: number;
  ts: number; // server receive time (ms)
  severity: Severity;
  hitCount?: number; // number of times this exact payload+sink fired
}
