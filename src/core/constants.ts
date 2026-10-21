export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_BYTES = 25 * 1024;
export const INDEX_WARNING_RATIO = 0.9;
export const CONFIG_VERSION_LEGACY = 1;
export const CONFIG_VERSION_PROJECTS = 2;
export const LOCK_STALE_MS = 10_000;
export const LOCK_UPDATE_MS = 2_000;
export const LOCK_RETRY_COUNT = 30;
export const LOCK_RETRY_MS = 100;
export const SUPPORTED_HOST_RANGE = { min: "1.2.0", max: "1.3.0" } as const;

export function parseHostVersion(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9.-]+)?$/.exec(version);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function hostVersionStatus(version: string | null, range = SUPPORTED_HOST_RANGE): "unchecked" | "ok" | "out-of-range" {
  if (!version) return "unchecked";
  const parsed = parseHostVersion(version);
  const min = parseHostVersion(range.min);
  const max = parseHostVersion(range.max);
  if (!parsed || !min || !max) return "unchecked";
  return compare(parsed, min) >= 0 && compare(parsed, max) <= 0 ? "ok" : "out-of-range";
}
