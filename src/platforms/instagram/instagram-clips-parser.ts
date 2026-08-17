import { z } from 'zod';

import { InstagramParseError, parseJson, parseOptionalCount } from './instagram-parser-utils.js';

const ClipsResponseSchema = z.object({
  data: z
    .object({
      xdt_api__v1__clips__user__connection_v2: z
        .object({
          edges: z.array(
            z.object({ node: z.object({ media: z.record(z.string(), z.unknown()) }) }),
          ),
        })
        .nullish(),
    })
    .nullish(),
  status: z.string().optional(),
  message: z.string().optional(),
});

/** Find the exact public Reel play count in a creator's recent clips response. */
export function parseInstagramClipsResponse(body: string, shortcode: string): number | null {
  const parsed = ClipsResponseSchema.safeParse(parseJson(body, 'Instagram clips'));
  if (!parsed.success)
    throw new InstagramParseError('Instagram clips response has an invalid shape');
  if (parsed.data.status !== undefined && parsed.data.status !== 'ok') {
    throw new InstagramParseError(
      `Instagram clips response failed${parsed.data.message === undefined ? '' : `: ${parsed.data.message}`}`,
    );
  }

  const edges = parsed.data.data?.xdt_api__v1__clips__user__connection_v2?.edges ?? [];
  for (const edge of edges) {
    if (edge.node.media.code === shortcode) {
      return parseOptionalCount(edge.node.media.play_count, 'play_count');
    }
  }
  return null;
}
