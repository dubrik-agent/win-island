/**
 * Escape is a shared key. A popover, an inline editor or the hotkey recorder
 * must get it before the island itself, otherwise the panel would vanish
 * together with whatever the user was editing.
 *
 * Layers are checked top-down: the last registered one is the innermost.
 * A layer returns `true` when it consumed the key.
 */
export type EscapeLayer = () => boolean;

const layers: EscapeLayer[] = [];

/** Register a layer; call the returned function to remove it again. */
export function pushEscapeLayer(layer: EscapeLayer): () => void {
  layers.push(layer);
  return () => {
    const index = layers.lastIndexOf(layer);
    if (index >= 0) layers.splice(index, 1);
  };
}

/**
 * Give the top-most layer a chance to swallow Esc.
 * `true` means something handled it and the island must stay open.
 */
export function escapeTopLayer(): boolean {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (layer()) return true;
  }
  return false;
}

/** Number of open layers — handy for tests and for the debug bridge. */
export function escapeLayerCount(): number {
  return layers.length;
}
