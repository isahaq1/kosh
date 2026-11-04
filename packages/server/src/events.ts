/**
 * Named events of state transitions (RFC 0023 E1, RFC 0006): `emitting(topic, transition)` returns the transition
 * with an `after` hook that emits `topic` with `{ id }` for each record, once its own `after` ran — in the same
 * transaction, through the outbox, so notifications, automations and webhooks take it by name. The module declares
 * the topic in its manifest's `events`.
 *
 * ```ts
 * transitions: {
 *   validate: emitting('stock.picking.done', { from: ['assigned'], to: 'done', after: … }),
 * }
 * ```
 */
export function emitting<const T extends object>(topic: string, transition: T): T {
  const own = (transition as { readonly after?: (records: unknown) => unknown }).after;
  const after = async (records: unknown): Promise<void> => {
    await own?.(records);
    const { env, ids } = records as {
      readonly env: { emit(topic: string, payload: Record<string, unknown>): Promise<unknown> };
      readonly ids: readonly number[];
    };
    for (const id of ids) await env.emit(topic, { id });
  };
  return { ...transition, after } as T;
}
