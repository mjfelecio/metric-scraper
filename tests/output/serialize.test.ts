import { describe, expect, it } from 'vitest';

import {
  createFailureSnapshot,
  createSuccessSnapshot,
  EMPTY_VIDEO_DATA,
  SNAPSHOT_FIELD_ORDER,
  type SnapshotContext,
} from '../../src/core/models/snapshot.js';
import {
  assertValidSnapshot,
  parseSnapshotLine,
  serializeSnapshotLine,
} from '../../src/core/output/serialize.js';

const context: SnapshotContext = {
  platform: 'instagram',
  url: 'https://www.instagram.com/reel/ABC/',
  scrapedAt: new Date('2026-08-17T10:00:00.000Z'),
  latencyMs: 42,
};

describe('serializeSnapshotLine', () => {
  it('emits a single line of JSON', () => {
    const line = serializeSnapshotLine(createSuccessSnapshot(context, EMPTY_VIDEO_DATA));
    expect(line.includes('\n')).toBe(false);
    expect(() => {
      JSON.parse(line);
    }).not.toThrow();
  });

  it('emits keys in the canonical column order', () => {
    const line = serializeSnapshotLine(createSuccessSnapshot(context, EMPTY_VIDEO_DATA));
    expect(Object.keys(JSON.parse(line) as object)).toEqual([...SNAPSHOT_FIELD_ORDER]);
  });

  it('escapes newlines inside values so one row can never become two', () => {
    const snapshot = createFailureSnapshot(context, 'error', {
      code: 'parse_error',
      message: 'unexpected\nnewline\nin message',
      retryable: false,
    });

    const line = serializeSnapshotLine(snapshot);
    expect(line.split('\n')).toHaveLength(1);
    expect(parseSnapshotLine(line).error).toContain('\n');
  });

  it('preserves non-ASCII content', () => {
    const snapshot = createSuccessSnapshot(context, {
      ...EMPTY_VIDEO_DATA,
      author_handle: 'ünïcode_人物_🎬',
    });
    expect(parseSnapshotLine(serializeSnapshotLine(snapshot)).author_handle).toBe('ünïcode_人物_🎬');
  });

  it('round-trips a snapshot', () => {
    const snapshot = createSuccessSnapshot(context, {
      ...EMPTY_VIDEO_DATA,
      video_id: 'abc',
      views: 10,
      likes: 1,
    });
    expect(parseSnapshotLine(serializeSnapshotLine(snapshot))).toEqual(snapshot);
  });

  it('keeps null distinct from zero', () => {
    const snapshot = createSuccessSnapshot(context, { ...EMPTY_VIDEO_DATA, views: 0 });
    const parsed = parseSnapshotLine(serializeSnapshotLine(snapshot));
    expect(parsed.views).toBe(0);
    expect(parsed.likes).toBeNull();
  });
});

describe('parseSnapshotLine', () => {
  it('rejects a line that is not JSON', () => {
    expect(() => parseSnapshotLine('{not json')).toThrow(/not valid JSON/);
  });

  it('rejects a JSON object that is not a snapshot', () => {
    expect(() => parseSnapshotLine('{"hello":"world"}')).toThrow();
  });
});

describe('assertValidSnapshot', () => {
  it('refuses to write an invalid row', () => {
    const broken = { ...createSuccessSnapshot(context, EMPTY_VIDEO_DATA), likes: -5 };
    expect(() => assertValidSnapshot(broken)).toThrow(/invalid snapshot/);
  });
});
