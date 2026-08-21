import { type InputRecord } from '../../core/models/input.js';
import { type Platform } from '../../core/models/platform.js';

/**
 * Generates canonical-shaped synthetic TikTok/Instagram URLs so the load
 * generator can drive the real `UrlNormalizerRegistry`/platform scrapers
 * without ever needing a real post.
 *
 * IDs are purely numeric strings by construction (not just "look numeric") --
 * the Instagram mock upstream's author-id encoding
 * (`src/stress/upstream/instagram-mock-upstream.ts`) relies on shortcodes
 * being digit-only to stay losslessly invertible without any shared state.
 */

const TIKTOK_HANDLE = 'stressuser';

/** 16 digits: `7` (matches real TikTok's id-length shape) + a zero-padded index. */
export function tiktokSyntheticVideoId(index: number): string {
  return `7${String(index).padStart(15, '0')}`;
}

export function tiktokSyntheticUrl(index: number): string {
  return `https://www.tiktok.com/@${TIKTOK_HANDLE}/video/${tiktokSyntheticVideoId(index)}`;
}

/** 12 digits, purely numeric so it round-trips through the author-id encoding. */
export function instagramSyntheticShortcode(index: number): string {
  return `9${String(index).padStart(11, '0')}`;
}

export function instagramSyntheticUrl(index: number): string {
  return `https://www.instagram.com/reel/${instagramSyntheticShortcode(index)}/`;
}

export type PlatformDistribution = 'tiktok' | 'instagram' | 'mixed';

export interface SyntheticInputOptions {
  platform: PlatformDistribution;
  count: number;
  /**
   * First synthetic index to use. Callers driving multiple phases pass an
   * increasing offset so ids never collide across phases within one run.
   */
  startIndex?: number;
  /** For `mixed`: fraction routed to TikTok, `0..1`. Default 0.5. */
  tiktokRatio?: number;
}

/** Produces `count` freshly-indexed, canonical-shaped `InputRecord`s. */
export function generateSyntheticInput(options: SyntheticInputOptions): InputRecord[] {
  const start = options.startIndex ?? 0;
  const tiktokRatio = options.tiktokRatio ?? 0.5;
  const records: InputRecord[] = [];

  for (let offset = 0; offset < options.count; offset += 1) {
    const index = start + offset;
    const platform: Platform =
      options.platform === 'mixed'
        ? hashRatio(index) < tiktokRatio
          ? 'tiktok'
          : 'instagram'
        : options.platform;
    const url = platform === 'tiktok' ? tiktokSyntheticUrl(index) : instagramSyntheticUrl(index);
    records.push({ raw_url: url, url, platform, position: offset + 1 });
  }

  return records;
}

/** Repeats a fixed batch `times` times, renumbering `position` to stay 1-based and contiguous. */
export function repeatRecords(records: readonly InputRecord[], times: number): InputRecord[] {
  const out: InputRecord[] = [];
  for (let pass = 0; pass < times; pass += 1) {
    for (const record of records) {
      out.push({ ...record, position: out.length + 1 });
    }
  }
  return out;
}

/** Cheap deterministic split, independent of the workload/scenario hash so platform mix never correlates with scenario mix. */
function hashRatio(index: number): number {
  let hash = 0x9e3779b9 ^ index;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0x100000000;
}
