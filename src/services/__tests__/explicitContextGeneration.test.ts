import { describe, expect, it } from 'vitest';
import { requireLegoModel, validateContextRange } from '../explicitContextGeneration';

describe('explicit context preflight', () => {
  it('rejects Turbo even when selected and loaded', () => {
    expect(() => requireLegoModel([{ name: 'turbo', is_loaded: true, is_default: true, supported_task_types: ['text2music', 'cover'] }], 'turbo')).toThrow('LEGO_UNAVAILABLE');
  });
  it('accepts only the requested loaded Lego model', () => {
    expect(requireLegoModel([{ name: 'base', is_loaded: true, is_default: false, supported_task_types: ['lego'] }], 'base')).toBe('base');
  });
  it.each([[0, 48001], [-1, 100], [100, 100], [0.5, 100]])('rejects invalid canonical range %s to %s', (start, end) => {
    expect(() => validateContextRange(48000, start, end)).toThrow('INVALID_RANGE');
  });
});
