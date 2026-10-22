import { gunzipSync, gzipSync } from "node:zlib";

export const SNAPSHOT_GZIP_LIMIT_BYTES = 2 * 1024 * 1024;

const PAPER_STYLES = new Set(["grid", "ruled", "dotted", "blank"]);
const DROPPED_KEYS = new Set(["url", "src", "dataUrl", "signedUrl", "href"]);

export class SnapshotTooLargeError extends Error {
  constructor() {
    super("snapshot gzip exceeds 2MB");
    this.name = "SnapshotTooLargeError";
  }
}

export type PageSnapshotV1 = {
  v: 1;
  paperStyle: string;
  elements: unknown[];
};

export function snapshotObjectPath(notebookId: string, pageIndex: number, version: number): string {
  return `notebooks/${notebookId}/pages/${pageIndex}/v${version}.json.gz`;
}

/** Versions at or below `version - 3`. The three newest objects stay. */
export function versionsEligibleForGc(version: number): number[] {
  const through = version - 3;
  if (!Number.isInteger(version) || through < 1) return [];
  return Array.from({ length: through }, (_, index) => index + 1);
}

function round1(value: number): number {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 10) / 10;
}

function isEphemeralUrl(value: string): boolean {
  return value.startsWith("data:") || value.startsWith("blob:") || /^https?:\/\//i.test(value);
}

function sanitizePointList(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((point) => {
    if (!point || typeof point !== "object") return point;
    const record = point as Record<string, unknown>;
    return {
      ...record,
      ...(typeof record.x === "number" ? { x: round1(record.x) } : {}),
      ...(typeof record.y === "number" ? { y: round1(record.y) } : {}),
    };
  });
}

function sanitizeElement(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (DROPPED_KEYS.has(key)) continue;
    if (typeof item === "string" && isEphemeralUrl(item)) continue;
    if (key === "pts" && Array.isArray(item)) {
      next.pts = item.map((coord) => (typeof coord === "number" ? round1(coord) : coord));
      continue;
    }
    if ((key === "points" || key === "vertices") && Array.isArray(item)) {
      next[key] = sanitizePointList(item);
      continue;
    }
    next[key] = item;
  }
  return next;
}

export function preparePageSnapshot(input: {
  paperStyle: unknown;
  elements: unknown;
}): PageSnapshotV1 {
  const paperStyle = typeof input.paperStyle === "string" && PAPER_STYLES.has(input.paperStyle)
    ? input.paperStyle
    : "grid";
  const elements = Array.isArray(input.elements) ? input.elements.map(sanitizeElement) : [];
  return { v: 1, paperStyle, elements };
}

export function encodePageSnapshot(input: { paperStyle: unknown; elements: unknown }): Buffer {
  const snapshot = preparePageSnapshot(input);
  const gzip = gzipSync(Buffer.from(JSON.stringify(snapshot)));
  if (gzip.byteLength > SNAPSHOT_GZIP_LIMIT_BYTES) throw new SnapshotTooLargeError();
  return gzip;
}

export function decodePageSnapshot(gzip: Buffer): PageSnapshotV1 {
  const parsed = JSON.parse(gunzipSync(gzip).toString("utf8")) as Partial<PageSnapshotV1>;
  if (parsed.v !== 1 || !Array.isArray(parsed.elements)) {
    throw new Error("unsupported snapshot");
  }
  return preparePageSnapshot({
    paperStyle: parsed.paperStyle,
    elements: parsed.elements,
  });
}
