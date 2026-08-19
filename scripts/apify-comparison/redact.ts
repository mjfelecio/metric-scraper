/**
 * Recursive secret scrubbing for everything this benchmark prints or writes.
 *
 * Two independent defences, because either one alone has a hole:
 *
 *  - key-based, which catches `{ token: "apify_api_…" }` even when the value
 *    is a shape we did not anticipate;
 *  - value-based, which catches the token after it has been interpolated into
 *    someone else's message, e.g. an Actor error string echoing a URL.
 *
 * The value pass is what makes it safe to serialize an arbitrary Apify
 * response: the API is free to include whatever it likes in an error body.
 */
export const REDACTED = '[redacted]';

const SECRET_KEY_PATTERN = /(token|secret|password|passwd|apikey|api_key|authorization|cookie)/i;

/** Apify's own token prefix, recognizable even when it appears mid-sentence. */
const TOKEN_LIKE_PATTERN = /\bapify_(?:api|token)_[A-Za-z0-9]{8,}\b/g;

export interface RedactOptions {
  /**
   * Literal secrets to blank wherever they appear. Values shorter than 8
   * characters are ignored: redacting a 3-character string would corrupt
   * unrelated text far more often than it would protect anything.
   */
  readonly secrets?: readonly string[] | undefined;
}

/**
 * Returns a structurally-cloned copy with secrets removed.
 *
 * Never mutates its input, so a caller can keep using the live object — the
 * redacted copy is only ever for output.
 */
export function redactDeep(value: unknown, options: RedactOptions = {}): unknown {
  const secrets = (options.secrets ?? []).filter((secret) => secret.length >= 8);
  return redactValue(value, secrets, new WeakSet<object>());
}

function redactValue(value: unknown, secrets: readonly string[], seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value, secrets);
  if (value === null || typeof value !== 'object') return value;

  // A response body parsed from JSON cannot be cyclic, but a config object
  // assembled in-process can be, and losing the artifact to a stack overflow
  // would be a silly way to end a paid run.
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, secrets, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactValue(entry, secrets, seen);
  }
  return result;
}

export function redactString(value: string, secrets: readonly string[] = []): string {
  let result = value;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    result = result.split(secret).join(REDACTED);
  }
  return result.replace(TOKEN_LIKE_PATTERN, REDACTED);
}
