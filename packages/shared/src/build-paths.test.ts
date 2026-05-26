import { describe, expect, it } from 'vitest';
import { modelCacheRel, resolveModelSourceRel, resolveMotionSourceRel } from './build-paths.js';

describe('build paths', () => {
  it('uses assembly.py as the primary CAD source before part.py', () => {
    const source = resolveModelSourceRel([
      'models/gear/asm.xml',
      'models/gear/part.py',
      'models/gear/assembly.py'
    ], 'gear', 'build123d');

    expect(source).toEqual({
      kind: 'assembly',
      fileName: 'assembly.py',
      relPath: 'models/gear/assembly.py'
    });
    expect(modelCacheRel('gear', source, 'build123d')).toBe('.cache/gear.brep');
  });

  it('does not select asm.xml as a CAD source', () => {
    expect(resolveModelSourceRel(['models/linkage/asm.xml'], 'linkage', 'build123d')).toBeNull();
    expect(resolveMotionSourceRel(['models/linkage/asm.xml'], 'linkage')).toEqual({
      kind: 'motion',
      fileName: 'asm.xml',
      relPath: 'models/linkage/asm.xml'
    });
  });
});
