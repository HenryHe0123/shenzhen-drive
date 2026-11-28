import { describe, expect, it } from 'vitest';
import { getQuality, onQualityChange, qualitySettings, setQuality } from '../src/render/quality';

describe('quality preset', () => {
  it('defaults to standard with lighter pixel ratio and streaming radii than high', () => {
    setQuality('standard');
    expect(getQuality()).toBe('standard');
    const std = qualitySettings('standard');
    const hi = qualitySettings('high');
    expect(std.maxPixelRatio).toBeLessThan(hi.maxPixelRatio);
    expect(std.detailRadius).toBeLessThan(hi.detailRadius);
    expect(std.massRadius).toBeLessThan(hi.massRadius);
    expect(std.massCull).toBeGreaterThan(hi.massCull);
  });

  it('notifies subscribers when switching quality and ignores no-op updates', () => {
    setQuality('standard');
    const seen: string[] = [];
    const off = onQualityChange((q) => seen.push(q));
    setQuality('standard');
    setQuality('high');
    setQuality('high');
    setQuality('standard');
    off();
    setQuality('high');
    expect(seen).toEqual(['high', 'standard']);
    setQuality('standard');
  });
});
