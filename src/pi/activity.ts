import { relative, sep } from "node:path";
import type { MemoryObservation, MemoryActivityEvent } from "../core/store.js";

export type ResetReason = "session" | "refresh" | "toggle";
export interface ActivitySnapshot {
  phase: "initial" | "refresh" | "prepared" | "projected";
  empty: boolean;
  projectedAt?: string;
  changed: boolean;
  fault?: string;
  lastSave?: { path: string; at: string; source: "model" | "user" };
  topics: { path: string; at: string; complete: boolean }[];
  truncated: boolean;
}
interface TopicRead {
  at: string;
  digest: string;
  length: number;
  ranges: [number, number][];
}

export class MemoryActivity {
  private session = 0;
  private epoch = 0;
  private state: Omit<ActivitySnapshot, "topics"> = { phase: "initial", empty: true, changed: false, truncated: false };
  private topics = new Map<string, TopicRead>();
  constructor(private readonly now: () => Date = () => new Date()) {}
  reset(reason: ResetReason = "session"): void {
    this.epoch++;
    if (reason === "session") {
      this.session++;
      this.topics.clear();
      this.state = { phase: "initial", empty: true, changed: false, truncated: false };
    } else {
      const { lastSave, truncated } = this.state;
      this.state = { phase: "refresh", empty: true, changed: false, truncated, ...(lastSave ? { lastSave } : {}) };
    }
  }
  capture(): () => boolean {
    const session = this.session;
    const epoch = this.epoch;
    return () => session === this.session && epoch === this.epoch;
  }
  prepared(empty: boolean): void {
    this.state = { ...this.state, phase: "prepared", empty, changed: false, projectedAt: undefined, fault: undefined };
  }
  projected(): void {
    this.state.phase = "projected";
    this.state.projectedAt ??= this.now().toISOString();
    this.state.fault = undefined;
  }
  fault(message: string): void { this.state.fault = message; }
  pause(message: string): void {
    this.epoch++;
    this.state.phase = "initial";
    this.state.projectedAt = undefined;
    this.state.fault = message;
  }
  bind(projectDir: string): MemoryObservation {
    return {
      capture: (source) => {
        const valid = this.capture();
        return (event: MemoryActivityEvent) => {
          if (!valid()) return;
          const path = relative(projectDir, event.path).split(sep).join("/");
          if (!path || path.startsWith("../") || path === "..") return;
          if (event.kind === "save") this.state.lastSave = { path, at: this.now().toISOString(), source };
          if ((event.kind === "save" || event.kind === "delete") && path === "MEMORY.md"
            && (this.state.phase === "prepared" || this.state.phase === "projected")) this.state.changed = true;
          if (event.kind !== "read" || path === "MEMORY.md" || event.end <= event.start) return;
          let topic = this.topics.get(path);
          if (!topic || topic.digest !== event.digest) topic = { at: "", digest: event.digest, length: event.length, ranges: [] };
          topic.at = this.now().toISOString();
          const ranges = [...topic.ranges, [event.start, event.end] as [number, number]].sort((a, b) => a[0] - b[0]);
          topic.ranges = [];
          for (const range of ranges) {
            const last = topic.ranges.at(-1);
            if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
            else topic.ranges.push([...range]);
          }
          this.topics.delete(path);
          this.topics.set(path, topic);
          if (this.topics.size > 20) {
            this.topics.delete(this.topics.keys().next().value!);
            this.state.truncated = true;
          }
        };
      },
    };
  }
  snapshot(): ActivitySnapshot {
    return {
      ...this.state,
      ...(this.state.lastSave ? { lastSave: { ...this.state.lastSave } } : {}),
      topics: [...this.topics].reverse().map(([path, topic]) => ({ path, at: topic.at,
        complete: topic.ranges.length === 1 && topic.ranges[0][0] === 0 && topic.ranges[0][1] === topic.length })),
    };
  }
}
