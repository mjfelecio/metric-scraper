import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type ProxyEvent } from '../../src/core/scraper/pool-ports.js';
import { ProxyEventLog } from '../../src/infrastructure/output/proxy-event-log.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'metric-scraper-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function event(overrides: Partial<ProxyEvent> = {}): ProxyEvent {
  return {
    at: Date.parse('2026-08-18T19:21:00.000Z'),
    proxyId: 'http://gate-a.example.net:8000',
    label: 'p1',
    from: 'healthy',
    to: 'cooling',
    blockKind: 'consecutive_failures',
    reason: 'timeout',
    errorCode: 'timeout',
    consecutiveFailures: 3,
    eligibleAt: Date.parse('2026-08-18T19:26:00.000Z'),
    ...overrides,
  };
}

async function readRows(file: string): Promise<Record<string, unknown>[]> {
  const contents = await readFile(file, 'utf8');
  return contents
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('ProxyEventLog', () => {
  it('writes one row per transition, with times as ISO strings', async () => {
    const file = path.join(dir, 'run.proxy-events.jsonl');
    const log = new ProxyEventLog({ filePath: file, context: { run_id: 'run-1' } });

    log.record(event());
    log.record(event({ from: 'cooling', to: 'probation', at: Date.parse('2026-08-18T19:26:00.000Z') }));
    await log.close();

    const rows = await readRows(file);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      at: '2026-08-18T19:21:00.000Z',
      run_id: 'run-1',
      label: 'p1',
      from: 'healthy',
      to: 'cooling',
      block_kind: 'consecutive_failures',
      error_code: 'timeout',
      eligible_at: '2026-08-18T19:26:00.000Z',
    });
    expect(rows[1]).toMatchObject({ from: 'cooling', to: 'probation' });
  });

  it('appends rather than truncating, so a session keeps one record', async () => {
    const file = path.join(dir, 'session.proxy-events.jsonl');

    const first = new ProxyEventLog({ filePath: file });
    first.record(event());
    await first.close();

    const second = new ProxyEventLog({ filePath: file });
    second.record(event({ to: 'retired' }));
    await second.close();

    expect(await readRows(file)).toHaveLength(2);
  });

  it('stands down instead of throwing when the file cannot be written', async () => {
    // A path whose parent is a file, so opening it can only fail.
    const blocker = path.join(dir, 'not-a-dir');
    const first = new ProxyEventLog({ filePath: blocker });
    first.record(event());
    await first.close();

    const log = new ProxyEventLog({ filePath: path.join(blocker, 'events.jsonl') });

    // Observability must never be able to end a run that is otherwise fine.
    expect(() => log.record(event())).not.toThrow();
    expect(log.rowsWritten).toBe(0);
    await expect(log.close()).resolves.toBeUndefined();
  });
});
