/** `emitting` (RFC 0023 E1): the transition's own `after` first, then the named event for each record. */
import { expect, test } from 'vitest';
import { emitting } from '../src/events.js';

test('runs the own after, then emits the topic once per record; keeps the rest of the transition', async () => {
  const calls: string[] = [];
  const transition = emitting('stock.picking.done', {
    from: ['assigned'],
    to: 'done',
    after: async () => {
      calls.push('after');
    },
  });
  expect(transition).toMatchObject({ from: ['assigned'], to: 'done' });
  const records = {
    ids: [3, 4],
    env: {
      emit: async (topic: string, payload: Record<string, unknown>) => {
        calls.push(`${topic} ${String(payload['id'])}`);
      },
    },
  };
  await (transition.after as (r: unknown) => Promise<void>)(records);
  expect(calls).toEqual(['after', 'stock.picking.done 3', 'stock.picking.done 4']);
});

test('a transition without its own after still emits', async () => {
  const seen: number[] = [];
  const transition = emitting('todo.task.done', { from: ['open'], to: 'done' });
  await (transition as unknown as { after(r: unknown): Promise<void> }).after({
    ids: [7],
    env: {
      emit: async (_t: string, p: Record<string, unknown>) => void seen.push(p['id'] as number),
    },
  });
  expect(seen).toEqual([7]);
});
