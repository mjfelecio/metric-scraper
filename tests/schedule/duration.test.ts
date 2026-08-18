import { describe, expect, it } from 'vitest';

import { formatDuration, parseDuration } from '../../src/core/schedule/duration.js';

describe('parseDuration', () => {
  it('treats a bare number as milliseconds', () => {
    expect(parseDuration('0')).toBe(0);
    expect(parseDuration('500')).toBe(500);
  });

  it('accepts the units the CLI documents', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('2h')).toBe(7_200_000);
  });

  it('tolerates whitespace, case and long unit spellings', () => {
    expect(parseDuration('  15 MIN ')).toBe(900_000);
    expect(parseDuration('1.5h')).toBe(5_400_000);
  });

  it('rejects junk rather than guessing', () => {
    expect(() => parseDuration('')).toThrow(/invalid duration/);
    expect(() => parseDuration('soon')).toThrow(/invalid duration/);
    expect(() => parseDuration('10 days')).toThrow(/unknown unit/);
    expect(() => parseDuration('-5m')).toThrow(/invalid duration/);
  });
});

describe('formatDuration', () => {
  it('renders the ranges an operator actually sees', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(30_000)).toBe('30s');
    expect(formatDuration(95_000)).toBe('1m35s');
    expect(formatDuration(900_000)).toBe('15m');
    expect(formatDuration(5_400_000)).toBe('1h30m');
    expect(formatDuration(7_200_000)).toBe('2h');
  });
});
