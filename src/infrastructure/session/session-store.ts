import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { ScrapeError } from '../../core/models/errors.js';
import { PlatformSchema } from '../../core/models/platform.js';
import { type PlatformSession } from '../../core/scraper/lease-ports.js';

/**
 * Shape of the operator-supplied session file.
 *
 * Nothing in this repository creates sessions or cookies — this only reads a
 * file an operator provides out of band. The path comes from
 * `SESSION_STORE_PATH` and the file itself is gitignored.
 *
 * ```json
 * {
 *   "sessions": [
 *     {
 *       "id": "tiktok-1",
 *       "platform": "tiktok",
 *       "cookie": "<raw Cookie header value>",
 *       "userAgent": "<optional>",
 *       "headers": { "accept-language": "en-US,en;q=0.9" }
 *     }
 *   ]
 * }
 * ```
 */
export const SessionFileSchema = z.object({
  sessions: z.array(
    z.object({
      id: z.string().min(1),
      platform: PlatformSchema,
      cookie: z.string().min(1),
      userAgent: z.string().min(1).nullable().default(null),
      headers: z.record(z.string(), z.string()).default({}),
    }),
  ),
});

export type SessionFile = z.infer<typeof SessionFileSchema>;

export async function loadSessionsFromFile(path: string): Promise<PlatformSession[]> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    throw new ScrapeError({
      code: 'config_error',
      message: `could not read SESSION_STORE_PATH "${path}": ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (error) {
    throw new ScrapeError({
      code: 'config_error',
      message: `session store "${path}" is not valid JSON`,
      cause: error,
    });
  }

  const parsed = SessionFileSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new ScrapeError({
      code: 'config_error',
      message: `session store "${path}" has an unexpected shape (${detail})`,
    });
  }

  return parsed.data.sessions.map((session) => ({
    id: session.id,
    platform: session.platform,
    cookie: session.cookie,
    userAgent: session.userAgent,
    headers: session.headers,
  }));
}
