import { describe, expect, it, vi } from 'vitest';

import {
  ApifyClient,
  type ApifyHttpRequest,
  type ApifyHttpResponse,
  type ApifyTransport,
} from '../../scripts/apify-comparison/apify-client.js';

const TOKEN = 'apify_api_0123456789abcdef';

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ApifyHttpResponse {
  return { status, headers, body: JSON.stringify(body) };
}

function runPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: {
      id: 'RUN1',
      actId: 'ACT1',
      status: 'SUCCEEDED',
      defaultDatasetId: 'DS1',
      buildNumber: '0.1.42',
      startedAt: '2026-08-19T10:00:00.000Z',
      finishedAt: '2026-08-19T10:00:12.000Z',
      usageTotalUsd: 0.012,
      chargedEventCounts: { 'video-result': 4 },
      stats: { netRxBytes: 4_000, netTxBytes: 500, runTimeSecs: 12 },
      ...overrides,
    },
  };
}

/** Records every request so the test can assert on headers and URLs. */
function recordingTransport(responses: readonly ApifyHttpResponse[]): {
  transport: ApifyTransport;
  requests: ApifyHttpRequest[];
} {
  const requests: ApifyHttpRequest[] = [];
  let index = 0;
  return {
    requests,
    transport: {
      request: (request) => {
        requests.push(request);
        const response = responses[Math.min(index, responses.length - 1)];
        index += 1;
        if (response === undefined) throw new Error('no canned response left');
        return Promise.resolve(response);
      },
    },
  };
}

/** Resolves to the rejection message, so a leak check reads as one assertion. */
async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the promise to reject');
}

function client(transport: ApifyTransport, deadlineMs = 60_000): ApifyClient {
  // Sleep is a no-op so bounded backoff costs no wall-clock time in tests.
  return new ApifyClient({ transport, token: TOKEN, deadlineMs, sleep: () => Promise.resolve() });
}

const START = {
  actorPathId: 'clockworks~tiktok-scraper',
  input: { postURLs: ['https://www.tiktok.com/@a/video/1'] },
  maxTotalChargeUsd: 0.25,
  maxItems: 1,
  timeoutSecs: 120,
  waitForFinishSecs: 60,
};

describe('ApifyClient.startRun', () => {
  it('authenticates with a bearer header and never puts the token in the URL', async () => {
    const { transport, requests } = recordingTransport([json(201, runPayload())]);
    await client(transport).startRun(START);

    const request = requests[0];
    expect(request?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request?.url).not.toContain(TOKEN);
    expect(request?.url).not.toContain('token');
  });

  it('sends the safety ceilings as query parameters', async () => {
    const { transport, requests } = recordingTransport([json(201, runPayload())]);
    await client(transport).startRun(START);

    const url = new URL(requests[0]?.url ?? '');
    expect(url.pathname).toBe('/v2/acts/clockworks~tiktok-scraper/runs');
    expect(url.searchParams.get('maxTotalChargeUsd')).toBe('0.25');
    expect(url.searchParams.get('maxItems')).toBe('1');
    expect(url.searchParams.get('timeout')).toBe('120');
    expect(url.searchParams.get('waitForFinish')).toBe('60');
  });

  it('reads cost and bandwidth metadata off the run', async () => {
    const { transport } = recordingTransport([json(201, runPayload())]);
    const run = await client(transport).startRun(START);

    expect(run).toMatchObject({
      id: 'RUN1',
      status: 'SUCCEEDED',
      buildNumber: '0.1.42',
      usageTotalUsd: 0.012,
      netRxBytes: 4_000,
      netTxBytes: 500,
      runTimeSecs: 12,
    });
    expect(run.chargedEventCounts).toEqual({ 'video-result': 4 });
  });

  it('reports missing cost fields as null rather than zero', async () => {
    const { transport } = recordingTransport([
      json(201, { data: { id: 'RUN1', status: 'SUCCEEDED' } }),
    ]);
    const run = await client(transport).startRun(START);

    expect(run.usageTotalUsd).toBeNull();
    expect(run.chargedEventCounts).toBeNull();
    expect(run.netRxBytes).toBeNull();
    expect(run.buildNumber).toBeNull();
  });

  it('rejects a payload with no id or status', async () => {
    const { transport } = recordingTransport([json(201, { data: { status: 'SUCCEEDED' } })]);
    await expect(client(transport).startRun(START)).rejects.toThrow(/missing "id" or "status"/);
  });

  it('rejects a non-JSON body', async () => {
    const { transport } = recordingTransport([{ status: 201, headers: {}, body: '<html>' }]);
    await expect(client(transport).startRun(START)).rejects.toThrow(/not valid JSON/);
  });
});

describe('ApifyClient error handling', () => {
  it('fails fast on 401 without echoing the token', async () => {
    const { transport, requests } = recordingTransport([json(401, { error: 'unauthorized' })]);
    await expect(client(transport).startRun(START)).rejects.toThrow(/rejected the credentials/);
    // One attempt only: retrying a bad token never helps.
    expect(requests).toHaveLength(1);
  });

  it('does not retry a 402 billing refusal', async () => {
    const { transport, requests } = recordingTransport([json(402, { error: 'no credit' })]);
    await expect(client(transport).startRun(START)).rejects.toThrow(/billing reasons/);
    expect(requests).toHaveLength(1);
  });

  it('retries a 429 a bounded number of times, then gives up', async () => {
    const { transport, requests } = recordingTransport([json(429, { error: 'slow down' })]);
    await expect(client(transport).startRun(START)).rejects.toThrow(/HTTP 429/);
    expect(requests).toHaveLength(4); // the first attempt plus three retries
  });

  it('succeeds after a 429 that clears', async () => {
    const { transport, requests } = recordingTransport([
      json(429, { error: 'slow down' }, { 'retry-after': '1' }),
      json(201, runPayload()),
    ]);
    const run = await client(transport).startRun(START);
    expect(run.id).toBe('RUN1');
    expect(requests).toHaveLength(2);
  });

  it('retries a 5xx a bounded number of times', async () => {
    const { transport, requests } = recordingTransport([json(503, { error: 'unavailable' })]);
    await expect(client(transport).startRun(START)).rejects.toThrow(/HTTP 503/);
    expect(requests).toHaveLength(3); // the first attempt plus two retries
  });

  it('scrubs a token echoed back inside an error body', async () => {
    const { transport } = recordingTransport([
      { status: 400, headers: {}, body: `bad request for token ${TOKEN}` },
    ]);
    expect(await messageOf(client(transport).startRun(START))).not.toContain(TOKEN);
  });

  it('wraps a transport throw without leaking the token', async () => {
    const transport: ApifyTransport = {
      request: () => Promise.reject(new Error(`socket hang up while sending ${TOKEN}`)),
    };
    const message = await messageOf(client(transport).startRun(START));
    expect(message).not.toContain(TOKEN);
    expect(message).toContain('[redacted]');
  });
});

describe('ApifyClient.waitForRun', () => {
  it('returns immediately when the run already succeeded', async () => {
    const { transport, requests } = recordingTransport([json(201, runPayload())]);
    const started = await client(transport).startRun(START);
    const instance = client(transport);
    const finished = await instance.waitForRun(started);

    expect(finished.status).toBe('SUCCEEDED');
    // Only the original start call — no polling was needed.
    expect(requests).toHaveLength(1);
  });

  it('polls from RUNNING through to SUCCEEDED', async () => {
    const { transport, requests } = recordingTransport([
      json(201, runPayload({ status: 'READY' })),
      json(200, runPayload({ status: 'RUNNING' })),
      json(200, runPayload({ status: 'SUCCEEDED' })),
    ]);
    const instance = client(transport);
    const started = await instance.startRun(START);
    const finished = await instance.waitForRun(started);

    expect(finished.status).toBe('SUCCEEDED');
    expect(requests).toHaveLength(3);
    expect(requests[1]?.url).toContain('/v2/actor-runs/RUN1');
  });

  it.each(['FAILED', 'TIMING-OUT', 'TIMED-OUT', 'ABORTING', 'ABORTED'])(
    'treats %s as a terminal failure',
    async (status) => {
      const { transport } = recordingTransport([json(201, runPayload({ status }))]);
      const instance = client(transport);
      const started = await instance.startRun(START);
      await expect(instance.waitForRun(started)).rejects.toThrow(
        new RegExp(`ended with status ${status}`),
      );
    },
  );

  it('treats an unknown terminal status as a failure and says so', async () => {
    const { transport } = recordingTransport([json(201, runPayload({ status: 'EXPLODED' }))]);
    const instance = client(transport);
    const started = await instance.startRun(START);
    await expect(instance.waitForRun(started)).rejects.toThrow(/does not recognise/);
  });

  it('gives up on the local deadline instead of polling forever', async () => {
    const { transport } = recordingTransport([json(200, runPayload({ status: 'RUNNING' }))]);
    let clock = 0;
    const instance = new ApifyClient({
      transport,
      token: TOKEN,
      deadlineMs: 5_000,
      sleep: () => Promise.resolve(),
      // Every read of the clock advances it, so the deadline is reached quickly.
      now: () => {
        clock += 2_000;
        return clock;
      },
    });
    const started = await instance.getRun('RUN1');
    await expect(instance.waitForRun(started)).rejects.toThrow(/deadline expired/);
  });
});

describe('ApifyClient.getDatasetItems', () => {
  it('requests the raw, unclean dataset as JSON', async () => {
    const { transport, requests } = recordingTransport([json(200, [{ id: '1' }])]);
    const items = await client(transport).getDatasetItems('RUN1');

    const url = new URL(requests[0]?.url ?? '');
    expect(url.pathname).toBe('/v2/actor-runs/RUN1/dataset/items');
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.get('clean')).toBe('false');
    expect(items).toEqual([{ id: '1' }]);
  });

  it('rejects a dataset that is not a JSON array', async () => {
    const { transport } = recordingTransport([json(200, { items: [] })]);
    await expect(client(transport).getDatasetItems('RUN1')).rejects.toThrow(/not a JSON array/);
  });

  it('rejects an unparseable dataset', async () => {
    const { transport } = recordingTransport([{ status: 200, headers: {}, body: 'not json' }]);
    await expect(client(transport).getDatasetItems('RUN1')).rejects.toThrow(/not valid JSON/);
  });
});

describe('ApifyClient timeouts', () => {
  it('passes the remaining budget down as the per-request timeout', async () => {
    const request = vi.fn<ApifyTransport['request']>().mockResolvedValue(json(200, runPayload()));
    await client({ request }, 30_000).getRun('RUN1');

    expect(request.mock.calls[0]?.[0].timeoutMs).toBeGreaterThan(0);
    expect(request.mock.calls[0]?.[0].timeoutMs).toBeLessThanOrEqual(30_000);
  });
});
