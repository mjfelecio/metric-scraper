import { ScrapeError } from '../../src/core/models/errors.js';
import { type InputIssue, type ParsedInput } from '../../src/core/models/input.js';
import { loadInputFile } from '../../src/infrastructure/input/file-input-loader.js';
import { createDefaultUrlNormalizerRegistry } from '../../src/platforms/index.js';
import { parseCanonicalTikTokUrl } from '../../src/platforms/tiktok/tiktok-url-normalizer.js';

import { type BenchmarkTarget } from './types.js';

export interface LoadedTargets {
  readonly targets: readonly BenchmarkTarget[];
  /** Every issue the production parser raised, verbatim, for the manifest. */
  readonly issues: readonly InputIssue[];
  /**
   * Issues that are genuine rejections.
   *
   * Deliberately excludes `duplicate_url`: the parser reports a repeated URL as
   * an issue, but for this benchmark a duplicate is a URL that will not be
   * billed twice, not an input that was thrown away. Counting the two together
   * makes a clean input file look like it had errors in it.
   */
  readonly rejected: readonly InputIssue[];
  readonly totalCandidates: number;
  /** Raw entries that collapsed onto a target already seen. Never billed twice. */
  readonly duplicatesCollapsed: number;
}

export interface LoadTargetsOptions {
  readonly maxUrls: number;
  /** Injected in tests so no file has to exist. */
  readonly loader?: typeof loadInputFile | undefined;
}

/**
 * Reads a batch file into the unique posts the benchmark will pay for.
 *
 * Uses the production loader, parser and TikTok normalizer rather than a
 * parallel implementation — the benchmark must ask Apify about exactly the
 * URLs our own pipeline would have scraped, or the comparison measures the
 * normalizers instead of the sources.
 *
 * Deduplication happens twice on purpose. `parseInput` collapses identical
 * normalized URLs; this then collapses by video id, which additionally catches
 * the same post reached through different paths. Every collapse is one fewer
 * billable unit.
 */
export async function loadTargets(
  inputPath: string,
  options: LoadTargetsOptions,
): Promise<LoadedTargets> {
  const load = options.loader ?? loadInputFile;
  const parsed: ParsedInput = await load(inputPath, {
    registry: createDefaultUrlNormalizerRegistry(),
    format: 'auto',
    // Anything that is not a TikTok post is rejected here rather than being
    // sent to a TikTok-only Actor and paid for.
    expectedPlatform: 'tiktok',
  });

  const duplicateIssues = parsed.issues.filter((issue) => issue.code === 'duplicate_url');
  const rejected = parsed.issues.filter((issue) => issue.code !== 'duplicate_url');

  const byVideoId = new Map<string, { target: BenchmarkTarget; rawUrls: string[] }>();
  // Starts at the count the parser already collapsed by normalized URL; the
  // loop below adds the ones only a video-id comparison can catch.
  let duplicatesCollapsed = duplicateIssues.length;

  for (const record of parsed.records) {
    const canonical = parseCanonicalTikTokUrl(record.url);
    if (canonical === null) {
      // A short link normalizes but carries no id yet; resolving it would mean
      // a network call before the dry run, which dry run promises not to make.
      throw new ScrapeError({
        code: 'invalid_url',
        message:
          `"${record.raw_url}" has no resolvable TikTok video id. ` +
          'Short links (vm./vt.tiktok.com) must be expanded before benchmarking, ' +
          'so that dry run stays entirely offline.',
      });
    }

    const existing = byVideoId.get(canonical.videoId);
    if (existing !== undefined) {
      existing.rawUrls.push(record.raw_url);
      duplicatesCollapsed += 1;
      continue;
    }

    byVideoId.set(canonical.videoId, {
      rawUrls: [record.raw_url],
      target: {
        videoId: canonical.videoId,
        url: record.url,
        rawUrls: [],
        kind: canonical.kind,
        handle: canonical.handle,
      },
    });
  }

  const targets = [...byVideoId.values()].map((entry): BenchmarkTarget => ({
    ...entry.target,
    rawUrls: entry.rawUrls,
  }));

  if (targets.length === 0) {
    throw new ScrapeError({
      code: 'config_error',
      message: `no usable TikTok post URLs in "${inputPath}"`,
    });
  }

  // Refuse rather than truncate. Silently benchmarking the first five of a
  // twenty-URL file would produce a report that answers a question nobody asked.
  if (targets.length > options.maxUrls) {
    throw new ScrapeError({
      code: 'config_error',
      message:
        `"${inputPath}" yields ${targets.length} unique billable posts, ` +
        `over the configured limit of ${options.maxUrls}. ` +
        'Raise --max-urls deliberately, or trim the input.',
    });
  }

  return {
    targets,
    issues: parsed.issues,
    rejected,
    totalCandidates: parsed.totalCandidates,
    duplicatesCollapsed,
  };
}
