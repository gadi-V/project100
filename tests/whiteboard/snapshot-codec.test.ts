import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_GZIP_LIMIT_BYTES,
  SnapshotTooLargeError,
  decodePageSnapshot,
  encodePageSnapshot,
  snapshotObjectPath,
  versionsEligibleForGc,
} from "../../lib/whiteboard/snapshot-codec";

describe("page snapshot codec", () => {
  it("round-trips a gzip JSON object and rounds vector points to 1 decimal", () => {
    const pts = Array.from({ length: 40 }, (_, index) => index + 0.14);
    const encoded = encodePageSnapshot({
      paperStyle: "ruled",
      elements: [
        {
          kind: "stroke",
          id: "stroke-1",
          tool: "pen",
          pts,
          points: [{ x: 10.14, y: 20.16 }],
          pageIndex: 0,
        },
      ],
    });

    expect(encoded[0]).toBe(0x1f);
    expect(encoded[1]).toBe(0x8b);
    expect(encoded.byteLength).toBeLessThan(SNAPSHOT_GZIP_LIMIT_BYTES);
    expect(JSON.parse(gunzipSync(encoded).toString("utf8"))).toMatchObject({ v: 1, paperStyle: "ruled" });

    const decoded = decodePageSnapshot(encoded);
    const stroke = decoded.elements[0] as { pts: number[]; points: { x: number; y: number }[] };
    expect(decoded).toMatchObject({ v: 1, paperStyle: "ruled" });
    expect(stroke.pts).toHaveLength(pts.length);
    expect(stroke.pts[0]).toBe(0.1);
    expect(stroke.pts[1]).toBe(1.1);
    expect(stroke.points).toEqual([{ x: 10.1, y: 20.2 }]);
    expect(stroke.pts).toEqual(pts.map((value) => Math.round(value * 10) / 10));
  });

  it("keeps imageId and drops signed urls and data urls", () => {
    const decoded = decodePageSnapshot(
      encodePageSnapshot({
        paperStyle: "grid",
        elements: [
          {
            kind: "image",
            id: "el-1",
            imageId: "img_1",
            url: "https://proj.supabase.co/storage/v1/object/sign/lesson-boards/x?token=secret",
            src: "data:image/png;base64,AAAA",
            signedUrl: "https://cdn.example/temp",
            x: 12,
            y: 24,
            w: 80,
            h: 40,
            pageIndex: 1,
          },
        ],
      }),
    );

    expect(decoded.elements[0]).toEqual({
      kind: "image",
      id: "el-1",
      imageId: "img_1",
      x: 12,
      y: 24,
      w: 80,
      h: 40,
      pageIndex: 1,
    });
    const packed = JSON.stringify(decoded);
    expect(packed).not.toContain("http");
    expect(packed).not.toContain("base64");
    expect(packed).toContain("img_1");
  });

  it("names immutable objects and lists versions older than the three kept", () => {
    expect(snapshotObjectPath("nb-1", 4, 2)).toBe("notebooks/nb-1/pages/4/v2.json.gz");
    expect(versionsEligibleForGc(1)).toEqual([]);
    expect(versionsEligibleForGc(3)).toEqual([]);
    expect(versionsEligibleForGc(4)).toEqual([1]);
    expect(versionsEligibleForGc(6)).toEqual([1, 2, 3]);
  });

  it("refuses a gzip payload over 2MB", () => {
    const blob = randomBytes(3_000_000).toString("base64");
    expect(() =>
      encodePageSnapshot({
        paperStyle: "blank",
        elements: [{ kind: "stroke", id: "big", pts: [0], blob }],
      }),
    ).toThrow(SnapshotTooLargeError);
  });
});
