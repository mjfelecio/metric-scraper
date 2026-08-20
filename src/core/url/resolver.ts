import { type ScrapeErrorInfo } from '../models/errors.js';
import { type Platform } from '../models/platform.js';
import { type FailureStatus } from '../models/status.js';
import { type HttpClient } from '../scraper/http-port.js';
import { type ProxyTarget } from '../scraper/lease-ports.js';
import { type Logger } from '../logging/logger.js';

export interface UrlResolutionContext {
  http: HttpClient;
  proxy: ProxyTarget | null;
  signal: AbortSignal;
  logger: Logger;
}

export type UrlResolutionResult =
  | { outcome: 'ok'; url: string; videoId: string }
  | { outcome: 'failure'; status: FailureStatus; error: ScrapeErrorInfo };

export interface UrlResolver {
  readonly platform: Platform;
  resolve(url: string, context: UrlResolutionContext): Promise<UrlResolutionResult>;
}

export interface UrlResolverRegistry {
  get(platform: Platform): UrlResolver | undefined;
}

export function createUrlResolverRegistry(resolvers: readonly UrlResolver[]): UrlResolverRegistry {
  const byPlatform = new Map(resolvers.map((resolver) => [resolver.platform, resolver]));
  return { get: (platform) => byPlatform.get(platform) };
}
