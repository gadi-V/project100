# Board image drag-and-drop / paste — Phase 1 audit

Branch: `feat/board-image-dnd`. Phase 1 adds pure helpers and this audit only. `components/ClassroomWhiteboard.tsx` is **not** modified yet. The integration patch below is the review plan for the next pass.

This whiteboard is a custom A4 canvas (`794×1123`, stacked pages). It does not use Excalidraw. Copy/paste of shapes is an in-memory `DrawEl[]` on `clipboardRef`, not Excalidraw JSON. Text editing is a `<textarea>` overlay, not a contenteditable surface and not an Excalidraw text editor.

Out of scope, and not touched: Prisma, `app/api/*`, Supabase, and the sync wire format (`toSyncEl`, `imageAddEvent`, `PROTO_V`).

## 1. Image ingestion — `handleImageFile`

The file picker is single-file. There is no drag/drop and no clipboard-image path today.

| Step | Where | What it does |
| --- | --- | --- |
| Picker | `components/ClassroomWhiteboard.tsx` 5516–5526 | Hidden `<input type="file" accept="image/*">`. `onChange` reads `files[0]` only, calls `handleImageFile`, then clears `e.target.value`. No `multiple`. |
| Open picker | 4718–4727 `handleToolClick` | Tool `"image"` does not change the active tool. If `notebookId` is missing it sets the hint and returns. Otherwise `fileInputRef.current?.click()`. |
| Button | 4771–4804 | The image control is one button in the tool row (`TOOL_META.image` is `{ icon: "🖼", label: "תמונה" }` at 2420). It is **not** disabled. The prompt's "~5087" is the lasso "send backward" item, not this button. |
| Prepare | 3717–3737 `handleImageFile` | `async (file: File): Promise<void>`. Calls `prepareBoardImageFile`. |
| Upload | 3650–3676 `uploadBoardFile` | `async (file: File): Promise<string \| null>`. `POST /api/upload` with `file` + `notebookId`. Returns `data.id`. |
| Place | 3678–3715 `insertImageElement` | `async (imageId: string): Promise<boolean>`. Centers the image on the **active page**. |

`handleImageFile` (3717–3737):

1. `prepareBoardImageFile(file)` from `lib/whiteboard/prepare-board-image.ts`.
2. `"error" in result` → hint `התמונה עדיין גדולה מדי אחרי הכיווץ. נסו קובץ קטן יותר.` and return.
3. Thrown prepare error → `לא הצלחנו להעלות את התמונה. נסו שוב.` and return.
4. `uploadBoardFile(prepared)`. A null id stops the pipeline (the upload helper already showed a hint).
5. `insertImageElement(imageId)`.

Prepare rules (`lib/whiteboard/prepare-board-image.ts`):

- `BOARD_UPLOAD_MAX_BYTES` = 4MB (line 1). `BOARD_DOWNSCALE_OVER_BYTES` = 1.5MB. `BOARD_IMAGE_MAX_SIDE` = 2000.
- GIF is always passthrough (`imagePreparePlan`, 32–36), even above 1.5MB.
- JPEG, PNG, and WebP **over** 1.5MB are redrawn to a longest side of 2000 and encoded as WebP 0.82, or JPEG 0.82 if WebP encoding fails (46–66).
- If the encoded blob is still over 4MB, the result is `{ error: "still-too-large" }`.
- The picker does **not** pre-filter MIME. `accept="image/*"` is wider than the four types the new helper allows. Leave the picker on that path so today's upload behavior stays put.

Upload (`uploadBoardFile`, 3650–3676):

- No `notebookId` → `המחברת עדיין לא מוכנה. נסו שוב בעוד רגע.` and `null`.
- `FormData` fields: `file`, `notebookId`. `fetch("/api/upload", { method: "POST", body: formData })`.
- Non-OK response, missing `id`, or thrown network error → `לא הצלחנו להעלות את התמונה. נסו שוב.` and `null`.

Placement when the image comes from the picker (`insertImageElement`, 3678–3715). The cursor is not involved.

```ts
const maxH = PAGE_H - 40; // 1123 - 40
const sc = Math.min(IMAGE_MAX_WIDTH / img.naturalWidth, maxH / img.naturalHeight, 1);
const w = Math.max(1, Math.floor(img.naturalWidth * sc));
const h = Math.max(1, Math.floor(img.naturalHeight * sc));
// x: Math.max(20, (PAGE_W - w) / 2)   PAGE_W = 794, IMAGE_MAX_WIDTH = 400
// y: Math.max(20, (PAGE_H - h) / 2)
```

`pageIndex` is `activePageIndex` (state, 2472), which pointer-down sets to the canvas index (3057). The shell is loaded through `loadBoardImage` before the element is committed. Load failure → `לא הצלחנו להציג את התמונה. נסו שוב.`

Hints render in the bottom pill (5434–5440) and clear after 4500ms (2634–2638). That pill is the toast. There is no `react-hot-toast` call on this path.

## 2. Coordinate systems and pages

Constants (37–39, 50, 54): `PAGE_W = 794`, `PAGE_H = 1123`, `PAGE_GAP = 32`, `IMAGE_MAX_WIDTH = 400`, `PASTE_OFFSET = 24`.

Zoom is React state (2451), mirrored to `zoomRef` (2537–2538). The wheel listener on `scrollRef` (2662–2673) adjusts zoom by ±0.03 while Ctrl/Cmd is held, clamped to `[0.25, 3]`. The page stack is CSS-scaled (4903–4913):

```tsx
transformOrigin: "top center",
transform: `scale(${zoom})`,
```

There is no pan state. Scrolling is native overflow on `scrollRef` (4897–4901, `overflow-auto`, `touchAction: "pan-x pan-y"`).

`ptFrom` (2675–2681) is the only client→page conversion, and the same formula is inlined for double-click (3960–3964) and text-width drag (5345–5348):

```ts
const r = e.currentTarget.getBoundingClientRect();
return {
  x: (e.clientX - r.left) / zoomRef.current,
  y: (e.clientY - r.top) / zoomRef.current,
};
```

`getBoundingClientRect()` is already in viewport pixels, so it includes scroll and the CSS scale. Dividing by `zoomRef` maps those pixels back into the page's 794×1123 space. Do **not** also add `scrollLeft` / `scrollTop`. Doing both would shift the drop.

Pages are separate canvases, not one tall bitmap. `pages.map` (4915–4946) gives each page a `canvas` with `onPointerDown={(e) => onDown(e, idx)}`. `onDown` (3052–3058) calls `setActivePageIndex(pageIndex)` and `ptFrom`. `canvasMap` (2478) stores `page.id → HTMLCanvasElement`.

A drop on the desk (`DESK_BG` on `scrollRef`), in the 32px `PAGE_GAP`, or on the "עמוד N" label (5418–5423, `pointer-events-none`) is **not** on a canvas. Nothing is inserted today, because nothing listens for drop. The patch should keep that: if the cursor is outside every canvas rect, prevent navigation and show a hint, and do not guess `activePageIndex`.

## 3. Permission gate (match the image button exactly)

`ClassroomWhiteboardProps.role` is `"STUDENT" | "TEACHER" | "ADMIN" | "MANAGER"` (381–389). The component binds it as `role: _role` (2434) and never reads it.

There is no `readOnly`, `canEdit`, presenter lock, or spectator flag.

The image button's real gate is `notebookId` (4718–4724 and again inside `uploadBoardFile` at 3651–3654):

- Missing `notebookId`: hint `המחברת עדיין לא מוכנה. נסו שוב בעוד רגע.` The picker does not open.
- Present: the picker opens. Upload sends that id.

Drop and paste must use that same check and the same string. Do not add a role check the button does not have.

## 4. Clipboard and hotkeys

Shortcut parsing is `readWhiteboardShortcut` (154–172). Cmd/Ctrl+V returns `"paste"`. Shift-Z is redo. The key compare is case-sensitive for `v` (`key === "v"`), so that part is not the text-editing bug below.

The only keyboard listener is `window` `keydown` / `keyup` / `blur` (4205–4270). Cleanup removes all three. There is **no** `paste` listener and **no** `dragover` / `drop` listener anywhere in this component.

Paste of board elements (4000–4021):

- `copySelection` copies selected `DrawEl`s into `clipboardRef` (2492). It does not write `navigator.clipboard`.
- `pasteClipboard` clones each element with `cloneEl(el, activePageIndex, PASTE_OFFSET)` (1036–1051). Strokes, shapes, text, and images all move +24px and land on `activePageIndex`. New ids come from `nanoid()`.
- One history op: `pushHistory({ id, removed: [], added: pasted, updated: [] })` (sync defaults to false).
- Then each element is broadcast with `{ add: sync }`. Images call `ensureImageInCache`.

`keydown` for `"paste"` (4222–4224) always `preventDefault()` and calls `pasteClipboard()`. It does **not** look at the event target. `"delete"` is the exception: if `editText` is set it returns and lets the key through (4235–4238). `"cut"` and `"duplicate"` branch on `editText` but still `preventDefault()`.

Consequence: Cmd/Ctrl+V while the text `<textarea>` is focused (5378–5413) never reaches the textarea. The window listener cancels the key, so the browser does not fire a `paste` event, and `pasteClipboard()` runs instead. The textarea's own `onKeyDown` (5385–5387) only handles Escape.

Text commit is separate from paste. `commitText` (3576–3630) writes the textarea value into a `TextEl` and pushes one history op. A document `pointerdown` listener (3636–3648) commits when the click is outside the textarea, `.text-format-bar`, `.board-toolbar-root`, and `.lasso-action-bar`.

Clipboard precedence for the patch:

| Clipboard contents | Not editable | Editable target |
| --- | --- | --- |
| Image file (`image/jpeg`, `png`, `webp`, `gif`) plus optional `text/html` | Place the image. Do not also run `pasteClipboard`. | Do nothing. Native paste wins. |
| `text/plain` / `text/html` / non-image file, internal `clipboardRef` has elements | `pasteClipboard()` (shapes, strokes, text, existing image elements). | Do nothing. |
| Empty OS clipboard, internal `clipboardRef` has elements | `pasteClipboard()`. | Do nothing. |
| Both an image file and a non-empty `clipboardRef` | Image file wins. | Do nothing. |

`extractImageFromClipboard` implements the image-vs-text split. HTML `<img>` markup without a file item stays on the element-paste path, because `kind: "string"` items are ignored.

The new `paste` listener will not run if `keydown` still calls `preventDefault()` on Cmd/Ctrl+V. The patch has to stop doing that. See §7.

`isTargetEditable` has to treat the board textarea as editable (`tagName === "TEXTAREA"`). It also treats `<input>` (the recolor `<input type="color">` at 5057–5061), `contenteditable="true"`, and an Excalidraw text-editor class if one is ever focused. This codebase has none of those Excalidraw nodes. `contenteditable="false"` stops the ancestor walk so a locked node inside an editable parent is not treated as editable.

## 5. Drag lifecycle (nothing is attached today)

Listeners that already mount and clean up, and the pattern the new ones should follow:

| Effect | Lines | Attaches | Cleanup |
| --- | --- | --- | --- |
| Context menu | 2626–2632 | `containerRef` `"contextmenu"` | `removeEventListener` |
| Wheel zoom | 2662–2673 | `scrollRef` `"wheel"` `{ passive: false }` | `removeEventListener` |
| Outside menus | 2640–2660 | `document` `"pointerdown"` | `removeEventListener` |
| Text commit | 3636–3648 | `document` `"pointerdown"` while `editText` is set | `removeEventListener` |
| Shortcuts | 4205–4270 | `window` `keydown`, `keyup`, `blur` | all three removed |
| Pointer release | 3036–3050 | `window` `pointerup` / `pointercancel` | `releaseCleanupRef` |

`repaintBoardRef` is cleared on unmount at 2604–2611. There is no file-drag guard, so a drop that misses the page can navigate the browser away from the lesson.

Anti-flicker for the hover highlight: keep a `dragDepthRef`. `dragenter` increments, `dragleave` decrements, and `isDraggingOver` is true only while the depth is positive. Reset the depth to 0 on drop and on drag end. The highlight overlay uses `pointer-events: none` so it is not an extra enter/leave target and does not block canvas pointer tracking. During `dragover`, browsers expose `types` and hide `files`. Use `dataTransferHasFiles` (the `"Files"` or Firefox `"application/x-moz-file"` type) for the highlight. Run `imageFilesFromDataTransfer` only on `drop` and `paste`, when the file list is populated.

## 6. History

`HistoryOp` (252–257) is `{ id, removed, added, updated }`. `pushHistory` (2706–2713) appends one op and clears the redo stack. The second argument `sync` defaults to false. When it is true, `broadcastHistory` sends `buildHistorySyncEvents` (1456–1495), which already splits an op that would exceed `STREAM_SAFE_LIMIT` (1400).

`insertImageElement` records **one image per op** (3708) and then broadcasts `{ add }` itself. It does not pass `sync: true`. Undo later sends the history op. `applyHistoryForward` / `applyHistoryBackward` (`lib/whiteboard/display-list.ts` 14–40) already apply every element in `op.added` as one step.

`pasteClipboard` is the batch template: one `pushHistory` whose `added` array holds every clone, then one `{ add }` broadcast per element (4006–4020). A multi-image drop should follow that, not a loop of `handleImageFile`. Looping `handleImageFile` would push N undo steps and N "still too large" hints that overwrite each other.

Image elements in a history op are small (ids, box, crop). Bitmaps stay in `imgCache` and on `/api/board-images/{id}`. Grouping five images into one op does not change the add-event shape.

`handleImageFile` cannot grow an optional placement argument and still push its own history if the batch path also pushes. Split "prepare + upload + build element" from "push history", and let the file picker keep a one-element op so its undo behavior stays the same.

## 7. Integration patch (not applied)

Touch only `components/ClassroomWhiteboard.tsx` when this is implemented. Import from `lib/whiteboard/board-dnd.ts`:

- `imageFilesFromDataTransfer` / `inspectImageDataTransfer`
- `isTargetEditable`
- `calculateDroppedImagePosition`
- `dataTransferHasFiles`

Do not change `readWhiteboardShortcut`, `cloneEl`, `pasteClipboard`'s clone math, the file input, or `prepareBoardImageFile`.

### 7.1 Window guard

New effect next to the shortcut effect (after 4270). Empty deps. Cleanup removes both listeners.

```ts
useEffect(() => {
  const blockFileNavigation = (event: DragEvent): void => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
  };
  window.addEventListener("dragover", blockFileNavigation);
  window.addEventListener("drop", blockFileNavigation);
  return () => {
    window.removeEventListener("dragover", blockFileNavigation);
    window.removeEventListener("drop", blockFileNavigation);
  };
}, []);
```

This listener only calls `preventDefault`. The scroll surface performs the insert. Internal toolbar drags (`react-draggable`) do not carry `"Files"`, so they are ignored.

### 7.2 Scroll-surface drop zone

State: `const [isDraggingOver, setIsDraggingOver] = useState(false)` and `const dragDepthRef = useRef(0)`.

Handlers on the `scrollRef` div (4897):

- `onDragEnter`: if `dataTransferHasFiles`, `preventDefault`, increment depth, `setIsDraggingOver(true)`.
- `onDragOver`: if files, `preventDefault`, set `dropEffect = "copy"`.
- `onDragLeave`: if files, decrement depth, clear the flag at 0.
- `onDrop`: `preventDefault`, depth = 0, clear the flag, then the pipeline below.

Highlight, as a sibling inside `containerRef`, not inside the scaled page stack:

```tsx
{isDraggingOver && (
  <div
    className="pointer-events-none absolute inset-0 z-[45] rounded-lg border-2 border-emerald-600/70 bg-emerald-500/10"
    aria-hidden
  />
)}
```

`pointer-events-none` keeps the overlay out of hit testing.

Page under the cursor, using `canvasMap` and the same math as `ptFrom`:

```ts
function pagePointFromClient(clientX: number, clientY: number, canvas: HTMLCanvasElement): Point {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) / zoomRef.current,
    y: (clientY - rect.top) / zoomRef.current,
  };
}
```

Walk `canvasMap`. The canvas whose rect contains `(clientX, clientY)` is the page. Map `page.id` back to the index in `pages`. If none match (margin, gap, page label), set hint `שחררו את התמונה על העמוד.` and return. Do not fall back to `activePageIndex`.

### 7.3 Ingest without doubling history

Add a local helper that returns the element and does not call `pushHistory`. `handleImageFile` and the file input keep calling the current one-image history path.

```ts
async function buildImageElement(
  file: File,
  placement: { pageIndex: number; x: number; y: number },
): Promise<ImageEl | null>
```

Inside it, reuse `prepareBoardImageFile`, `uploadBoardFile`, and `loadBoardImage`. Fit `w`/`h` with the same `IMAGE_MAX_WIDTH` / `PAGE_H - 40` math as 3697–3700. Then:

```ts
const pos = calculateDroppedImagePosition(
  placement,
  index,
  total,
  { width: w, height: h },
);
const x = clamp(pos.x, 20, PAGE_W - w - 20);
const y = clamp(pos.y, 20, PAGE_H - h - 20);
```

`clamp` is `Math.min(Math.max(value, min), Math.max(min, max))` so a huge image still stays on the page. The picker path does not call this; it keeps `(PAGE_W - w) / 2`.

For a batch, after every file has been built:

```ts
pushHistory({ id: nanoid(), removed: [], added: placed, updated: [] });
setElements((prev) => [...prev, ...placed]);
setSelectedIds(new Set(placed.map((el) => el.id)));
for (const el of placed) {
  const sync = toSyncEl(el);
  if (sync) broadcastElement({ add: sync });
}
```

That is one undo step, same shape as `pasteClipboard`. Sync add events stay one element each. Do not pass `sync: true` to `pushHistory`.

### 7.4 Paste listener, without breaking element paste

Replace the `"paste"` branch at 4222–4224. Do not `preventDefault` there.

```ts
} else if (action === "paste") {
  if (isTargetEditable(e.target) || editText) return;
  pasteSeenRef.current = false;
  window.setTimeout(() => {
    if (!pasteSeenRef.current) pasteClipboard();
  }, 0);
}
```

New `window` `"paste"` listener in the same effect (include it in the cleanup):

```ts
const onPaste = (event: ClipboardEvent): void => {
  pasteSeenRef.current = true;
  if (isTargetEditable(event.target) || editText) return;
  if (!notebookId) {
    setAiHint("המחברת עדיין לא מוכנה. נסו שוב בעוד רגע.");
    return;
  }
  const report = inspectImageDataTransfer(event.clipboardData);
  if (report.accepted.length === 0) {
    pasteClipboard();
    return;
  }
  event.preventDefault();
  showDropRejections(report);
  void placeImageBatch(report.accepted, /* page under caret, or active page if the caret is on a canvas */);
};
```

`setTimeout(0)` runs after the paste event, which is dispatched as the default action of the key. If the paste event never arrives, element paste still runs. If it arrives with an image, `pasteSeenRef` is already true, so the timeout does not also paste shapes.

`editText` in that effect is already a dependency (4267). The textarea is also covered by `isTargetEditable`.

Do not read `navigator.clipboard`. File bytes are on `clipboardData` only.

### 7.5 Rejection hints

`aiHint` holds one string. Prefer the first match:

| Report | Hint |
| --- | --- |
| `truncated.length > 0` and any `reason: "size"` | `אפשר להוסיף עד 5 תמונות בבת אחת, וכל תמונה עד 4MB.` |
| `truncated.length > 0` | `אפשר להוסיף עד 5 תמונות בבת אחת.` |
| any `reason: "size"` | `התמונה גדולה מדי. בחרו קובץ עד 4MB.` |
| accepted empty, and every rejection is `mime` or `directory` | `אפשר להוסיף רק תמונות JPEG, PNG, WEBP או GIF.` |
| no `notebookId` | `המחברת עדיין לא מוכנה. נסו שוב בעוד רגע.` |

Accepted files still upload when siblings were rejected. Prepare/upload failures keep the existing hints inside `handleImageFile` / `uploadBoardFile`.

### 7.6 What must stay unchanged

- File input: single file, `accept="image/*"`, centered on `activePageIndex`, one history op.
- `pasteClipboard` / `cloneEl` / `PASTE_OFFSET` for shapes, strokes, text, and image elements already on the board.
- Textarea typing, Escape-to-close, and native paste into that textarea and into `<input>`.
- Sync event shape for `{ add }`. No new fields on `BoardImageEl`.

## 8. Phase 1 module

`lib/whiteboard/board-dnd.ts` (pure, no React, no fetch):

| Export | Contract |
| --- | --- |
| `imageFilesFromDataTransfer` | Accepted files only. |
| `inspectImageDataTransfer` | `accepted`, `rejected` (`mime` / `size` / `directory` / `empty`), `truncated`. |
| `isTargetEditable` | Input, textarea, `contenteditable="true"`, Excalidraw text-editor class. `contenteditable="false"` stops the walk. |
| `calculateDroppedImagePosition` | One image: center on the cursor when width and height are positive. Several: that origin plus `index * 24` on x and y. |
| `calculateStaggeredOffsets` | `[base, base+step, …]` for a count. Default step 24. |
| `extractImageFromClipboard` | First accepted image, else null. Text and HTML do not count. |
| `dataTransferHasFiles` | `"Files"` or `"application/x-moz-file"`. |
| `BOARD_DND_MAX_FILES` | 5. |
| `BOARD_DND_MAX_BYTES` | `BOARD_UPLOAD_MAX_BYTES` (4MB). A file of exactly 4MB is accepted. |
| `BOARD_DND_STAGGER_PX` | 24. |
| `ACCEPTED_IMAGE_MIME_TYPES` | `image/jpeg`, `image/png`, `image/webp`, `image/gif`. |

MIME is trimmed and lowercased. `image/svg+xml`, PDF, zip, scripts, and empty blobs are rejected. Directories are detected with synchronous `webkitGetAsEntry().isDirectory` when that function exists. Items and `files` are both scanned; the same name+size+type+lastModified is kept once. Oversized files do not consume one of the five slots. A throwing `DataTransfer` accessor returns an empty report instead of throwing.

`calculateDroppedImagePosition` does not know `PAGE_W` / `PAGE_H`. The component clamps after fit, as in §7.3.

## 9. Verification

Helpers and tests are pure. No component mount, no network, no storage, no sync. `DataTransfer`, `ClipboardEvent`, and DOM nodes are plain objects cast at the test boundary, because Vitest runs in Node (`vitest.config.ts` `environment: "node"`).

`npx tsc --noEmit` — exit 0.

`npm test tests/whiteboard/board-dnd.test.ts` — Vitest 5.0.1, 1 file, 18 tests, all passed.

`@vitest/coverage-v8` is not installed, so a coverage percentage was not collected. The suite drives every public function with plain objects: null and throwing `DataTransfer` accessors, MIME and size limits, the 5-file cap, directory entries, editable targets, and the stagger math. No `ClassroomWhiteboard` mount, no `fetch`, and no sync payload is involved.

`components/ClassroomWhiteboard.tsx` was not edited. The patch in §7 is the review plan.
