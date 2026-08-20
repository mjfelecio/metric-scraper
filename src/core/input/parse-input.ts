import {
  type InputFormat,
  type InputIssue,
  type InputIssueCode,
  type InputRecord,
  type ParsedInput,
} from '../models/input.js';
import { type Platform } from '../models/platform.js';
import { truncate } from '../url/generic.js';
import { type UrlNormalizerRegistry } from '../url/normalizer-registry.js';

export interface ParseInputOptions {
  registry: UrlNormalizerRegistry;
  /** `'auto'` sniffs JSON by a leading `[`. */
  format?: InputFormat | 'auto' | undefined;
  /** Reject URLs belonging to another platform (used by `scraper tiktok …`). */
  expectedPlatform?: Platform | null | undefined;
  /** Drop repeated URLs after normalization, reporting each as an issue. */
  dedupe?: boolean | undefined;
}

interface Candidate {
  value: string;
  position: number;
}

/**
 * Turns raw input text into normalized, de-duplicated records.
 *
 * This module is pure (no fs, no Node builtins) so the browser dashboard can
 * validate pasted input with exactly the same rules the CLI applies.
 *
 * Nothing invalid is silently dropped: every rejected entry produces an
 * `InputIssue` carrying its position and the offending value.
 */
export function parseInput(text: string, options: ParseInputOptions): ParsedInput {
  const format = resolveFormat(text, options.format ?? 'auto');
  const issues: InputIssue[] = [];

  const extraction = format === 'json' ? extractJsonCandidates(text) : extractTextCandidates(text);
  issues.push(...extraction.issues);

  const records: InputRecord[] = [];
  const seen = new Map<string, number>();
  const dedupe = options.dedupe ?? true;

  for (const candidate of extraction.candidates) {
    const result = options.registry.normalize(candidate.value);

    if (!result.ok) {
      issues.push(issue(result.code, result.message, candidate));
      continue;
    }

    if (options.expectedPlatform != null && result.platform !== options.expectedPlatform) {
      issues.push(
        issue(
          'platform_mismatch',
          `expected a ${options.expectedPlatform} URL but this one resolves to ${result.platform}`,
          candidate,
        ),
      );
      continue;
    }

    const firstSeenAt = seen.get(result.url);
    if (dedupe && firstSeenAt !== undefined) {
      issues.push(
        issue('duplicate_url', `duplicate of the entry at position ${firstSeenAt}`, candidate),
      );
      continue;
    }
    seen.set(result.url, candidate.position);

    records.push({
      raw_url: candidate.value,
      url: result.url,
      platform: result.platform,
      requires_resolution: result.requiresResolution,
      position: candidate.position,
    });
  }

  if (extraction.candidates.length === 0 && issues.length === 0) {
    issues.push({
      code: 'empty_input',
      message: 'input contained no URLs',
      position: null,
      value: null,
    });
  }

  return { format, records, issues, totalCandidates: extraction.candidates.length };
}

function resolveFormat(text: string, requested: InputFormat | 'auto'): InputFormat {
  if (requested !== 'auto') return requested;
  return text.trimStart().startsWith('[') ? 'json' : 'text';
}

function issue(code: InputIssueCode, message: string, candidate: Candidate): InputIssue {
  return {
    code,
    message,
    position: candidate.position,
    value: truncate(candidate.value),
  };
}

interface Extraction {
  candidates: Candidate[];
  issues: InputIssue[];
}

/**
 * Newline-delimited input. Blank lines and `#` comments are skipped by design
 * (they are not "invalid input"); anything else is passed on for validation.
 */
function extractTextCandidates(text: string): Extraction {
  const candidates: Candidate[] = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) return;
    candidates.push({ value: trimmed, position: index + 1 });
  });

  return { candidates, issues: [] };
}

/** A JSON array of URL strings. */
function extractJsonCandidates(text: string): Extraction {
  const issues: InputIssue[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    issues.push({
      code: 'malformed_json',
      message: `input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      position: null,
      value: null,
    });
    return { candidates: [], issues };
  }

  if (!Array.isArray(parsed)) {
    issues.push({
      code: 'unexpected_json_shape',
      message: `expected a JSON array of URL strings, received ${describeJsonType(parsed)}`,
      position: null,
      value: null,
    });
    return { candidates: [], issues };
  }

  const candidates: Candidate[] = [];
  parsed.forEach((entry, index) => {
    const position = index + 1;
    if (typeof entry !== 'string') {
      issues.push({
        code: 'not_a_string',
        message: `array entry ${position} is ${describeJsonType(entry)}, expected a URL string`,
        position,
        value: truncate(JSON.stringify(entry) ?? String(entry)),
      });
      return;
    }
    if (entry.trim().length === 0) {
      issues.push({
        code: 'invalid_url',
        message: `array entry ${position} is an empty string`,
        position,
        value: '',
      });
      return;
    }
    candidates.push({ value: entry.trim(), position });
  });

  return { candidates, issues };
}

function describeJsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const type = typeof value;
  return type === 'object' ? 'an object' : `a ${type}`;
}
