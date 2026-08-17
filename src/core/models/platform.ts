import { z } from 'zod';

/**
 * The platforms this scraper targets. Adding a platform means adding a value
 * here, a `Scraper` implementation under `src/platforms/`, and a `UrlNormalizer`.
 */
export const PLATFORMS = ['tiktok', 'instagram'] as const;

export const PlatformSchema = z.enum(PLATFORMS);

export type Platform = z.infer<typeof PlatformSchema>;

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value);
}
