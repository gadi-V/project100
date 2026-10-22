import { describe, expect, it } from "vitest";
import { BOARD_UPLOAD_MAX_BYTES, imagePreparePlan } from "../../lib/whiteboard/prepare-board-image";
import {
  ACCEPTED_IMAGE_MIME_TYPES,
  BOARD_DND_MAX_BYTES,
  BOARD_DND_MAX_FILES,
  BOARD_DND_RAW_MAX_BYTES,
  BOARD_DND_STAGGER_PX,
  IMAGE_STILL_TOO_LARGE_HINT,
  NOTEBOOK_NOT_READY_HINT,
  applyImageDropDecision,
  applyPasteDecision,
  calculateDroppedImagePosition,
  calculateStaggeredOffsets,
  dataTransferHasFiles,
  decideImageDrop,
  clipboardDataHasBoardShapeMarker,
  decidePasteAction,
  extractImageFromClipboard,
  issueBoardShapeMarker,
  imageFilesFromDataTransfer,
  inspectImageDataTransfer,
  isTargetEditable,
  mostVisiblePageIndex,
} from "../../lib/whiteboard/board-dnd";

const MB = 1024 * 1024;

function imageFile(type: string, name = "photo", size = 128, lastModified = 1): File {
  const file = new File([new Uint8Array([1])], name, { type: "image/png", lastModified });
  Object.defineProperty(file, "size", { value: size });
  Object.defineProperty(file, "type", { value: type });
  return file;
}

type FakeItem = {
  kind: string;
  type?: string;
  getAsFile?: () => File | null;
  webkitGetAsEntry?: () => { isDirectory?: boolean } | null;
};

function transfer(options: {
  items?: FakeItem[];
  files?: File[];
  types?: string[];
  throwItems?: boolean;
  throwFiles?: boolean;
  throwTypes?: boolean;
}): DataTransfer {
  return {
    get items() {
      if (options.throwItems) throw new Error("items blocked");
      return (options.items ?? []) as unknown as DataTransferItemList;
    },
    get files() {
      if (options.throwFiles) throw new Error("files blocked");
      return (options.files ?? []) as unknown as FileList;
    },
    get types() {
      if (options.throwTypes) throw new Error("types blocked");
      return (options.types ?? []) as unknown as DOMStringList;
    },
  } as unknown as DataTransfer;
}

function fileItem(file: File | null, entry?: () => { isDirectory?: boolean } | null): FakeItem {
  return {
    kind: "file",
    type: file?.type,
    getAsFile: () => file,
    webkitGetAsEntry: entry,
  };
}

describe("imageFilesFromDataTransfer", () => {
  it("accepts jpeg, png, webp, and gif and shares the upload byte cap", () => {
    expect(BOARD_DND_MAX_BYTES).toBe(BOARD_UPLOAD_MAX_BYTES);
    expect(BOARD_DND_MAX_BYTES).toBe(4 * MB);
    expect(ACCEPTED_IMAGE_MIME_TYPES).toEqual(["image/jpeg", "image/png", "image/webp", "image/gif"]);

    const files = [
      imageFile("image/jpeg", "a.jpg"),
      imageFile(" image/PNG ", "b.png"),
      imageFile("image/webp", "c.webp"),
      imageFile("image/gif", "d.gif"),
    ];
    const dt = transfer({
      items: files.map((file) => fileItem(file, () => null)),
    });

    expect(imageFilesFromDataTransfer(dt).map((file) => file.name)).toEqual(["a.jpg", "b.png", "c.webp", "d.gif"]);
  });

  it("rejects non-images, scripts, archives, svg, and empty blobs", () => {
    const pdf = imageFile("application/pdf", "notes.pdf");
    const exe = imageFile("application/x-msdownload", "run.exe");
    const script = imageFile("application/javascript", "evil.js");
    const textScript = imageFile("text/javascript", "evil2.js");
    const zip = imageFile("application/zip", "pack.zip");
    const svg = imageFile("image/svg+xml", "icon.svg");
    const plain = imageFile("text/plain", "note.txt");
    const html = imageFile("text/html", "page.html");
    const empty = imageFile("image/png", "empty.png", 0);
    const png = imageFile("image/png", "ok.png");
    const dt = transfer({
      items: [pdf, exe, script, textScript, zip, svg, plain, html, empty, png].map((file) => fileItem(file)),
    });

    const report = inspectImageDataTransfer(dt);
    expect(report.accepted.map((file) => file.name)).toEqual(["ok.png"]);
    expect(report.rejected.map((item) => item.reason)).toEqual([
      "mime",
      "mime",
      "mime",
      "mime",
      "mime",
      "mime",
      "mime",
      "mime",
      "empty",
    ]);
  });

  it("caps a drop of 8 images at the first 5", () => {
    const files = Array.from({ length: 8 }, (_, i) => imageFile("image/jpeg", `n${i}.jpg`));
    const report = inspectImageDataTransfer(transfer({ files }));

    expect(BOARD_DND_MAX_FILES).toBe(5);
    expect(report.accepted.map((file) => file.name)).toEqual(["n0.jpg", "n1.jpg", "n2.jpg", "n3.jpg", "n4.jpg"]);
    expect(report.truncated.map((file) => file.name)).toEqual(["n5.jpg", "n6.jpg", "n7.jpg"]);
    expect(imageFilesFromDataTransfer(transfer({ files }))).toHaveLength(5);
  });

  it("rejects a GIF over 4MB, accepts a 10MB JPEG, and does not let the GIF take a slot", () => {
    const gif = imageFile("image/gif", "huge.gif", 4 * MB + 1);
    const exactGif = imageFile("image/gif", "exact.gif", 4 * MB);
    const jpeg = imageFile("image/jpeg", "photo.jpg", 10 * MB);
    const rawLimit = imageFile("image/png", "raw.png", BOARD_DND_RAW_MAX_BYTES);
    const overRaw = imageFile("image/webp", "over.webp", BOARD_DND_RAW_MAX_BYTES + 1);
    expect(BOARD_DND_RAW_MAX_BYTES).toBe(25 * MB);
    expect(imagePreparePlan({ type: "image/jpeg", size: 10 * MB })).toBe("downscale");
    expect(imagePreparePlan({ type: "image/gif", size: 10 * MB })).toBe("passthrough");

    const report = inspectImageDataTransfer(transfer({ files: [gif, exactGif, jpeg, rawLimit, overRaw] }));
    expect(report.rejected).toEqual([
      { name: "huge.gif", reason: "size" },
      { name: "over.webp", reason: "size" },
    ]);
    expect(report.accepted.map((file) => file.name)).toEqual(["exact.gif", "photo.jpg", "raw.png"]);

    const rest = Array.from({ length: 4 }, (_, i) => imageFile("image/webp", `w${i}.webp`));
    const slotted = inspectImageDataTransfer(transfer({ files: [gif, jpeg, ...rest] }));
    expect(slotted.rejected).toEqual([{ name: "huge.gif", reason: "size" }]);
    expect(slotted.accepted.map((file) => file.name)).toEqual(["photo.jpg", "w0.webp", "w1.webp", "w2.webp", "w3.webp"]);
    expect(slotted.truncated).toEqual([]);
  });

  it("returns an empty list for null, undefined, and empty transfers", () => {
    expect(imageFilesFromDataTransfer(null)).toEqual([]);
    expect(imageFilesFromDataTransfer(undefined)).toEqual([]);
    expect(inspectImageDataTransfer(transfer({}))).toEqual({ accepted: [], rejected: [], truncated: [] });
    expect(imageFilesFromDataTransfer(transfer({ items: [], files: [] }))).toEqual([]);
  });

  it("skips string items, directories, duplicate files, and broken item readers", () => {
    const png = imageFile("image/png", "once.png");
    const folder = imageFile("", "My Folder", 0);
    const dt = transfer({
      items: [
        { kind: "string", type: "text/html", getAsFile: () => png },
        { kind: "file" },
        { kind: "file", getAsFile: () => null },
        fileItem(folder, () => ({ isDirectory: true })),
        fileItem(png, () => {
          throw new Error("entry failed");
        }),
        {
          kind: "file",
          getAsFile: () => {
            throw new Error("unreadable");
          },
        },
        fileItem(png),
      ],
      files: [png, imageFile("image/gif", "extra.gif")],
    });

    const report = inspectImageDataTransfer(dt);
    expect(report.accepted.map((file) => file.name)).toEqual(["once.png", "extra.gif"]);
    expect(report.rejected.map((item) => item.reason)).toEqual(["empty", "empty", "directory", "empty"]);
    expect(report.rejected.find((item) => item.reason === "directory")?.name).toBe("My Folder");
  });

  it("falls back to files when items cannot be read and ignores a throwing file list", () => {
    const png = imageFile("image/png", "from-files.png");
    expect(imageFilesFromDataTransfer(transfer({ throwItems: true, files: [png] })).map((file) => file.name)).toEqual([
      "from-files.png",
    ]);
    expect(imageFilesFromDataTransfer(transfer({ items: [fileItem(png)], throwFiles: true })).map((file) => file.name)).toEqual([
      "from-files.png",
    ]);
  });

  it("keeps files already read when the file list throws mid-iteration", () => {
    const png = imageFile("image/png", "kept.png");
    const files = {
      length: 2,
      0: png,
      get 1(): File {
        throw new Error("boom");
      },
    };
    const dt = { items: [], files, types: [] } as unknown as DataTransfer;
    expect(imageFilesFromDataTransfer(dt).map((file) => file.name)).toEqual(["kept.png"]);
  });

  it("rejects a non-finite size and a missing mime", () => {
    const badSize = imageFile("image/png", "nan.png", Number.NaN);
    const noType = imageFile("", "blob.bin", 32);
    const report = inspectImageDataTransfer(transfer({ files: [badSize, noType] }));
    expect(report.accepted).toEqual([]);
    expect(report.rejected).toEqual([
      { name: "nan.png", reason: "empty" },
      { name: "blob.bin", reason: "mime" },
    ]);
  });
});

describe("isTargetEditable", () => {
  it("detects inputs, textareas, contenteditable regions, and Excalidraw text editors", () => {
    expect(isTargetEditable(null)).toBe(false);
    expect(isTargetEditable(undefined as unknown as EventTarget)).toBe(false);
    expect(isTargetEditable("canvas" as unknown as EventTarget)).toBe(false);
    expect(isTargetEditable({ tagName: "CANVAS" } as unknown as EventTarget)).toBe(false);
    expect(isTargetEditable({ tagName: "DIV", className: "board-toolbar-root" } as unknown as EventTarget)).toBe(false);

    expect(isTargetEditable({ tagName: "input" } as unknown as EventTarget)).toBe(true);
    expect(isTargetEditable({ tagName: "TEXTAREA" } as unknown as EventTarget)).toBe(true);
    expect(isTargetEditable({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTargetEditable({ tagName: "DIV", contentEditable: "TRUE" } as unknown as EventTarget)).toBe(true);
    expect(
      isTargetEditable({
        tagName: "DIV",
        getAttribute: (name: string) => (name === "contenteditable" ? "true" : null),
      } as unknown as EventTarget),
    ).toBe(true);

    const editor = { tagName: "DIV", classList: { contains: (token: string) => token === "excalidraw-textEditorContainer" } };
    expect(isTargetEditable(editor as unknown as EventTarget)).toBe(true);
    expect(
      isTargetEditable({
        tagName: "DIV",
        classList: { contains: (token: string) => token === "excalidraw-textEditorArea" },
      } as unknown as EventTarget),
    ).toBe(true);
    expect(
      isTargetEditable({
        tagName: "DIV",
        className: { baseVal: "excalidraw-textEditorContainer" },
      } as unknown as EventTarget),
    ).toBe(true);
  });

  it("walks to an editable ancestor and stops at contenteditable=false", () => {
    const textarea = { tagName: "TEXTAREA" };
    const textNode = { parentElement: textarea };
    expect(isTargetEditable(textNode as unknown as EventTarget)).toBe(true);

    const region = { tagName: "DIV", contentEditable: "true" };
    const span = { tagName: "SPAN", contentEditable: "inherit", parentElement: region };
    expect(isTargetEditable(span as unknown as EventTarget)).toBe(true);

    const locked = { tagName: "DIV", contentEditable: "false", parentElement: region };
    const insideLocked = { tagName: "SPAN", contentEditable: "inherit", parentElement: locked };
    expect(isTargetEditable(locked as unknown as EventTarget)).toBe(false);
    expect(isTargetEditable(insideLocked as unknown as EventTarget)).toBe(false);

    const viaParentNode = { parentElement: null, parentNode: textarea };
    expect(isTargetEditable(viaParentNode as unknown as EventTarget)).toBe(true);
  });

  it("survives a cyclic parent, a throwing classList, and a throwing attribute read", () => {
    const cycle: { parentElement?: unknown; tagName: string } = { tagName: "DIV" };
    cycle.parentElement = cycle;
    expect(isTargetEditable(cycle as unknown as EventTarget)).toBe(false);

    expect(
      isTargetEditable({
        tagName: "DIV",
        className: "excalidraw-textEditorArea",
        classList: {
          contains: () => {
            throw new Error("classList");
          },
        },
      } as unknown as EventTarget),
    ).toBe(true);

    expect(
      isTargetEditable({
        tagName: "DIV",
        getAttribute: () => {
          throw new Error("attribute");
        },
      } as unknown as EventTarget),
    ).toBe(false);

    expect(isTargetEditable({ tagName: "DIV", contentEditable: "inherit" } as unknown as EventTarget)).toBe(false);
  });
});

describe("calculateDroppedImagePosition", () => {
  const cursor = { x: 200, y: 100 };
  const box = { width: 80, height: 40 };

  it("centers a single image on the cursor", () => {
    expect(calculateDroppedImagePosition(cursor, 0, 1, box)).toEqual({ x: 160, y: 80 });
    expect(calculateDroppedImagePosition(cursor, 4, 1, box)).toEqual({ x: 160, y: 80 });
    expect(calculateDroppedImagePosition(cursor, 0, 1)).toEqual(cursor);
    expect(calculateDroppedImagePosition(cursor, 0, 1, { width: 0, height: 40 })).toEqual(cursor);
    expect(calculateDroppedImagePosition(cursor, 0, 1, { width: 10, height: -2 })).toEqual(cursor);
    expect(calculateDroppedImagePosition(cursor, 0, 1, { width: Number.NaN, height: 10 })).toEqual(cursor);
    expect(calculateDroppedImagePosition(cursor, 0, 1, { width: 10 } as { width: number; height: number })).toEqual(cursor);
    expect(calculateDroppedImagePosition(null, 0, 1)).toEqual({ x: 0, y: 0 });
    expect(calculateDroppedImagePosition(cursor, Number.NaN, Number.NaN)).toEqual(cursor);
    expect(calculateDroppedImagePosition({ x: Number.NaN, y: Number.POSITIVE_INFINITY }, 0, 1)).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("cascades 2 and 5 images by 24px without stacking them on one point", () => {
    expect(BOARD_DND_STAGGER_PX).toBe(24);
    expect(calculateDroppedImagePosition(cursor, 0, 2, box)).toEqual({ x: 160, y: 80 });
    expect(calculateDroppedImagePosition(cursor, 1, 2, box)).toEqual({ x: 184, y: 104 });
    expect(calculateDroppedImagePosition(cursor, 4, 5, box)).toEqual({ x: 160 + 96, y: 80 + 96 });
    expect(calculateDroppedImagePosition(cursor, -3, 5)).toEqual(cursor);

    const row = [0, 1, 2, 3, 4].map((index) => calculateDroppedImagePosition(cursor, index, 5));
    expect(row).toEqual([
      { x: 200, y: 100 },
      { x: 224, y: 124 },
      { x: 248, y: 148 },
      { x: 272, y: 172 },
      { x: 296, y: 196 },
    ]);
    expect(new Set(row.map((point) => `${point.x},${point.y}`)).size).toBe(5);
  });
});

describe("calculateStaggeredOffsets", () => {
  it("builds a deterministic cascade and ignores invalid counts", () => {
    expect(calculateStaggeredOffsets({ x: 10, y: 20 }, 3)).toEqual([
      { x: 10, y: 20 },
      { x: 34, y: 44 },
      { x: 58, y: 68 },
    ]);
    expect(calculateStaggeredOffsets({ x: 10, y: 20 }, 2, 10)).toEqual([
      { x: 10, y: 20 },
      { x: 20, y: 30 },
    ]);
    expect(calculateStaggeredOffsets({ x: 1, y: 1 }, 0)).toEqual([]);
    expect(calculateStaggeredOffsets({ x: 1, y: 1 }, -4)).toEqual([]);
    expect(calculateStaggeredOffsets({ x: 1, y: 1 }, Number.NaN)).toEqual([]);
    expect(calculateStaggeredOffsets(undefined, 1, Number.NaN)).toEqual([{ x: 0, y: 0 }]);
    expect(calculateStaggeredOffsets({ x: 5, y: 6 }, 1.9)).toEqual([{ x: 5, y: 6 }]);
  });
});

describe("extractImageFromClipboard", () => {
  it("returns an image file and ignores text, html, and empty clipboards", () => {
    const png = imageFile("image/png", "clip.png");
    const withImage = {
      clipboardData: transfer({
        items: [
          { kind: "string", type: "text/plain" },
          { kind: "string", type: "text/html" },
          fileItem(png),
        ],
      }),
    } as unknown as ClipboardEvent;
    expect(extractImageFromClipboard(withImage)).toBe(png);

    const textOnly = {
      clipboardData: transfer({
        items: [
          { kind: "string", type: "text/plain" },
          { kind: "string", type: "text/html" },
        ],
        files: [imageFile("text/plain", "note.txt")],
      }),
    } as unknown as ClipboardEvent;
    expect(extractImageFromClipboard(textOnly)).toBeNull();

    expect(extractImageFromClipboard({ clipboardData: null } as unknown as ClipboardEvent)).toBeNull();
    expect(extractImageFromClipboard(null)).toBeNull();
    expect(extractImageFromClipboard(undefined)).toBeNull();
    expect(
      extractImageFromClipboard({
        get clipboardData() {
          throw new Error("blocked");
        },
      } as unknown as ClipboardEvent),
    ).toBeNull();
  });

  it("returns the first accepted image when several are pasted", () => {
    const first = imageFile("image/jpeg", "first.jpg");
    const second = imageFile("image/gif", "second.gif");
    const event = {
      clipboardData: transfer({ files: [first, second] }),
    } as unknown as ClipboardEvent;
    expect(extractImageFromClipboard(event)).toBe(first);
  });
});

describe("decidePasteAction", () => {
  const imageFiles = [imageFile("image/png", "clip.png")];

  it.each([
    {
      name: "image files win over a non-empty internal shape clipboard",
      imageFiles,
      internalClipboardCount: 2,
      targetEditable: false,
      expected: "images" as const,
    },
    {
      name: "image files paste when the internal clipboard is empty",
      imageFiles,
      internalClipboardCount: 0,
      targetEditable: false,
      expected: "images" as const,
    },
    {
      name: "internal shape paste still runs when the clipboard has no image file",
      imageFiles: [],
      internalClipboardCount: 1,
      targetEditable: false,
      expected: "internal" as const,
    },
    {
      name: "an empty clipboard does nothing",
      imageFiles: [],
      internalClipboardCount: 0,
      targetEditable: false,
      expected: "ignore" as const,
    },
    {
      name: "an input, textarea, or contenteditable target is ignored even with images and shapes",
      imageFiles,
      internalClipboardCount: 4,
      targetEditable: true,
      expected: "ignore" as const,
    },
    {
      name: "an editable target keeps internal shape paste from running",
      imageFiles: [],
      internalClipboardCount: 2,
      targetEditable: true,
      expected: "ignore" as const,
    },
    {
      name: "a later internal copy wins over a stale image left on the OS clipboard",
      imageFiles,
      internalClipboardCount: 2,
      targetEditable: false,
      hasInternalMarker: true,
      expected: "internal" as const,
    },
    {
      name: "image files paste when nothing was copied inside the board",
      imageFiles,
      internalClipboardCount: 0,
      targetEditable: false,
      hasInternalMarker: false,
      expected: "images" as const,
    },
    {
      name: "the shape marker alone pastes the internal clipboard",
      imageFiles: [],
      internalClipboardCount: 3,
      targetEditable: false,
      hasInternalMarker: true,
      expected: "internal" as const,
    },
    {
      name: "internal shapes paste when the OS clipboard is empty",
      imageFiles: [],
      internalClipboardCount: 1,
      targetEditable: false,
      hasInternalMarker: false,
      expected: "internal" as const,
    },
    {
      name: "an editable target ignores the shape marker so the board does not insert it",
      imageFiles,
      internalClipboardCount: 2,
      targetEditable: true,
      hasInternalMarker: true,
      expected: "ignore" as const,
    },
  ])("$name", ({ imageFiles: files, internalClipboardCount, targetEditable, hasInternalMarker, expected }) => {
    expect(
      decidePasteAction({
        imageFiles: files,
        internalClipboardCount,
        targetEditable,
        hasInternalMarker,
      }),
    ).toBe(expected);
  });

  it("does not insert the shape marker into a text box", async () => {
    const marker = issueBoardShapeMarker();
    expect(marker.startsWith("project100-board-shapes:")).toBe(true);
    expect(issueBoardShapeMarker()).not.toBe(marker);
    expect(clipboardDataHasBoardShapeMarker({ getData: () => marker } as unknown as DataTransfer)).toBe(true);
    expect(clipboardDataHasBoardShapeMarker({ getData: () => "hello" } as unknown as DataTransfer)).toBe(false);

    const action = decidePasteAction({
      imageFiles: [],
      internalClipboardCount: 1,
      targetEditable: true,
      hasInternalMarker: clipboardDataHasBoardShapeMarker({ getData: () => marker } as unknown as DataTransfer),
    });
    expect(action).toBe("ignore");

    const written: string[] = [];
    await applyPasteDecision(action, {
      notebookId: "nb-1",
      files: [],
      pageIndex: 0,
      sizeRejected: false,
      pasteClipboard: () => written.push("shapes"),
      handleImageFile: async () => {
        written.push("image");
      },
      notify: (message) => written.push(message),
    });
    expect(written).toEqual([]);
    expect(written.join("\n")).not.toContain("project100-board-shapes:");
  });
});

const pageCanvas = {
  pageIndex: 1,
  left: 100,
  top: 40,
  right: 894,
  bottom: 1163,
};

describe("decideImageDrop", () => {
  it("ignores a drop that misses every canvas", async () => {
    const jpeg = imageFile("image/jpeg", "photo.jpg", 10 * MB);
    const calls: string[] = [];
    const hints: string[] = [];
    const decision = decideImageDrop({
      notebookId: "nb-1",
      clientX: 10,
      clientY: 10,
      zoom: 2,
      canvases: [pageCanvas],
      files: [jpeg],
      sizeRejections: 0,
    });

    expect(decision).toEqual({ type: "ignore" });
    await applyImageDropDecision(
      decision,
      async (file) => {
        calls.push(file.name);
      },
      (message) => hints.push(message),
    );
    expect(calls).toEqual([]);
    expect(hints).toEqual([]);
  });

  it("shows the notebook-not-ready hint and does not call handleImageFile", async () => {
    const jpeg = imageFile("image/jpeg", "photo.jpg");
    const calls: string[] = [];
    const hints: string[] = [];
    const decision = decideImageDrop({
      notebookId: null,
      clientX: 140,
      clientY: 80,
      zoom: 1,
      canvases: [pageCanvas],
      files: [jpeg],
      sizeRejections: 0,
    });

    expect(decision).toEqual({ type: "hint", message: NOTEBOOK_NOT_READY_HINT });
    expect(NOTEBOOK_NOT_READY_HINT).toBe("המחברת עדיין לא מוכנה. נסו שוב בעוד רגע.");
    await applyImageDropDecision(
      decision,
      async (file) => {
        calls.push(file.name);
      },
      (message) => hints.push(message),
    );
    expect(calls).toEqual([]);
    expect(hints).toEqual(["המחברת עדיין לא מוכנה. נסו שוב בעוד רגע."]);
  });

  it("calls handleImageFile twice from the drop point and one failure does not block the other", async () => {
    const first = imageFile("image/png", "a.png");
    const second = imageFile("image/jpeg", "b.jpg", 10 * MB);
    const calls: { name: string; x: number; y: number; pageIndex: number }[] = [];
    const decision = decideImageDrop({
      notebookId: "nb-1",
      clientX: 300,
      clientY: 140,
      zoom: 2,
      canvases: [pageCanvas],
      files: [first, second],
      sizeRejections: 1,
    });

    expect(decision.type).toBe("place");
    if (decision.type !== "place") return;
    expect(decision.pageIndex).toBe(1);
    expect(decision.origin).toEqual({ x: 100, y: 50 });
    expect(decision.hint).toBe(IMAGE_STILL_TOO_LARGE_HINT);

    await applyImageDropDecision(
      decision,
      async (file, placement) => {
        calls.push({ name: file.name, x: placement.point.x, y: placement.point.y, pageIndex: placement.pageIndex });
        if (file.name === "a.png") throw new Error("upload failed");
      },
      () => {},
    );

    expect(calls).toEqual([
      { name: "a.png", x: 100, y: 50, pageIndex: 1 },
      { name: "b.jpg", x: 124, y: 74, pageIndex: 1 },
    ]);
  });
});

describe("applyPasteDecision", () => {
  it("pastes images at the visible page and leaves internal paste on pasteClipboard", async () => {
    const png = imageFile("image/png", "clip.png");
    const placed: { name: string; pageIndex: number; staggerIndex: number }[] = [];
    let internalPastes = 0;
    const hints: string[] = [];

    await applyPasteDecision("images", {
      notebookId: "nb-1",
      files: [png],
      pageIndex: 2,
      sizeRejected: false,
      pasteClipboard: () => {
        internalPastes += 1;
      },
      handleImageFile: async (file, placement) => {
        placed.push({ name: file.name, pageIndex: placement.pageIndex, staggerIndex: placement.staggerIndex });
      },
      notify: (message) => hints.push(message),
    });
    expect(placed).toEqual([{ name: "clip.png", pageIndex: 2, staggerIndex: 0 }]);
    expect(internalPastes).toBe(0);

    await applyPasteDecision("internal", {
      notebookId: null,
      files: [],
      pageIndex: 0,
      sizeRejected: false,
      pasteClipboard: () => {
        internalPastes += 1;
      },
      handleImageFile: async () => {
        throw new Error("image paste should not run");
      },
      notify: (message) => hints.push(message),
    });
    expect(internalPastes).toBe(1);
    expect(hints).toEqual([]);

    await applyPasteDecision("images", {
      notebookId: "",
      files: [png],
      pageIndex: 0,
      sizeRejected: false,
      pasteClipboard: () => {
        internalPastes += 1;
      },
      handleImageFile: async () => {
        throw new Error("missing notebook should not upload");
      },
      notify: (message) => hints.push(message),
    });
    expect(hints).toEqual([NOTEBOOK_NOT_READY_HINT]);
    expect(internalPastes).toBe(1);
  });
});

describe("mostVisiblePageIndex", () => {
  it("picks the page that occupies the most of the viewport", () => {
    expect(
      mostVisiblePageIndex(
        { left: 0, top: 0, right: 400, bottom: 400 },
        [
          { pageIndex: 0, left: 0, top: 0, right: 100, bottom: 100 },
          { pageIndex: 1, left: 0, top: 50, right: 300, bottom: 350 },
        ],
      ),
    ).toBe(1);
    expect(mostVisiblePageIndex({ left: 0, top: 0, right: 10, bottom: 10 }, [pageCanvas])).toBeNull();
  });
});

describe("dataTransferHasFiles", () => {
  it("recognizes a file drag without reading the file list", () => {
    expect(dataTransferHasFiles(null)).toBe(false);
    expect(dataTransferHasFiles(undefined)).toBe(false);
    expect(dataTransferHasFiles(transfer({ types: ["text/plain"] }))).toBe(false);
    expect(dataTransferHasFiles(transfer({ types: ["Files"] }))).toBe(true);
    expect(dataTransferHasFiles(transfer({ types: ["application/x-moz-file"] }))).toBe(true);
    expect(dataTransferHasFiles(transfer({ throwTypes: true }))).toBe(false);
    expect(dataTransferHasFiles(transfer({}))).toBe(false);
    expect(dataTransferHasFiles({ types: {} } as unknown as DataTransfer)).toBe(false);
  });
});
