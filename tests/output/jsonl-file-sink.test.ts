import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createSuccessSnapshot,
  EMPTY_VIDEO_DATA,
  type MetricSnapshot,
  type SnapshotContext,
} from '../../src/core/models/snapshot.js';
import { JsonlFileSink } from '../../src/infrastructure/output/jsonl-file-sink.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'metric-scraper-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function snapshot(overrides: Partial<SnapshotContext> = {}): MetricSnapshot {
  const context: SnapshotContext = {
    platform: 'tiktok',
    url: 'https://www.tiktok.com/@a/video/1',
    scrapedAt: new Date('2026-08-17T10:00:00.000Z'),
    latencyMs: 10,
    ...overrides,
  };
  return createSuccessSnapshot(context, { ...EMPTY_VIDEO_DATA, video_id: 'same-id', views: 1 });
}

async function readLines(file: string): Promise<string[]> {
  const contents = await readFile(file, 'utf8');
  return contents.split('\n').filter((line) => line.length > 0);
}

describe('JsonlFileSink', () => {
  it('writes one JSON object per line', async () => {
    const file = path.join(dir, 'run.jsonl');
    const sink = new JsonlFileSink({ filePath: file });

    await sink.write(snapshot());
    await sink.write(snapshot());
    await sink.close();

    const lines = await readLines(file);
    expect(lines).toHaveLength(2);
    expect(sink.rowsWritten).toBe(2);
    for (const line of lines) {
      expect(() => {
        JSON.parse(line);
      }).not.toThrow();
    }
  });

  it('creates missing parent directories', async () => {
    const file = path.join(dir, 'nested', 'deeper', 'run.jsonl');
    const sink = new JsonlFileSink({ filePath: file });
    await sink.write(snapshot());
    await sink.close();

    expect(await readLines(file)).toHaveLength(1);
  });

  it('appends instead of overwriting on a second run', async () => {
    const file = path.join(dir, 'run.jsonl');

    const first = new JsonlFileSink({ filePath: file });
    await first.write(snapshot());
    await first.close();

    const second = new JsonlFileSink({ filePath: file });
    await second.write(snapshot());
    await second.close();

    expect(await readLines(file)).toHaveLength(2);
  });

  it('keeps every repeated scrape of the same video as its own row', async () => {
    const file = path.join(dir, 'run.jsonl');
    const sink = new JsonlFileSink({ filePath: file });

    await sink.write(snapshot({ scrapedAt: new Date('2026-08-17T10:00:00.000Z') }));
    await sink.write(snapshot({ scrapedAt: new Date('2026-08-17T11:00:00.000Z') }));
    await sink.close();

    const rows = (await readLines(file)).map((line) => JSON.parse(line) as MetricSnapshot);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.video_id).toBe(rows[1]?.video_id);
    expect(rows[0]?.scraped_at).not.toBe(rows[1]?.scraped_at);
  });

  it('writes UTF-8 without mangling multi-byte characters', async () => {
    const file = path.join(dir, 'run.jsonl');
    const sink = new JsonlFileSink({ filePath: file });

    const row = createSuccessSnapshot(
      {
        platform: 'instagram',
        url: 'https://www.instagram.com/reel/A/',
        scrapedAt: new Date('2026-08-17T10:00:00.000Z'),
        latencyMs: 5,
      },
      { ...EMPTY_VIDEO_DATA, author_handle: '日本語_🎥' },
    );
    await sink.write(row);
    await sink.close();

    const parsed = JSON.parse((await readLines(file))[0] ?? '{}') as MetricSnapshot;
    expect(parsed.author_handle).toBe('日本語_🎥');
  });

  it('reports a clear error when the row is invalid', async () => {
    const sink = new JsonlFileSink({ filePath: path.join(dir, 'run.jsonl') });
    const broken = { ...snapshot(), likes: -1 };

    await expect(sink.write(broken)).rejects.toThrow(/invalid snapshot/);
    await sink.close();
  });

  it('reports a clear error when the output path cannot be opened', async () => {
    // A path whose parent is an existing file cannot become a directory.
    const blocker = path.join(dir, 'blocker.jsonl');
    const blockingSink = new JsonlFileSink({ filePath: blocker });
    await blockingSink.write(snapshot());
    await blockingSink.close();

    const sink = new JsonlFileSink({ filePath: path.join(blocker, 'nested.jsonl') });
    await expect(sink.write(snapshot())).rejects.toThrow(/cannot create output directory|cannot open/);
  });

  it('refuses writes after close', async () => {
    const sink = new JsonlFileSink({ filePath: path.join(dir, 'run.jsonl') });
    await sink.write(snapshot());
    await sink.close();
    await expect(sink.write(snapshot())).rejects.toThrow(/already closed/);
  });
});

describe('JsonlFileSink under concurrency', () => {
  // Regression guard. `open()` used to check `this.stream !== null` and only
  // assign it after awaiting `mkdir` and the stream's `open` event. With a
  // genuinely concurrent runner, every simultaneous first write saw `null` and
  // created its own append stream; all but the last were orphaned file
  // descriptors that were never closed. It could not fail while the runner was
  // accidentally serialized, which is exactly why it went unnoticed.
  it('opens exactly once when many writes race the first open', async () => {
    const file = path.join(dir, 'concurrent.jsonl');
    const sink = new JsonlFileSink({ filePath: file });

    await Promise.all(Array.from({ length: 50 }, () => sink.write(snapshot())));
    await sink.close();

    expect(await readLines(file)).toHaveLength(50);
    expect(sink.rowsWritten).toBe(50);
  });

  it('writes every row when concurrent writers hit stream backpressure', async () => {
    const file = path.join(dir, 'backpressure.jsonl');
    const sink = new JsonlFileSink({ filePath: file });

    await Promise.all(Array.from({ length: 500 }, () => sink.write(snapshot())));
    await sink.close();

    expect(await readLines(file)).toHaveLength(500);
  });
});
