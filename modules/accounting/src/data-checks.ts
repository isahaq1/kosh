/**
 * Accounting's data checks (RFC 0036 §2.3): what must always hold in a company's books, read from the posted
 * entries. Each finding names the entries behind it.
 */
import type { DataCheckSpec, DataFinding } from '@kosh/modules-sdk';
import type { Env as AnyEnv } from '@kosh/server/orm';

const company = (env: AnyEnv): number => env.companyId as number;

export const accountingDataChecks: readonly DataCheckSpec[] = [
  {
    key: 'entries_balanced',
    label: 'Every posted entry balances',
    run: async (raw: never): Promise<DataFinding[]> => {
      const env = raw as AnyEnv;
      const rows = await env.sql<{ id: number; name: string; off: string }>`
        SELECT m.id, m.name, SUM(l.balance)::text AS off
        FROM account_move m JOIN account_move_line l ON l.move_id = m.id
        WHERE m.company_id = ${company(env)} AND m.state = 'posted'
        GROUP BY m.id, m.name HAVING SUM(l.balance) <> 0
        ORDER BY m.id LIMIT 200`;
      return rows.map((r) => ({
        what: r.name,
        detail: `its debits and credits differ by ${r.off}`,
        records: { model: 'account.move', ids: [r.id] },
      }));
    },
  },
  {
    key: 'documents_residual',
    label: 'What is left to pay on each document is what its receivable or payable lines hold',
    run: async (raw: never): Promise<DataFinding[]> => {
      const env = raw as AnyEnv;
      const rows = await env.sql<{ id: number; name: string; left: string; lines: string }>`
        SELECT m.id, m.name, abs(m.amount_residual)::text AS left,
               COALESCE(abs(SUM(l.amount_residual)), 0)::text AS lines
        FROM account_move m
        LEFT JOIN account_move_line l ON l.move_id = m.id
          AND l.account_type IN ('asset_receivable', 'liability_payable')
        WHERE m.company_id = ${company(env)} AND m.state = 'posted' AND m.kind <> 'entry'
        GROUP BY m.id, m.name, m.amount_residual
        HAVING abs(m.amount_residual) <> COALESCE(abs(SUM(l.amount_residual)), 0)
        ORDER BY m.id LIMIT 200`;
      return rows.map((r) => ({
        what: r.name,
        detail: `the document says ${r.left} is left, its lines ${r.lines}`,
        records: { model: 'account.move', ids: [r.id] },
      }));
    },
  },
  {
    key: 'numbering',
    label: 'Posted documents are numbered without gaps or duplicates',
    run: async (raw: never): Promise<DataFinding[]> => {
      const env = raw as AnyEnv;
      const rows = await env.sql<{
        prefix: string;
        n: number;
        distinct_n: number;
        low: string;
        high: string;
      }>`
        SELECT prefix, count(*)::int AS n, count(DISTINCT num)::int AS distinct_n,
               min(num)::text AS low, max(num)::text AS high
        FROM (
          SELECT substring(name from '^(.*?)[0-9]+$') AS prefix,
                 (substring(name from '([0-9]+)$'))::bigint AS num
          FROM account_move
          WHERE company_id = ${company(env)} AND state = 'posted' AND name ~ '[0-9]+$'
        ) numbered
        GROUP BY prefix
        HAVING count(*) <> count(DISTINCT num) OR max(num) - min(num) + 1 <> count(DISTINCT num)
        ORDER BY prefix`;
      return rows.map((r) => {
        const missing = Number(r.high) - Number(r.low) + 1 - r.distinct_n;
        const twice = r.n - r.distinct_n;
        return {
          what: `${r.prefix}…`,
          detail: [
            missing > 0 ? `${missing} number(s) missing between ${r.low} and ${r.high}` : null,
            twice > 0 ? `${twice} number(s) used more than once` : null,
          ]
            .filter((x) => x !== null)
            .join('; '),
        };
      });
    },
  },
];
