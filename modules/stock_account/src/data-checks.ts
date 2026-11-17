/**
 * Stock valuation's data checks (RFC 0036 §2.3): the stock accounts in the books hold what the stock is worth (the
 * sum of its valuation layers), and every product's layers add up to the quantity it has on hand.
 */
import type { DataCheckSpec, DataFinding } from '@kosh/modules-sdk';
import type { Env as AnyEnv } from '@kosh/server/orm';

/** A name as text: a translated one is stored per language. */
const named = (name: unknown): string =>
  typeof name === 'object' && name !== null
    ? String(Object.values(name as Record<string, unknown>)[0] ?? '')
    : String(name ?? '');

export const stockAccountDataChecks: readonly DataCheckSpec[] = [
  {
    key: 'stock_value_books',
    label: 'The stock accounts hold what the stock is worth',
    run: async (raw: never): Promise<DataFinding[]> => {
      const env = raw as AnyEnv;
      const company = env.companyId as number;
      const [row] = await env.sql<{ layers: string; books: string }>`
        SELECT
          (SELECT COALESCE(SUM(value), 0) FROM stock_valuation_layer WHERE company_id = ${company})::text AS layers,
          (SELECT COALESCE(SUM(l.balance), 0)
             FROM account_move_line l JOIN account_move m ON m.id = l.move_id
             WHERE l.posted AND m.company_id = ${company} AND l.account_id IN (
               SELECT stock_valuation_account_id FROM res_company WHERE id = ${company}
               UNION SELECT stock_valuation_account_id FROM product_category
                 WHERE stock_valuation_account_id IS NOT NULL))::text AS books`;
      if (row === undefined || Number(row.layers) === Number(row.books)) return [];
      return [
        {
          what: 'Stock value',
          detail: `the stock is worth ${row.layers}, the stock accounts hold ${row.books}`,
        },
      ];
    },
  },
  {
    key: 'layers_quantity',
    label: 'Each product’s valuation adds up to its quantity on hand',
    run: async (raw: never): Promise<DataFinding[]> => {
      const env = raw as AnyEnv;
      const company = env.companyId as number;
      const rows = await env.sql<{
        product_id: number;
        name: unknown;
        valued: string;
        held: string;
      }>`
        WITH valued AS (
          SELECT product_id, SUM(quantity) AS quantity FROM stock_valuation_layer
          WHERE company_id = ${company} GROUP BY product_id
        ), held AS (
          SELECT q.product_id, SUM(q.quantity) AS quantity
          FROM stock_quant q JOIN stock_location l ON l.id = q.location_id
          WHERE q.company_id = ${company} AND l.usage = 'internal' GROUP BY q.product_id
        )
        SELECT pr.id AS product_id, pr.name,
               COALESCE(valued.quantity, 0)::text AS valued, COALESCE(held.quantity, 0)::text AS held
        FROM product_product pr
        JOIN valued ON valued.product_id = pr.id
        LEFT JOIN held ON held.product_id = pr.id
        WHERE valued.quantity <> COALESCE(held.quantity, 0)
        ORDER BY pr.id LIMIT 200`;
      return rows.map((r) => ({
        what: named(r.name),
        detail: `${r.valued} valued, ${r.held} on hand`,
        records: { model: 'product.product', ids: [r.product_id] },
      }));
    },
  },
];
