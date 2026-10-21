import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applySyncedImage,
  boardImageSrc,
  imageAddEvent,
  loadBoardImage,
  renderBoardPageDataUrl,
  type BoardImageEl,
} from "../../lib/whiteboard/board-image";

const IMAGE = "abcdefghijkl";

function element(overrides: Partial<BoardImageEl> = {}): BoardImageEl {
  return {
    kind: "image",
    id: "draw-1",
    imageId: IMAGE,
    x: 24,
    y: 40,
    w: 320,
    h: 200,
    rotation: 0,
    crop: null,
    pageIndex: 0,
    ...overrides,
  };
}

function recordingCanvas() {
  const drawn: unknown[] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext(_kind: "2d") {
      const ctx = {
        drawImage(...args: unknown[]) {
          drawn.push(args[0]);
        },
      };
      return new Proxy(ctx, {
        get(target, prop, receiver) {
          if (prop in target) return Reflect.get(target, prop, receiver);
          return () => undefined;
        },
        set() {
          return true;
        },
      });
    },
    toDataURL() {
      return drawn.length > 0 ? "data:image/png;base64,WITH_IMAGE" : "data:image/png;base64,EMPTY";
    },
  };
  return { canvas, drawn };
}

describe("board image sync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps an image add event under 1,400 bytes and lets a second client render it by id", () => {
    const event = imageAddEvent(element());
    const encoded = JSON.stringify(event);

    expect(encoded.length).toBeLessThan(1400);
    expect(event.add).not.toHaveProperty("url");
    expect(event.add.imageId).toBe(IMAGE);

    const second = applySyncedImage(event.add);
    expect(second?.element.imageId).toBe(IMAGE);
    expect(second?.legacyUrl).toBeNull();
    expect(boardImageSrc(second!.element.imageId)).toBe(`/api/board-images/${IMAGE}`);
    expect(JSON.stringify(imageAddEvent(second!.element))).not.toContain("http");
  });

  it("reads a legacy url for display and does not send it onward", () => {
    const legacy = applySyncedImage({
      kind: "image",
      id: IMAGE,
      url: "https://proj.supabase.co/storage/v1/object/sign/lesson-boards/board-images/abcdefghijkl.png?token=legacy",
      x: 10,
      y: 12,
      w: 80,
      h: 60,
      rotation: 0,
      crop: null,
      pageIndex: 1,
    });

    expect(legacy?.legacyUrl).toContain("token=legacy");
    expect(legacy?.element).not.toHaveProperty("url");
    expect(legacy?.element.imageId).toBe(IMAGE);
    expect(JSON.stringify(imageAddEvent(legacy!.element))).not.toContain("token=legacy");
  });

  it("retries a failed image load once and repaints when it arrives", async () => {
    let attempts = 0;
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      complete = false;
      naturalWidth = 0;
      set src(_value: string) {
        attempts += 1;
        queueMicrotask(() => {
          if (attempts === 1) {
            this.onerror?.();
            return;
          }
          this.complete = true;
          this.naturalWidth = 8;
          this.onload?.();
        });
      }
    }
    vi.stubGlobal("Image", FakeImage);

    const onLoad = vi.fn();
    const cache = new Map<string, HTMLImageElement>();
    const loaded = await loadBoardImage(element(), cache, onLoad);

    expect(attempts).toBe(2);
    expect(loaded?.naturalWidth).toBe(8);
    expect(cache.get("draw-1")).toBe(loaded);
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it("includes a loaded image in the export and warns when one is still missing", async () => {
    const el = element();
    const bitmap = { complete: true, naturalWidth: 12 } as HTMLImageElement;
    const ready = recordingCanvas();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const included = await renderBoardPageDataUrl({
      pageIndex: 0,
      elements: [el],
      images: new Map([[el.id, bitmap]]),
      createCanvas: () => ready.canvas,
      drawBase() {},
      drawImage(_ctx, _image, bitmapArg) {
        ready.canvas.getContext("2d")?.drawImage(bitmapArg, 0, 0);
      },
    });

    expect(included.dataUrl).toBe("data:image/png;base64,WITH_IMAGE");
    expect(included.included).toEqual([el.id]);
    expect(ready.drawn).toEqual([bitmap]);

    const skipped = await renderBoardPageDataUrl({
      pageIndex: 0,
      elements: [el],
      images: new Map(),
      createCanvas: () => recordingCanvas().canvas,
      drawBase() {},
      drawImage() {},
      load: async () => null,
    });

    expect(skipped.skipped).toEqual([el.imageId]);
    expect(warn).toHaveBeenCalled();
  });

  it("returns an empty frame when toDataURL throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await renderBoardPageDataUrl({
      pageIndex: 0,
      elements: [],
      images: new Map(),
      createCanvas: () => ({
        width: 0,
        height: 0,
        getContext: () => ({} as CanvasRenderingContext2D),
        toDataURL: () => {
          throw new Error("tainted");
        },
      }),
      drawBase() {},
      drawImage() {},
    });

    expect(result.dataUrl).toBe("");
  });
});
