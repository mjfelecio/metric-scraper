import { describe, expect, it } from 'vitest';

import { parseProxySourceText } from '../../src/infrastructure/proxy/parse-proxy-source.js';

describe('parseProxySourceText', () => {
  it('parses the protocol/ip/port text format', () => {
    const result = parseProxySourceText('http://1.2.3.4:8080\nhttp://5.6.7.8:3128\n');

    expect(result.targets.map((target) => target.url)).toEqual([
      'http://1.2.3.4:8080/',
      'http://5.6.7.8:3128/',
    ]);
    expect(result.total).toBe(2);
    expect(result.malformed).toBe(0);
  });

  it('skips malformed entries instead of failing the whole refresh', () => {
    // A typo in PROXY_POOL is an operator mistake and should be fatal. One bad
    // row in a list of thousands is routine, and losing the other 999 over it
    // would be the actual failure.
    const result = parseProxySourceText(
      ['http://1.2.3.4:8080', 'not-a-proxy', 'ftp://9.9.9.9:21', 'garbage://', '1.2.3.4:8080'].join(
        '\n',
      ),
    );

    expect(result.targets.map((target) => target.port)).toEqual([8080]);
    expect(result.malformed).toBe(4);
  });

  it('deduplicates by the same identity the pool uses', () => {
    const result = parseProxySourceText(
      ['http://1.2.3.4:8080', 'http://1.2.3.4:8080', 'http://1.2.3.4:8081'].join('\n'),
    );

    expect(result.targets).toHaveLength(2);
    expect(result.duplicates).toBe(1);
  });

  it('tolerates CRLF, blank lines, comments and separator noise', () => {
    const result = parseProxySourceText(
      '\r\nhttp://1.2.3.4:8080\r\n\r\n# a comment\r\nhttp://5.6.7.8:3128,http://9.9.9.9:80;\r\n',
    );

    expect(result.targets).toHaveLength(3);
    expect(result.malformed).toBe(0);
  });

  it('reports an empty response as empty rather than throwing', () => {
    expect(parseProxySourceText('')).toEqual({
      targets: [],
      total: 0,
      malformed: 0,
      duplicates: 0,
    });
  });

  it('reports a response of pure garbage as fully malformed', () => {
    const result = parseProxySourceText('<html><body>rate limited</body></html>');

    expect(result.targets).toHaveLength(0);
    expect(result.malformed).toBeGreaterThan(0);
  });
});
