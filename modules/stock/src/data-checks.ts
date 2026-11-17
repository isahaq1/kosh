/**
 * Stockroom's data checks (RFC 0036 §2.3): the stock on hand is what the validated transfers moved — everything that
 * came into the company's internal locations less everything that left them, product by product.
 */
import type { DataCheckSpec, DataFinding } from '@kosh/modules-sdk';
import type { Env as AnyEnv } from '@kosh/server/orm';

/** A name as text: a translated one is stored per language. */
const named = (name: unknown): string =>
  typeof name === 'object' && name !== null
    ? String(Object.values(name as Record<string, unknown>)[0] ?? '')
    : String(name ?? '');

export const stockDataChecks: readonly DataCheckSpec[] = [
  {
    key: 'quants_ledger',
    label: 'The stock on hand is what the validated transfers moved',
    run: async (raw: never): Promise<DataFinding[]> => {
      const env = raw as AnyEnv;
      const company = env.companyId as number;
      const rows = await env.sql<{
        product_id: number;
        name: unknown;
        on_hand: string;
        moved: string;
      }>`
        WITH moved AS (
          SELECT m.product_id,
                 SUM(CASE WHEN d.usage = 'internal' THEN m.done_qty ELSE 0 END)
                   - SUM(CASE WHEN s.usage = 'internal' THEN m.done_qty ELSE 0 END) AS quantity
          FROM stock_move m
          JOIN stock_picking p ON p.id = m.picking_id
          JOIN stock_location s ON s.id = p.source_id
          JOIN stock_location d ON d.id = p.destination_id
          WHERE p.company_id = ${company} AND p.state = 'done'
          GROUP BY m.product_id
        ), held AS (
          SELECT q.product_id, SUM(q.quantity) AS quantity
          FROM stock_quant q JOIN stock_location l ON l.id = q.location_id
          WHERE q.company_id = ${company} AND l.usage = 'internal'
          GROUP BY q.product_id
        )
        SELECT pr.id AS product_id, pr.name,
               COALESCE(held.quantity, 0)::text AS on_hand, COALESCE(moved.quantity, 0)::text AS moved
        FROM product_product pr
        LEFT JOIN held ON held.product_id = pr.id
        LEFT JOIN moved ON moved.product_id = pr.id
        WHERE COALESCE(held.quantity, 0) <> COALESCE(moved.quantity, 0)
        ORDER BY pr.id LIMIT 200`;
      return rows.map((r) => ({
        what: named(r.name),
        detail: `${r.on_hand} on hand, but its transfers moved ${r.moved}`,
        records: { model: 'product.product', ids: [r.product_id] },
      }));
    },
  },
];
