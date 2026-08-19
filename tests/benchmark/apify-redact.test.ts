import { describe, expect, it } from 'vitest';

import { REDACTED, redactDeep, redactString } from '../../scripts/apify-comparison/redact.js';

const TOKEN = 'apify_api_0123456789abcdef';

describe('redactDeep', () => {
  it('blanks secret-looking keys at any depth', () => {
    const redacted = redactDeep({
      actor: { input: { postURLs: ['https://x'] } },
      auth: { token: TOKEN, Authorization: `Bearer ${TOKEN}`, cookie: 'sessionid=abc' },
      nested: [{ apiKey: 'k' }, { password: 'p' }],
    });

    expect(redacted).toEqual({
      actor: { input: { postURLs: ['https://x'] } },
      auth: { token: REDACTED, Authorization: REDACTED, cookie: REDACTED },
      nested: [{ apiKey: REDACTED }, { password: REDACTED }],
    });
  });

  it('blanks a supplied secret wherever it appears in a value', () => {
    const redacted = redactDeep(
      { message: `run failed for https://api.apify.com/v2/acts?x=${TOKEN}` },
      { secrets: [TOKEN] },
    );
    expect(JSON.stringify(redacted)).not.toContain(TOKEN);
    expect(JSON.stringify(redacted)).toContain(REDACTED);
  });

  it('blanks an Apify-shaped token even when it was never supplied as a secret', () => {
    const redacted = redactDeep({ actorMessage: `bad token ${TOKEN} rejected` });
    expect(JSON.stringify(redacted)).not.toContain(TOKEN);
  });

  it('ignores short "secrets" that would corrupt unrelated text', () => {
    expect(redactString('a views count of 100', ['100'])).toBe('a views count of 100');
  });

  it('does not mutate its input', () => {
    const original = { token: TOKEN };
    redactDeep(original);
    expect(original.token).toBe(TOKEN);
  });

  it('survives a cyclic object rather than overflowing the stack', () => {
    const cyclic: Record<string, unknown> = { name: 'run' };
    cyclic.self = cyclic;
    expect(redactDeep(cyclic)).toEqual({ name: 'run', self: '[circular]' });
  });
});
