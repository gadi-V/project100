/** One undo/redo step on the whiteboard display list. */
export interface HistoryUpdate<T> {
  id: string;
  before: T;
  after: T;
}

export interface HistoryChange<T> {
  removed: T[];
  added: T[];
  updated: HistoryUpdate<T>[];
}

export function applyHistoryForward<T extends { id: string }>(
  els: readonly T[],
  op: HistoryChange<T>,
): T[] {
  const removedIds = new Set(op.removed.map((el) => el.id));
  const addedIds = new Set(op.added.map((el) => el.id));
  let next = els.filter((el) => !removedIds.has(el.id) && !addedIds.has(el.id));
  for (const update of op.updated) {
    const idx = next.findIndex((el) => el.id === update.id);
    if (idx >= 0) next = [...next.slice(0, idx), update.after, ...next.slice(idx + 1)];
    else next = [...next, update.after];
  }
  return [...next, ...op.added];
}

export function applyHistoryBackward<T extends { id: string }>(
  els: readonly T[],
  op: HistoryChange<T>,
): T[] {
  const addedIds = new Set(op.added.map((el) => el.id));
  const removedIds = new Set(op.removed.map((el) => el.id));
  let next = els.filter((el) => !addedIds.has(el.id) && !removedIds.has(el.id));
  for (const update of op.updated) {
    const idx = next.findIndex((el) => el.id === update.id);
    if (idx >= 0) next = [...next.slice(0, idx), update.before, ...next.slice(idx + 1)];
    else next = [...next, update.before];
  }
  return [...next, ...op.removed];
}
