/**
 * Backing-store size for a CSS-pixel canvas.
 * `scale` is the integer device pixel ratio the 2D context must be scaled by
 * so a 1px stroke stays sharp on Retina and other HiDPI screens.
 */
export function backingStoreSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): { width: number; height: number; scale: number } {
  const ratio = Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
  const scale = Math.max(1, Math.ceil(ratio));
  return {
    width: Math.round(cssWidth * scale),
    height: Math.round(cssHeight * scale),
    scale,
  };
}
