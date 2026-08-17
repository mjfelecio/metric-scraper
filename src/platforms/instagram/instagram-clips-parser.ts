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
          page_info: z
            .object({
              end_cursor: z.string().nullable().optional(),
              has_next_page: z.boolean().optional(),
            })
            .nullish(),
        })
        .nullish(),
    })
    .nullish(),
  status: z.string().optional(),
  message: z.string().optional(),
});

export interface InstagramClipsPage {
  views: number | null;
  endCursor: string | null;
  hasNextPage: boolean;
}

/** Find a Reel's exact play count and the cursor for a bounded next-page lookup. */
export function parseInstagramClipsResponse(body: string, shortcode: string): InstagramClipsPage {
  const parsed = ClipsResponseSchema.safeParse(parseJson(body, 'Instagram clips'));
  if (!parsed.success)
    throw new InstagramParseError('Instagram clips response has an invalid shape');
  if (parsed.data.status !== undefined && parsed.data.status !== 'ok') {
    throw new InstagramParseError(
      `Instagram clips response failed${parsed.data.message === undefined ? '' : `: ${parsed.data.message}`}`,
    );
  }

  const connection = parsed.data.data?.xdt_api__v1__clips__user__connection_v2;
  const edges = connection?.edges ?? [];
  let views: number | null = null;
  for (const edge of edges) {
    if (edge.node.media.code === shortcode) {
      views = parseOptionalCount(edge.node.media.play_count, 'play_count');
      break;
    }
  }
  const endCursor = connection?.page_info?.end_cursor ?? null;
  return {
    views,
    endCursor,
    hasNextPage: connection?.page_info?.has_next_page === true && endCursor !== null,
  };
}
