import { describe, expect, it } from 'vitest';

import { InMemorySessionPool } from '../../src/infrastructure/session/in-memory-session-pool.js';
import { SessionFileSchema } from '../../src/infrastructure/session/session-store.js';

const sessions = [
  {
    id: 'direct',
    platform: 'instagram' as const,
    proxyId: null,
    cookie: 'sessionid=direct',
    userAgent: null,
    headers: {},
  },
  {
    id: 'sticky',
    platform: 'instagram' as const,
    proxyId: 'http://proxy.example:8000',
    cookie: 'sessionid=sticky',
    userAgent: null,
    headers: {},
  },
];

describe('Instagram session affinity', () => {
  it('only leases a session bound to the selected proxy identity', async () => {
    const pool = new InMemorySessionPool({ sessions });
    const direct = await pool.acquire('instagram', undefined, null);
    const sticky = await pool.acquire('instagram', undefined, 'http://proxy.example:8000');
    const unmatched = await pool.acquire('instagram', undefined, 'http://other.example:8000');

    expect(direct?.id).toBe('direct');
    expect(sticky?.id).toBe('sticky');
    expect(unmatched).toBeNull();
  });

  it('defaults legacy session files to direct-only affinity', () => {
    const parsed = SessionFileSchema.parse({
      sessions: [
        {
          id: 'legacy',
          platform: 'instagram',
          cookie: 'sessionid=test',
        },
      ],
    });
    expect(parsed.sessions[0]?.proxyId).toBeNull();
  });
});
