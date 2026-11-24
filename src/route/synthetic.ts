import type { RouteData, Vec2 } from './types';

type Piece = { straight: number } | { radius: number; angleDeg: number };

/**
 * Placeholder route with the same shape language as the real one (long straights,
 * gentle arcs, a single left turn before the finish). Used by tests and when
 * public/data/route.json is not available yet.
 */
export function makeSyntheticRoute(spacing = 2): RouteData {
  const pieces: Piece[] = [
    { straight: 700 },
    { radius: 2500, angleDeg: -6 },
    { straight: 900 },
    { radius: 1800, angleDeg: 8 },
    { straight: 1100 },
    { radius: 3000, angleDeg: -2 },
    { straight: 700 },
    { radius: 30, angleDeg: 90 },
    { straight: 420 },
  ];

  // Heading as yaw: forward = (-sin(yaw), -cos(yaw)); east is yaw = -PI/2. Left turns increase yaw.
  let yaw = -Math.PI / 2;
  let x = 0;
  let z = 0;
  const step = 0.25;
  const dense: Vec2[] = [[0, 0]];
  let turnS0 = 0;
  let turnS1 = 0;
  let s = 0;
  for (const p of pieces) {
    const len = 'straight' in p ? p.straight : (p.radius * Math.abs(p.angleDeg) * Math.PI) / 180;
    const dYaw = 'straight' in p ? 0 : (Math.sign(p.angleDeg) * step) / p.radius;
    if ('radius' in p && p.radius < 100) turnS0 = s;
    for (let t = 0; t < len - 1e-9; t += step) {
      const h = Math.min(step, len - t);
      yaw += dYaw * (h / step) * 0.5;
      x += -Math.sin(yaw) * h;
      z += -Math.cos(yaw) * h;
      yaw += dYaw * (h / step) * 0.5;
      s += h;
      dense.push([x, z]);
    }
    if ('radius' in p && p.radius < 100) turnS1 = s;
  }

  const total = s;
  const centerline: Vec2[] = [];
  const count = Math.floor(total / spacing);
  for (let i = 0; i <= count; i++) {
    const idx = Math.min(dense.length - 1, Math.round((i * spacing) / step));
    centerline.push(dense[idx]);
  }
  if (count * spacing < total - 1e-6) centerline.push(dense[dense.length - 1]);

  const length = total;
  const finishS = turnS1 + 220;
  const round = (v: number) => Math.round(v * 10) / 10;

  return {
    meta: {
      generatedAt: new Date(0).toISOString(),
      osmTimestamp: null,
      source: 'synthetic placeholder',
      origin: { lon: 113.94, lat: 22.54 },
      realLength: length,
      length,
      cuts: [],
      sampleSpacing: spacing,
    },
    centerline: centerline.map(([a, b]) => [round(a), round(b)]),
    road: { lanes: 4, laneWidth: 3.5, halfWidthLeft: 7, halfWidthRight: 7 },
    sections: [
      { id: 'nanshan', name: '南山科技园', s0: 0, s1: 1000 },
      { id: 'oct', name: '世界之窗 / 华侨城', s0: 1000, s1: 2300 },
      { id: 'chegongmiao', name: '车公庙 / 香蜜湖', s0: 2300, s1: 3500 },
      { id: 'futian', name: '福田中心区', s0: 3500, s1: length },
    ],
    checkpoints: [
      { s: 900, name: '科技园' },
      { s: 1900, name: '世界之窗' },
      { s: 2900, name: '香蜜湖' },
      { s: turnS1 + 60, name: '福田中心区' },
    ],
    finish: { s: finishS, name: '市民中心' },
    turn: { s0: turnS0, s1: turnS1, direction: 'left', name: '金田路' },
    intersections: [
      { s: 400, name: '科技中一路' },
      { s: 1600, name: '侨城西街' },
      { s: 2700, name: '香蜜湖路' },
      { s: turnS0 - 10, name: '金田路' },
    ],
    landmarks: [],
    signs: [
      { s: 2690, side: 'right', text: '深圳国际交流中心', sub: '2026 APEC 主会场 →' },
      { s: turnS0 - 250, side: 'right', text: '市民中心 ←', sub: '左转 金田路' },
    ],
  };
}
