import { type ActorAdapter } from './actor-adapter.js';
import { ClockworksTikTokAdapter } from './clockworks-tiktok-adapter.js';
import { NoviTikTokAdapter } from './novi-tiktok-adapter.js';

/**
 * Actor id → the adapter that knows its input and output shapes.
 *
 * This registry is the reason `--actor` is safe to use. Before it existed the
 * flag changed only the API path while the Clockworks adapter stayed hardcoded,
 * so pointing it at a different vendor sent Clockworks field names — which
 * Apify ignores silently rather than rejecting — and then read a snake_case
 * dataset with a camelCase reader. The run would start, the charge would land,
 * every metric would come back null, and nothing about the output would say
 * why. An unknown id must therefore be a hard error, never a fallback.
 */
const ADAPTERS: readonly ActorAdapter[] = [new ClockworksTikTokAdapter(), new NoviTikTokAdapter()];

export function supportedActorIds(): readonly string[] {
  return ADAPTERS.map((adapter) => adapter.actorId);
}

/**
 * The adapter for `actorId`.
 *
 * @throws if no adapter claims the id — a benchmark against an Actor whose
 * output shape nothing here understands is a charge with no findings.
 */
export function adapterFor(actorId: string): ActorAdapter {
  // `owner~name` is the request-path spelling of `owner/name`, so both must
  // resolve to the same adapter — the CLI accepts either.
  const wanted = actorId.trim().replace('~', '/').toLowerCase();
  const adapter = ADAPTERS.find((candidate) => candidate.actorId.toLowerCase() === wanted);
  if (adapter === undefined) {
    throw new Error(
      [
        `No adapter is registered for Actor "${actorId}".`,
        `Supported: ${supportedActorIds().join(', ')}.`,
        'Each Actor has its own input and output shape, and Apify ignores unknown',
        'input fields without complaining — so running an unsupported Actor would',
        'spend money and return nothing readable. Add an ActorAdapter for it first.',
      ].join(' '),
    );
  }
  return adapter;
}
