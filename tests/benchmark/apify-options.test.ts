import { describe, expect, it } from 'vitest';

import { parseActorId } from '../../scripts/apify-comparison/actor-id.js';
import {
  DEFAULT_ACTOR_ID,
  DEFAULT_MAX_CHARGE_USD,
  DEFAULT_MAX_URLS,
  HARD_MAX_CHARGE_USD,
  HARD_MAX_URLS,
  resolveOptions,
} from '../../scripts/apify-comparison/options.js';

const INPUT = { inputPath: 'urls.txt' };

describe('parseActorId', () => {
  it('converts the documented owner/name form to the API path form', () => {
    expect(parseActorId('clockworks/tiktok-scraper')).toEqual({
      input: 'clockworks/tiktok-scraper',
      pathId: 'clockworks~tiktok-scraper',
    });
  });

  it('accepts the tilde form unchanged and a bare technical id', () => {
    expect(parseActorId('clockworks~tiktok-scraper').pathId).toBe('clockworks~tiktok-scraper');
    expect(parseActorId('GdWCkxBtKWOsKjdch').pathId).toBe('GdWCkxBtKWOsKjdch');
  });

  it.each([
    ['empty', '   '],
    ['two separators', 'a/b/c'],
    ['path traversal', '../../etc/passwd'],
    ['a query string', 'clockworks/tiktok-scraper?token=x'],
    ['whitespace inside', 'clockworks/tik tok'],
    ['a leading dot', 'clockworks/.hidden'],
  ])('rejects %s', (_label, value) => {
    expect(() => parseActorId(value)).toThrow(/actor id/i);
  });
});

describe('resolveOptions', () => {
  it('defaults to a dry run against the documented Actor, with no token held', () => {
    const options = resolveOptions(INPUT, { APIFY_TOKEN: 'apify_api_abcdefghijklmnop' });

    expect(options.execute).toBe(false);
    expect(options.actor.input).toBe(DEFAULT_ACTOR_ID);
    expect(options.maxChargeUsd).toBe(DEFAULT_MAX_CHARGE_USD);
    expect(options.maxUrls).toBe(DEFAULT_MAX_URLS);
    // A dry run has no use for the token, so it does not carry one.
    expect(options.token).toBeNull();
  });

  it('refuses to execute without a token instead of quietly dry running', () => {
    expect(() => resolveOptions({ ...INPUT, execute: true }, {})).toThrow(/APIFY_TOKEN is not set/);
    expect(() => resolveOptions({ ...INPUT, execute: true }, { APIFY_TOKEN: '   ' })).toThrow(
      /APIFY_TOKEN is not set/,
    );
  });

  it('carries the token only in execute mode', () => {
    const options = resolveOptions(
      { ...INPUT, execute: true },
      { APIFY_TOKEN: 'apify_api_abcdefghijklmnop' },
    );
    expect(options.token).toBe('apify_api_abcdefghijklmnop');
  });

  it('reads the actor id from the environment when no flag is given', () => {
    const options = resolveOptions(INPUT, { APIFY_ACTOR_ID: 'someone/other-scraper' });
    expect(options.actor.pathId).toBe('someone~other-scraper');
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['not finite', Number.NaN],
  ])('rejects a %s charge cap', (_label, value) => {
    expect(() => resolveOptions({ ...INPUT, maxChargeUsd: value }, {})).toThrow(/--max-charge-usd/);
  });

  it('refuses a charge cap above the hard ceiling', () => {
    expect(() =>
      resolveOptions({ ...INPUT, maxChargeUsd: HARD_MAX_CHARGE_USD + 0.01 }, {}),
    ).toThrow(/hard ceiling/);
  });

  it('refuses a URL cap above the hard ceiling, and non-integers', () => {
    expect(() => resolveOptions({ ...INPUT, maxUrls: HARD_MAX_URLS + 1 }, {})).toThrow(
      /hard ceiling/,
    );
    expect(() => resolveOptions({ ...INPUT, maxUrls: 2.5 }, {})).toThrow(/--max-urls/);
    expect(() => resolveOptions({ ...INPUT, maxUrls: 0 }, {})).toThrow(/--max-urls/);
  });

  it('rejects implausibly short timeouts rather than accepting a 1ms deadline', () => {
    expect(() => resolveOptions({ ...INPUT, localTimeoutMs: 10 }, {})).toThrow(/local-timeout-ms/);
    expect(() => resolveOptions({ ...INPUT, apifyTimeoutMs: 10 }, {})).toThrow(/apify-timeout-ms/);
  });
});
