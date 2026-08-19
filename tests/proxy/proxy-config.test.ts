import { describe, expect, it } from 'vitest';

import { ScrapeError } from '../../src/core/models/errors.js';

import { parseProxyEntry, parseProxyList, proxyId, redactEntry } from '../../src/infrastructure/proxy/proxy-config.js';

describe('parseProxyEntry', () => {
  it('keeps a port that URL erases because it is the scheme default', () => {
    // `new URL('http://1.2.3.4:80').port` is the empty string, which read as
    // "no port given" and rejected the entry. The port was in the input all
    // along; only the parser lost it. 7.5% of one real free-proxy list.
    expect(proxyId(parseProxyEntry('http://1.2.3.4:80'))).toBe('http://1.2.3.4:80');
    expect(proxyId(parseProxyEntry('https://1.2.3.4:443'))).toBe('https://1.2.3.4:443');
  });

  it('still rejects an entry with no port at all', () => {
    // socks has no default to fall back on, so the omission is still an error.
    expect(() => parseProxyEntry('socks5://1.2.3.4')).toThrow(/valid port/);
  });

  it('rejects out-of-range ports and unsupported protocols', () => {
    expect(() => parseProxyEntry('http://1.2.3.4:0')).toThrow(/valid port/);
    // `URL` rejects this one outright, before the port check is reached.
    expect(() => parseProxyEntry('http://1.2.3.4:99999')).toThrow(ScrapeError);
    expect(() => parseProxyEntry('ftp://1.2.3.4:21')).toThrow(/unsupported proxy protocol/);
  });

  it('keeps credentials out of the id and out of error messages', () => {
    const target = parseProxyEntry('http://user:secret@gate.example.net:8000');

    expect(target.username).toBe('user');
    expect(proxyId(target)).toBe('http://gate.example.net:8000');
    expect(redactEntry('http://user:secret@gate.example.net:8000')).not.toContain('secret');
  });

  it('parses a mixed-separator configured list', () => {
    expect(parseProxyList('http://1.2.3.4:80, http://5.6.7.8:3128\nhttp://9.9.9.9:8080')).toHaveLength(3);
  });
});
