import { describe, expect, it } from 'vitest';

import { parseInput, type ParseInputOptions } from '../../src/core/input/parse-input.js';
import { type ParsedInput } from '../../src/core/models/input.js';
import { createDefaultUrlNormalizerRegistry } from '../../src/platforms/index.js';

const registry = createDefaultUrlNormalizerRegistry();

function parse(text: string, options: Omit<ParseInputOptions, 'registry'> = {}): ParsedInput {
  return parseInput(text, { registry, ...options });
}

describe('newline-delimited input', () => {
  it('accepts one URL per line', () => {
    const parsed = parse(
      [
        'https://www.tiktok.com/@a/video/1',
        'https://www.tiktok.com/@a/video/2',
        'https://www.tiktok.com/@a/video/3',
      ].join('\n'),
    );

    expect(parsed.format).toBe('text');
    expect(parsed.records).toHaveLength(3);
    expect(parsed.issues).toHaveLength(0);
    expect(parsed.records[0]?.platform).toBe('tiktok');
  });

  it('skips blank lines and comments without treating them as errors', () => {
    const parsed = parse('\n\n# a comment\nhttps://www.tiktok.com/@a/video/1\n   \n');
    expect(parsed.records).toHaveLength(1);
    expect(parsed.issues).toHaveLength(0);
  });

  it('handles CRLF line endings', () => {
    const parsed = parse('https://www.tiktok.com/@a/video/1\r\nhttps://www.tiktok.com/@a/video/2');
    expect(parsed.records).toHaveLength(2);
  });

  it('reports the line number of an invalid URL and keeps the rest', () => {
    const parsed = parse(
      'https://www.tiktok.com/@a/video/1\nnot a url\nhttps://www.tiktok.com/@a/video/2',
    );

    expect(parsed.records).toHaveLength(2);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]?.code).toBe('invalid_url');
    expect(parsed.issues[0]?.position).toBe(2);
    expect(parsed.issues[0]?.value).toBe('not a url');
  });

  it('reports an unsupported host rather than dropping it', () => {
    const parsed = parse('https://example.com/video/1');
    expect(parsed.records).toHaveLength(0);
    expect(parsed.issues[0]?.code).toBe('unsupported_platform');
  });

  it('reports duplicates after normalization and keeps the first occurrence', () => {
    const parsed = parse(
      [
        'https://www.tiktok.com/@a/video/1',
        'https://www.tiktok.com/@a/video/1?utm_source=share',
        'https://www.tiktok.com/@a/video/2',
      ].join('\n'),
    );

    expect(parsed.records).toHaveLength(2);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]?.code).toBe('duplicate_url');
    expect(parsed.issues[0]?.message).toContain('position 1');
  });

  it('can keep duplicates when de-duplication is off', () => {
    const parsed = parse('https://www.tiktok.com/@a/video/1\nhttps://www.tiktok.com/@a/video/1', {
      dedupe: false,
    });
    expect(parsed.records).toHaveLength(2);
  });

  it('rejects URLs from another platform when one is expected', () => {
    const parsed = parse('https://www.instagram.com/reel/A/', { expectedPlatform: 'tiktok' });
    expect(parsed.records).toHaveLength(0);
    expect(parsed.issues[0]?.code).toBe('platform_mismatch');
  });

  it('flags empty input', () => {
    const parsed = parse('   \n\n  ');
    expect(parsed.records).toHaveLength(0);
    expect(parsed.issues[0]?.code).toBe('empty_input');
  });
});

describe('JSON array input', () => {
  it('is detected automatically and parsed', () => {
    const parsed = parse(
      JSON.stringify(['https://www.instagram.com/reel/A/', 'https://www.instagram.com/p/B/']),
    );

    expect(parsed.format).toBe('json');
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[1]?.platform).toBe('instagram');
  });

  it('reports malformed JSON as a fatal issue instead of guessing', () => {
    const parsed = parse('["https://www.instagram.com/reel/A/",]');
    expect(parsed.records).toHaveLength(0);
    expect(parsed.issues[0]?.code).toBe('malformed_json');
  });

  it('reports a JSON object where an array was expected', () => {
    const parsed = parse('{"urls": []}', { format: 'json' });
    expect(parsed.issues[0]?.code).toBe('unexpected_json_shape');
  });

  it('reports non-string entries with their index', () => {
    const parsed = parse(JSON.stringify(['https://www.instagram.com/reel/A/', 42, null]));
    expect(parsed.records).toHaveLength(1);
    expect(parsed.issues.map((issue) => issue.code)).toEqual(['not_a_string', 'not_a_string']);
    expect(parsed.issues[0]?.position).toBe(2);
  });

  it('reports empty strings inside the array', () => {
    const parsed = parse(JSON.stringify(['https://www.instagram.com/reel/A/', '  ']));
    expect(parsed.issues[0]?.code).toBe('invalid_url');
  });

  it('honours an explicit text format even when the input looks like JSON', () => {
    const parsed = parse('["https://www.instagram.com/reel/A/"]', { format: 'text' });
    expect(parsed.records).toHaveLength(0);
    expect(parsed.issues[0]?.code).toBe('invalid_url');
  });
});

describe('normalization during parsing', () => {
  it('stores both the raw and the normalized URL', () => {
    const parsed = parse('  WWW.TIKTOK.COM/@a/video/1?utm_source=share  ');
    expect(parsed.records[0]?.raw_url).toBe('WWW.TIKTOK.COM/@a/video/1?utm_source=share');
    expect(parsed.records[0]?.url).toBe('https://www.tiktok.com/@a/video/1');
    expect(parsed.records[0]?.requires_resolution).toBe(false);
  });

  it('preserves the need for network resolution on TikTok short links', () => {
    const parsed = parse('https://vm.tiktok.com/ABC123/?utm_source=share');
    expect(parsed.records[0]).toMatchObject({
      url: 'https://vm.tiktok.com/ABC123/',
      platform: 'tiktok',
      requires_resolution: true,
    });
  });
});
