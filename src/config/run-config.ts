import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { ScrapeError } from '../core/models/errors.js';
import { InputFormatSchema } from '../core/models/input.js';
import { PlatformSchema } from '../core/models/platform.js';

/**
 * Declarative run description for `scraper run <file>`.
 *
 * Anything omitted falls back to the environment configuration, so a run file
 * only has to state what makes this run different.
 */
export const RunConfigSchema = z
  .object({
    /** Restrict the batch to one platform; URLs from another are rejected. */
    platform: PlatformSchema.nullish(),
    /** Path to a `.txt`/`.json` batch file, relative to the config file. */
    input: z.string().min(1).nullish(),
    /** Inline URLs, as an alternative to `input`. */
    urls: z.array(z.string()).nullish(),
    format: InputFormatSchema.or(z.literal('auto')).nullish(),
    concurrency: z.number().int().min(1).max(1_000).nullish(),
    targetRpm: z.number().int().min(0).nullish(),
    /** Jobs admissible at once after idle; `0` = one second of `targetRpm`. */
    burst: z.number().int().min(0).nullish(),
    /** Ceiling on actual HTTP requests per minute per host, retries included. */
    httpRpmPerHost: z.number().int().min(0).nullish(),
    /** Repeat the batch continuously instead of running it once. */
    watch: z.boolean().nullish(),
    /** Time between cycle starts, e.g. `"15m"`, `"30s"`, or `0` for back-to-back. */
    interval: z.union([z.string(), z.number().int().min(0)]).nullish(),
    /** Stop starting new cycles after this much wall clock, e.g. `"10m"`. */
    duration: z.union([z.string(), z.number().int().min(0)]).nullish(),
    maxCycles: z.number().int().min(1).nullish(),
    outputDir: z.string().min(1).nullish(),
    /** Append to a specific JSONL file instead of a per-run file. */
    outputFile: z.string().min(1).nullish(),
    /** Abort instead of continuing when the input contains rejected entries. */
    strict: z.boolean().nullish(),
    retry: z
      .object({
        maxAttempts: z.number().int().min(1).max(20).nullish(),
        initialDelayMs: z.number().int().min(0).nullish(),
        maxDelayMs: z.number().int().min(0).nullish(),
        backoffFactor: z.number().min(1).nullish(),
        jitter: z.boolean().nullish(),
      })
      .nullish(),
  })
  .refine(
    (value) =>
      (value.input != null && value.input.length > 0) ||
      (value.urls != null && value.urls.length > 0),
    { message: 'a run config must provide either "input" (a file path) or "urls" (an array)' },
  );

export type RunConfig = z.infer<typeof RunConfigSchema>;

export interface LoadedRunConfig {
  config: RunConfig;
  /** Directory of the config file; relative paths resolve against it. */
  baseDir: string;
  sourcePath: string;
}

export async function loadRunConfig(filePath: string): Promise<LoadedRunConfig> {
  const resolved = path.resolve(filePath);

  let contents: string;
  try {
    contents = await readFile(resolved, 'utf8');
  } catch (error) {
    throw new ScrapeError({
      code: 'config_error',
      message: `cannot read run config "${resolved}": ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (error) {
    throw new ScrapeError({
      code: 'config_error',
      message: `run config "${resolved}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    });
  }

  const parsed = RunConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new ScrapeError({
      code: 'config_error',
      message: `invalid run config "${resolved}" — ${detail}`,
    });
  }

  return { config: parsed.data, baseDir: path.dirname(resolved), sourcePath: resolved };
}
