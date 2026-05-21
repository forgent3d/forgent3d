import { describe, expect, it } from 'vitest';
import { assertKernel, isValidKernel, kernelMeta, languageBundle } from './kernel.js';

describe('kernel', () => {
  it('accepts build123d', () => {
    expect(isValidKernel('build123d')).toBe(true);
    expect(assertKernel('build123d')).toBe('build123d');
  });

  it('rejects unknown kernels', () => {
    expect(isValidKernel('freecad')).toBe(false);
    expect(() => assertKernel('freecad')).toThrow(/Invalid CAD kernel/);
  });

  it('returns metadata for build123d', () => {
    const meta = kernelMeta('build123d');
    expect(meta.previewFormat).toBe('BREP');
    expect(meta.cacheExt).toBe('.brep');
    expect(languageBundle(meta)).toBe('Python + build123d');
  });
});
