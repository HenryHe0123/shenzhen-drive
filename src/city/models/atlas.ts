import * as THREE from 'three';

/** Anything canvas drawImage accepts that also reports its pixel size. */
type Drawable = CanvasImageSource & { width: number; height: number };

export interface AtlasTile {
  /** Source image, or null for a plain white swatch (color comes from vertex colors). */
  image: Drawable | null;
  /** Relative importance (e.g. surface area); scales the tile's share of the atlas. */
  weight: number;
}

export interface Atlas {
  texture: THREE.CanvasTexture;
  /** Per tile: u0, v0, du, dv in texture space (v down, glTF convention, flipY = false). */
  rects: Float32Array;
  size: [number, number];
}

const PAD = 4;

function drawable(img: unknown): img is Drawable {
  if (!img || typeof img !== 'object') return false;
  const o = img as { width?: unknown; height?: unknown };
  if (typeof o.width !== 'number' || typeof o.height !== 'number' || o.width < 1 || o.height < 1) return false;
  return (
    (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) ||
    (typeof HTMLImageElement !== 'undefined' && img instanceof HTMLImageElement) ||
    (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement) ||
    (typeof OffscreenCanvas !== 'undefined' && img instanceof OffscreenCanvas)
  );
}

/** The texture's image when it can be drawn into a canvas (not compressed / data textures). */
export function drawableImage(tex: THREE.Texture | null | undefined): Drawable | null {
  const img = tex?.image as unknown;
  return drawable(img) ? img : null;
}

interface Box {
  i: number;
  w: number;
  h: number;
  x: number;
  y: number;
}

/** Shelf packing; returns the used height, or Infinity when a box is wider than the atlas. */
function shelfPack(boxes: Box[], width: number): number {
  const sorted = boxes.slice().sort((a, b) => b.h - a.h);
  let x = 0;
  let y = 0;
  let shelfH = 0;
  for (const b of sorted) {
    if (b.w > width) return Infinity;
    if (x + b.w > width) {
      y += shelfH;
      x = 0;
      shelfH = 0;
    }
    b.x = x;
    b.y = y;
    x += b.w;
    shelfH = Math.max(shelfH, b.h);
  }
  return y + shelfH;
}

const pow2 = (v: number) => 2 ** Math.ceil(Math.log2(Math.max(1, v)));

/**
 * Packs a model's textures into one canvas texture so a GLB with many
 * materials still draws in one call. Each tile keeps a PAD-pixel border of its
 * own wrapped content, so bilinear filtering of repeated UVs (the shader wraps
 * with fract inside the rect) does not bleed in neighbours at the base levels.
 * Tile sizes follow the weights: important surfaces keep more texels.
 */
export function buildAtlas(tiles: AtlasTile[], maxSize: number, maxTile: number): Atlas {
  // Target edge length per tile from its weight, capped by its native size and maxTile.
  const totalW = tiles.reduce((a, t) => a + (t.image ? Math.max(t.weight, 1e-6) : 0), 0) || 1;
  const budget = maxSize * maxSize * 0.8;
  const boxes: Box[] = [];
  let scale = 1;
  const sizeFor = (t: AtlasTile) => {
    if (!t.image) return [4, 4];
    const share = Math.sqrt((budget * Math.max(t.weight, 1e-6)) / totalW);
    const native = Math.max(t.image.width, t.image.height);
    const edge = Math.max(8, Math.min(native, maxTile, share * 1.6) * scale);
    const k = edge / native;
    return [Math.max(4, Math.round(t.image.width * k)), Math.max(4, Math.round(t.image.height * k))];
  };
  let width = 0;
  let height = Infinity;
  for (let attempt = 0; attempt < 12; attempt++) {
    boxes.length = 0;
    let area = 0;
    tiles.forEach((t, i) => {
      const [w, h] = sizeFor(t);
      boxes.push({ i, w: w + PAD * 2, h: h + PAD * 2, x: 0, y: 0 });
      area += (w + PAD * 2) * (h + PAD * 2);
    });
    width = Math.min(maxSize, pow2(Math.sqrt(area)));
    height = shelfPack(boxes, width);
    if (height > width && width < maxSize) {
      width *= 2;
      height = shelfPack(boxes, width);
    }
    if (height <= maxSize) break;
    scale *= 0.8;
  }
  height = Math.min(maxSize, pow2(height));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d')!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.fillStyle = '#ffffff';
  const rects = new Float32Array(tiles.length * 4);
  for (const b of boxes) {
    const t = tiles[b.i];
    const w = b.w - PAD * 2;
    const h = b.h - PAD * 2;
    const x0 = b.x + PAD;
    const y0 = b.y + PAD;
    if (t.image) {
      g.save();
      g.beginPath();
      g.rect(b.x, b.y, b.w, b.h);
      g.clip();
      // 3x3 copies: the border holds the wrapped neighbours (repeat-mode texels).
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) g.drawImage(t.image, x0 + dx * w, y0 + dy * h, w, h);
      g.restore();
      rects.set([x0 / width, y0 / height, w / width, h / height], b.i * 4);
    } else {
      g.fillRect(b.x, b.y, b.w, b.h);
      // Degenerate rect at the swatch center: every UV samples plain white.
      rects.set([(x0 + w / 2) / width, (y0 + h / 2) / height, 0, 0], b.i * 4);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  return { texture, rects, size: [width, height] };
}
