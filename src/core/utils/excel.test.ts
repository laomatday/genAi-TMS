import { describe, expect, it } from 'vitest';
import { normalizeBrandHex } from './excel';

describe('normalizeBrandHex', () => {
  it('keeps a six digit hex, uppercased', () => {
    expect(normalizeBrandHex('#243c8f')).toBe('#243C8F');
    expect(normalizeBrandHex('  #DCEEF2  ')).toBe('#DCEEF2');
  });

  // Production CSS minification shortens `--color-on-dark: #FFFFFF` to `#fff`,
  // which used to fail the export with a "missing colour token" error.
  it('expands the shortened hex a minifier emits', () => {
    expect(normalizeBrandHex('#fff')).toBe('#FFFFFF');
    expect(normalizeBrandHex('#123')).toBe('#112233');
  });

  it('drops the alpha channel Excel fills cannot represent', () => {
    expect(normalizeBrandHex('#243c8fcc')).toBe('#243C8F');
    expect(normalizeBrandHex('#fff8')).toBe('#FFFFFF');
  });

  it('accepts the rgb forms getComputedStyle can return', () => {
    expect(normalizeBrandHex('rgb(36, 60, 143)')).toBe('#243C8F');
    expect(normalizeBrandHex('rgba(255 255 255 / 0.5)')).toBe('#FFFFFF');
  });

  it('rejects anything that would produce a malformed workbook colour', () => {
    expect(normalizeBrandHex('')).toBeNull();
    expect(normalizeBrandHex('#ff')).toBeNull();
    expect(normalizeBrandHex('#fffff')).toBeNull();
    expect(normalizeBrandHex('var(--brand-navy)')).toBeNull();
    expect(normalizeBrandHex('rgb(300, 0, 0)')).toBeNull();
    // Colour keywords are resolved by the browser, never guessed here.
    expect(normalizeBrandHex('red')).toBeNull();
  });
});
