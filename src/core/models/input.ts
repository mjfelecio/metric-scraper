import { z } from 'zod';

import { PlatformSchema } from './platform.js';
import { type ScrapeErrorInfo } from './errors.js';
import { type FailureStatus } from './status.js';

export const INPUT_FORMATS = ['text', 'json'] as const;
export const InputFormatSchema = z.enum(INPUT_FORMATS);
export type InputFormat = z.infer<typeof InputFormatSchema>;

/** One accepted, normalized URL ready to be scheduled. */
export const InputRecordSchema = z.object({
  /** Exactly what the user supplied, kept for error reporting and traceability. */
  raw_url: z.string(),
  /** Result of generic + platform normalization. This is what gets requested. */
  url: z.string(),
  platform: PlatformSchema,
  /** True when a network redirect must be resolved before scraping. */
  requires_resolution: z.boolean().optional(),
  /** 1-based line number for text input, or array index for JSON input. */
  position: z.number().int().positive(),
});

export type InputRecord = z.infer<typeof InputRecordSchema>;

export interface InputResolutionStats {
  attempts: number;
  retries: number;
  proxyId: string | null;
  platformHttpRequests: number;
  latencyMs: number;
}

export interface PreparedInputRecord {
  kind: 'ready';
  record: InputRecord;
  resolution: InputResolutionStats | null;
}

export interface PreparedInputFailure {
  kind: 'failure';
  record: InputRecord;
  status: FailureStatus;
  error: ScrapeErrorInfo;
  resolution: InputResolutionStats;
}

export type PreparedInputItem = PreparedInputRecord | PreparedInputFailure;

export interface PreparedInput {
  items: PreparedInputItem[];
  issues: InputIssue[];
}

export const INPUT_ISSUE_CODES = [
  'malformed_json',
  'unexpected_json_shape',
  'not_a_string',
  'invalid_url',
  'unsupported_platform',
  'platform_mismatch',
  'duplicate_url',
  'empty_input',
] as const;

export const InputIssueCodeSchema = z.enum(INPUT_ISSUE_CODES);
export type InputIssueCode = z.infer<typeof InputIssueCodeSchema>;

/**
 * Something that was wrong with the input. Issues are returned alongside the
 * accepted records rather than thrown, so a caller can decide whether a bad
 * line is fatal — but they are never swallowed.
 */
export const InputIssueSchema = z.object({
  code: InputIssueCodeSchema,
  message: z.string(),
  /** 1-based line number / array index, when the issue can be located. */
  position: z.number().int().positive().nullable(),
  /** The offending value, truncated for display. */
  value: z.string().nullable(),
});

export type InputIssue = z.infer<typeof InputIssueSchema>;

export interface ParsedInput {
  format: InputFormat;
  records: InputRecord[];
  issues: InputIssue[];
  /** Count of lines/entries seen before validation and de-duplication. */
  totalCandidates: number;
}

/** Issues that mean the whole input is unusable, as opposed to one bad entry. */
export function isFatalInputIssue(issue: InputIssue): boolean {
  return issue.code === 'malformed_json' || issue.code === 'unexpected_json_shape';
}
