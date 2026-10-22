/**
 * Multi-part strokes are stored by (strokeId, partIndex).
 * A retry or duplicate delivery replaces that part instead of appending it.
 */

export type StrokePart = {
  id: string;
  pts: number[];
};

export type StrokePartStore = Map<string, Map<number, StrokePart>>;

export function createStrokePartStore(): StrokePartStore {
  return new Map();
}

export function clearStrokeParts(store: StrokePartStore, strokeId: string): void {
  store.delete(strokeId);
}

/** Replace one part and return every stored part for that stroke, in index order. */
export function replaceStrokePart<T extends StrokePart>(
  store: StrokePartStore,
  partIndex: number,
  part: T,
): T[] {
  const copy = { ...part, pts: [...part.pts] } as T;
  let bucket = store.get(part.id) as Map<number, T> | undefined;
  if (!bucket) {
    bucket = new Map();
    store.set(part.id, bucket);
  }
  bucket.set(partIndex, copy);
  return [...bucket.entries()].sort((a, b) => a[0] - b[0]).map(([, piece]) => piece);
}
