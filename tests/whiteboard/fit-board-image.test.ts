import { describe, expect, it } from "vitest";
import { fittedLongestSide, imagePreparePlan } from "../../lib/whiteboard/prepare-board-image";

const MB = 1024 * 1024;

describe("fittedLongestSide", () => {
  it("keeps the longest side at or under 2000px and never upscales", () => {
    expect(fittedLongestSide(4000, 1000)).toEqual({ width: 2000, height: 500 });
    expect(fittedLongestSide(1000, 4000)).toEqual({ width: 500, height: 2000 });
    expect(fittedLongestSide(2000, 2000)).toEqual({ width: 2000, height: 2000 });
    expect(fittedLongestSide(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fittedLongestSide(50, 40)).toEqual({ width: 50, height: 40 });

    for (const [width, height] of [
      [5000, 10],
      [10, 5000],
      [3333, 2222],
      [1999, 4000],
    ] as const) {
      const fitted = fittedLongestSide(width, height);
      expect(Math.max(fitted.width, fitted.height)).toBeLessThanOrEqual(2000);
      expect(fitted.width).toBeLessThanOrEqual(width);
      expect(fitted.height).toBeLessThanOrEqual(height);
    }
  });
});

describe("imagePreparePlan", () => {
  it("leaves GIFs on the original path and only downscales large jpeg, png, and webp files", () => {
    expect(imagePreparePlan({ type: "image/gif", size: 3 * MB })).toBe("passthrough");
    expect(imagePreparePlan({ type: "image/gif", size: 8 * MB })).toBe("passthrough");
    expect(imagePreparePlan({ type: "image/jpeg", size: 1.5 * MB })).toBe("passthrough");
    expect(imagePreparePlan({ type: "image/jpeg", size: 1.5 * MB + 1 })).toBe("downscale");
    expect(imagePreparePlan({ type: "image/png", size: 2 * MB })).toBe("downscale");
    expect(imagePreparePlan({ type: "image/webp", size: 2 * MB })).toBe("downscale");
  });
});
