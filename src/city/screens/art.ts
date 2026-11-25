import { FONT } from '../props/signs';

const LATIN = '"Helvetica Neue","Arial Black",Arial,sans-serif';

function fit(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, maxW: number, size: number, weight: number, family: string) {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (ctx.measureText(text).width > maxW && s > 8) {
    s -= 4;
    ctx.font = `${weight} ${s}px ${family}`;
  }
  ctx.fillText(text, cx, cy);
}

/**
 * Landscape LED face (2:1): the APEC art's skyline-and-waves illustration on the left, the slogan
 * on a deep-blue panel on the right in type large enough to read from a few hundred meters
 * ("APEC China 2026" over 相约深圳 / 见证奇迹). Text and original artwork only, no emblem. Without
 * the image the left panel falls back to a teal-coral gradient.
 */
export function drawApecFace(canvas: HTMLCanvasElement, art: CanvasImageSource | null, artW: number, artH: number): void {
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#06173d');
  bg.addColorStop(1, '#0b3f73');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const AW = Math.round(W * 0.36);
  if (art) {
    // Skyline, mountains and waves (below the poster's own small type), cropped to the panel.
    const sy = artH * 0.265;
    const sh = artH - sy;
    const sw = Math.min(artW, (sh * AW) / H);
    ctx.drawImage(art, (artW - sw) / 2, sy, sw, sh, 0, 0, AW, H);
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#dff3f5');
    g.addColorStop(0.55, '#1aa3a0');
    g.addColorStop(0.8, '#f0553f');
    g.addColorStop(1, '#0d7f8a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, AW, H);
  }
  const seam = ctx.createLinearGradient(AW - 90, 0, AW + 10, 0);
  seam.addColorStop(0, 'rgba(6,23,61,0)');
  seam.addColorStop(1, 'rgba(7,27,66,1)');
  ctx.fillStyle = seam;
  ctx.fillRect(AW - 90, 0, 100, H);

  // Wave ribbons along the bottom of the text panel, echoing the art.
  const ribbon = (y: number, amp: number, color: string, lw: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.beginPath();
    for (let x = AW - 20; x <= W; x += 16) {
      const yy = y + Math.sin((x - AW) / 150) * amp + Math.sin((x - AW) / 61) * amp * 0.3;
      if (x === AW - 20) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  };
  ribbon(H - 34, 12, 'rgba(255,98,72,0.85)', 14);
  ribbon(H - 12, 9, 'rgba(38,190,190,0.8)', 12);

  const cx = AW + (W - AW) / 2;
  const tw = (W - AW) * 0.88;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 12;
  ctx.fillStyle = '#ffffff';
  fit(ctx, 'APEC China 2026', cx, H * 0.15, tw, Math.round(H * 0.17), 800, LATIN);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#ff6b4a';
  ctx.fillRect(cx - W * 0.12, H * 0.27, W * 0.24, Math.max(4, H * 0.011));
  ctx.shadowBlur = 14;
  ctx.fillStyle = '#ffffff';
  fit(ctx, '相约深圳', cx, H * 0.45, tw, Math.round(H * 0.29), 900, FONT);
  ctx.fillStyle = '#ffe3a3';
  fit(ctx, '见证奇迹', cx, H * 0.76, tw, Math.round(H * 0.29), 900, FONT);
  ctx.shadowBlur = 0;
}
