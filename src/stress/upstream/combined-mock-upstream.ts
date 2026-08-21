import { type MockAgent } from 'undici';

import { type WorkloadProfile } from '../workload/workload-profile.js';

import {
  createInstagramMockUpstream,
  type InstagramMockUpstreamOptions,
} from './instagram-mock-upstream.js';
import { type RequestTimingLookupInput } from './proxy-mock-dispatcher.js';
import { createTikTokMockUpstream } from './tiktok-mock-upstream.js';

export interface CombinedMockUpstream {
  register: (mockAgent: MockAgent) => void;
  computeLatencyMs: (opts: RequestTimingLookupInput) => number;
}

/**
 * Builds both platforms' mock upstreams sharing one seed/profile, combined
 * into a single `register`/`computeLatencyMs` pair. There is one dispatcher
 * per stress run (see `load-generator.ts`) regardless of how many platforms
 * it drives -- the same way production's `createProxyAgentFactory` is
 * platform-agnostic transport wiring.
 *
 * Each platform owns its own occurrence-tracking state (see
 * `tiktok-mock-upstream.ts`/`instagram-mock-upstream.ts`'s doc comments),
 * constructed once here and reused across both `register` and
 * `computeLatencyMs` so the two stay consistent for the run's lifetime.
 */
export function createCombinedMockUpstream(
  workload: WorkloadProfile,
  instagramDocIds: InstagramMockUpstreamOptions,
): CombinedMockUpstream {
  const tiktok = createTikTokMockUpstream(workload.tiktok, workload.seed);
  const instagram = createInstagramMockUpstream(workload.instagram, workload.seed, instagramDocIds);

  return {
    register(mockAgent: MockAgent): void {
      tiktok.register(mockAgent);
      instagram.register(mockAgent);
    },
    // TikTok and Instagram paths never overlap (`/embed/v2/...`,
    // `/player/api/v1/items` vs `/`, `/graphql/query`, `/api/v1/media/.../info/`),
    // so each platform's own computeLatencyMs already returns `0` (and skips
    // its occurrence side effect) for a path it does not recognize -- trying
    // both in sequence is always correct, not just a heuristic.
    computeLatencyMs(opts: RequestTimingLookupInput): number {
      const tiktokDelay = tiktok.computeLatencyMs(opts);
      if (tiktokDelay > 0) return tiktokDelay;
      return instagram.computeLatencyMs(opts);
    },
  };
}
