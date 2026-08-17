import { describe, expect, it } from 'vitest';

import { normalizeUrlGeneric } from '../../src/core/url/generic.js';
import { createDefaultUrlNormalizerRegistry } from '../../src/platforms/index.js';
import { InstagramUrlNormalizer } from '../../src/platforms/instagram/instagram-url-normalizer.js';
import { TikTokUrlNormalizer } from '../../src/platforms/tiktok/tiktok-url-normalizer.js';

describe('normalizeUrlGeneric', () => {
  it('trims whitespace and assumes https when no scheme is given', () => {
    const result = normalizeUrlGeneric('  www.tiktok.com/@a/video/1  ');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.toString()).toBe('https://www.tiktok.com/@a/video/1');
    }
  });

  it('lowercases the host and drops the default port and fragment', () => {
    const result = normalizeUrlGeneric('HTTPS://WWW.TikTok.com:443/@a/video/1#comments');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.toString()).toBe('https://www.tiktok.com/@a/video/1');
    }
  });

  it('drops generic tracking parameters but keeps unknown ones', () => {
    const result = normalizeUrlGeneric(
      'https://www.tiktok.com/@a/video/1?utm_source=x&fbclid=y&lang=en',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.searchParams.get('utm_source')).toBeNull();
      expect(result.url.searchParams.get('fbclid')).toBeNull();
      expect(result.url.searchParams.get('lang')).toBe('en');
    }
  });

  it('sorts remaining parameters so equivalent URLs de-duplicate', () => {
    const a = normalizeUrlGeneric('https://example.com/x?b=2&a=1');
    const b = normalizeUrlGeneric('https://example.com/x?a=1&b=2');
    expect(a.ok && b.ok && a.url.toString() === b.url.toString()).toBe(true);
  });

  it('preserves the path exactly, including a trailing slash', () => {
    const result = normalizeUrlGeneric('https://www.instagram.com/reel/ABC/');
    expect(result.ok && result.url.pathname).toBe('/reel/ABC/');
  });

  it('rejects empty, unparseable and non-http input', () => {
    expect(normalizeUrlGeneric('   ').ok).toBe(false);
    expect(normalizeUrlGeneric('http://').ok).toBe(false);
    expect(normalizeUrlGeneric('ftp://example.com/file').ok).toBe(false);
    expect(normalizeUrlGeneric('not a url at all').ok).toBe(false);
  });
});

describe('TikTokUrlNormalizer', () => {
  const normalizer = new TikTokUrlNormalizer();

  it('claims tiktok.com and its subdomains', () => {
    expect(normalizer.matches(new URL('https://www.tiktok.com/@a/video/1'))).toBe(true);
    expect(normalizer.matches(new URL('https://vm.tiktok.com/ABC/'))).toBe(true);
    expect(normalizer.matches(new URL('https://nottiktok.com/@a/video/1'))).toBe(false);
  });

  it('flags short-link hosts as needing resolution', () => {
    const short = normalizer.normalize('https://vm.tiktok.com/ABC123/');
    expect(short.ok && short.requiresResolution).toBe(true);

    const canonical = normalizer.normalize('https://www.tiktok.com/@a/video/1');
    expect(canonical.ok && canonical.requiresResolution).toBe(false);
  });

  it('extracts the native video id from a canonical path', () => {
    const result = normalizer.normalize('https://www.tiktok.com/@a/video/1234567890');
    expect(result.ok && result.videoId).toBe('1234567890');
  });

  it('accepts and canonicalizes photo post URLs', () => {
    const result = normalizer.normalize('https://www.tiktok.com/@creator/photo/1234567890?lang=en');
    expect(result.ok && result.url).toBe('https://www.tiktok.com/@creator/photo/1234567890');
    expect(result.ok && result.videoId).toBe('1234567890');
  });

  it('canonicalizes the host, trailing slash and query parameters', () => {
    const result = normalizer.normalize(
      'http://m.tiktok.com/@creator/video/1234567890/?lang=en&utm_source=share',
    );
    expect(result.ok && result.url).toBe('https://www.tiktok.com/@creator/video/1234567890');
    expect(result.ok && result.changed).toBe(true);
  });

  it('rejects non-post paths and nonnumeric post ids', () => {
    expect(normalizer.normalize('https://www.tiktok.com/@creator').ok).toBe(false);
    expect(normalizer.normalize('https://www.tiktok.com/@creator/video/not-an-id').ok).toBe(false);
  });

  it('rejects a URL from another host', () => {
    const result = normalizer.normalize('https://www.instagram.com/reel/ABC/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unsupported_platform');
  });
});

describe('InstagramUrlNormalizer', () => {
  const normalizer = new InstagramUrlNormalizer();

  it('canonicalizes supported Instagram video URL forms', () => {
    const reel = normalizer.normalize('https://www.instagram.com/reel/ABC123/?utm_source=share');
    const post = normalizer.normalize('https://www.instagram.com/p/ABC123/');
    const plural = normalizer.normalize('https://instagram.com/reels/ABC123?igsh=tracking');
    const tv = normalizer.normalize('https://m.instagram.com/tv/ABC123/');

    expect(reel.ok && reel.url).toBe('https://www.instagram.com/reel/ABC123/');
    expect(post.ok && post.url).toBe('https://www.instagram.com/p/ABC123/');
    expect(plural.ok && plural.url).toBe('https://www.instagram.com/reel/ABC123/');
    expect(tv.ok && tv.url).toBe('https://www.instagram.com/tv/ABC123/');
  });

  it('derives the stable numeric media id from the shortcode', () => {
    const result = normalizer.normalize('https://www.instagram.com/reel/ABC123/');
    expect(result.ok && result.videoId).toMatch(/^\d+$/);
  });

  it('rejects profiles, explore pages and malformed post paths', () => {
    expect(normalizer.normalize('https://www.instagram.com/creator/').ok).toBe(false);
    expect(normalizer.normalize('https://www.instagram.com/explore/').ok).toBe(false);
    expect(normalizer.normalize('https://www.instagram.com/reel/').ok).toBe(false);
  });
});

describe('UrlNormalizerRegistry', () => {
  const registry = createDefaultUrlNormalizerRegistry();

  it('routes by host', () => {
    expect(registry.detect('https://www.tiktok.com/@a/video/1')).toBe('tiktok');
    expect(registry.detect('https://www.instagram.com/reel/A/')).toBe('instagram');
    expect(registry.detect('https://example.com/video/1')).toBeNull();
  });

  it('reports an unsupported host distinctly from an invalid URL', () => {
    const unsupported = registry.normalize('https://example.com/video/1');
    const invalid = registry.normalize('%%%');

    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.code).toBe('unsupported_platform');

    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.code).toBe('invalid_url');
  });
});
