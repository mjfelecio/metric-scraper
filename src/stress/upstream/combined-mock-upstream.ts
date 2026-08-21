import { type MockAgent } from 'undici';

import { type WorkloadProfile } from '../workload/workload-profile.js';

import {
  computeInstagramRequestLatencyMs,
  registerInstagramMockUpstream,
  type InstagramMockUpstreamOptions,
} from './instagram-mock-upstream.js';
import { type RequestTimingLookupInput } from './proxy-mock-dispatcher.js';
import {
  computeTikTokRequestLatencyMs,
  registerTikTokMockUpstream,
} from './tiktok-mock-upstream.js';

/**
 * Registers both platforms' mock upstreams on one shared `MockAgent`. There
 * is one dispatcher per stress run (see `load-generator.ts`) regardless of
 * how many platforms it drives -- the same way production's
 * `createProxyAgentFactory` is platform-agnostic transport wiring.
 */
export function registerAllMockUpstreams(
  mockAgent: MockAgent,
  workload: WorkloadProfile,
  instagramDocIds: InstagramMockUpstreamOptions,
): void {
  registerTikTokMockUpstream(mockAgent, workload.tiktok, workload.seed);
  registerInstagramMockUpstream(mockAgent, workload.instagram, workload.seed, instagramDocIds);
}

/**
 * Combined latency lookup for the shared timing interceptor. TikTok and
 * Instagram paths never overlap (`/embed/v2/...`, `/player/api/v1/items` vs
 * `/`, `/graphql/query`, `/api/v1/media/.../info/`), so each platform's own
 * `compute*RequestLatencyMs` already returns `0` for a path it does not
 * recognize -- trying both in sequence is always correct, not just a
 * heuristic.
 */
export function combinedRequestLatencyMs(
  opts: RequestTimingLookupInput,
  workload: WorkloadProfile,
  instagramDocIds: InstagramMockUpstreamOptions,
): number {
  const tiktokDelay = computeTikTokRequestLatencyMs(opts, workload.tiktok, workload.seed);
  if (tiktokDelay > 0) return tiktokDelay;
  return computeInstagramRequestLatencyMs(opts, workload.instagram, workload.seed, instagramDocIds);
}
