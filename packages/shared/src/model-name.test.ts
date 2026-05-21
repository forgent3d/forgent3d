import { describe, expect, it } from 'vitest';
import { isValidModelName, normalizeModelName } from './model-name.js';

describe('model-name', () => {
  it('normalizes valid names', () => {
    expect(normalizeModelName('  bracket_01  ')).toBe('bracket_01');
    expect(isValidModelName('mount-plate')).toBe(true);
  });

  it('rejects invalid characters', () => {
    expect(isValidModelName('bad name')).toBe(false);
    expect(() => normalizeModelName('bad name')).toThrow(/letters, numbers/);
    expect(() => normalizeModelName('')).toThrow(/letters, numbers/);
  });
});
