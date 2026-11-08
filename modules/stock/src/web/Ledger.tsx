/**
 * Stockroom › Stock ledger (RFC 0032 §3.3): for a period and the chosen warehouses (or every one), each product's
 * opening, what came in and went out by movement type, and its closing — as a summary or every movement —, and the
 * stock report (on hand, reserved, available, incoming, outgoing per product and location), as the server computes
 * them, with their XLSX and PDF files.
 */
import { ApiError, Button, Input, Label, type PageProps, useKosh } from '@kosh/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

const IN_TYPES = [
  'purchase_receipt',
  'sales_return',
  'production_in',
  'transfer_in',
  'adjustment_in',
  'other_in',
] as const;
const OUT_TYPES = [
  'sales_delivery',
  'purchase_return',
  'production_out',
  'transfer_out',
  'consumption',
  'scrap',
  'adjustment_out',
  'other_out',
] as const;
type Tab = 'summary' | 'details' | 'stock';
const TABS: readonly Tab[] = ['summary', 'details', 'stock'];

interface Figure {
  readonly qty: string;
  readonly value: string;
}
interface Product {
  readonly id: number;
  readonly name: string;
  readonly uom: string;
}
interface SummaryRow {
  readonly product: Product;
  readonly opening: Figure;
  readonly in: Readonly<Record<(typeof IN_TYPES)[number], Figure>>;
  readonly out: Readonly<Record<(typeof OUT_TYPES)[number], Figure>>;
  readonly totalIn: Figure;
  readonly totalOut: Figure;
  readonly closing: Figure;
}
interface DetailRow {
  readonly date: string;
  readonly reference: string;
  readonly origin: string | null;
  readonly product: Product;
  readonly from: string;
  readonly to: string;
  readonly type: string;
  readonly qty: string;
  readonly value: string;
}
interface StockRow {
  readonly product: Product;
  readonly location: { readonly id: number; readonly name: string };
  readonly onHand: string;
  readonly reserved: string;
  readonly available: string;
  readonly incoming: string;
  readonly outgoing: string;
}
interface Ledger {
  readonly valued: boolean;
  readonly rows: readonly (SummaryRow | DetailRow)[];
}
interface Stock {
  readonly rows: readonly StockRow[];
}
interface Named {
  readonly id: number;
  readonly name: string;
}

function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const firstOfMonth = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};
const today = (): string => new Date().toISOString().slice(0, 10);

const cell = 'px-2 py-1 whitespace-nowrap';
const num = `${cell} text-end tabular-nums`;

export function Ledger({ api }: PageProps): ReactElement {
  const { t } = useTranslation('stock');
  const { format } = useKosh();
  const id = useId();
  const [tab, setTab] = useState<Tab>('summary');
  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(today);
  const [warehouses, setWarehouses] = useState<readonly number[]>([]);
  const [categories, setCategories] = useState<readonly number[]>([]);
  const warehouseList = useQuery({
    queryKey: ['stock', 'ledger', 'warehouses'],
    queryFn: async () =>
      (
        await api.list('stock.warehouse', {
          fields: ['id', 'name'],
          order: ['name asc'],
          limit: 200,
        })
      ).items as unknown as Named[],
  });
  const categoryList = useQuery({
    queryKey: ['stock', 'ledger', 'categories'],
    queryFn: async () =>
      (
        await api.list('product.category', {
          fields: ['id', 'name'],
          order: ['name asc'],
          limit: 500,
        })
      ).items as unknown as Named[],
  });
  const scope = `warehouses=${warehouses.join(',')}&categories=${categories.join(',')}`;
  const path =
    tab === 'stock'
      ? `/api/v1/stockroom/stock?${scope}`
      : `/api/v1/stockroom/ledger?from=${from}&to=${to}&mode=${tab}&${scope}`;
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const data = useQuery({
    queryKey: ['stock', 'ledger', tab, from, to, warehouses, categories],
    queryFn: () => api.call<Ledger | Stock>('GET', path),
    enabled: tab === 'stock' || valid,
  });
  const download = useMutation({
    mutationFn: async (kind: 'xlsx' | 'pdf') => {
      const { blob, filename } = await api.download(`${path}&format=${kind}`, undefined, 'GET');
      saveFile(blob, filename);
    },
  });
  const error = data.error ?? download.error;
  const chosen = (e: React.ChangeEvent<HTMLSelectElement>) =>
    [...e.target.selectedOptions].map((o) => Number(o.value));
  return (
    <div className="grid gap-4 p-4">
      <h1 className="text-xl font-semibold">{t('ledger.title')}</h1>
      <div className="flex flex-wrap items-end gap-2">
        <fieldset className="flex flex-wrap gap-1">
          <legend className="sr-only">{t('ledger.tab')}</legend>
          {TABS.map((k) => (
            <Button
              key={k}
              variant={tab === k ? 'primary' : 'secondary'}
              aria-pressed={tab === k}
              onClick={() => setTab(k)}
            >
              {t(`ledger.tabs.${k}`)}
            </Button>
          ))}
        </fieldset>
        {tab === 'stock' ? null : (
          <>
            <div className="grid gap-1">
              <Label htmlFor={`${id}-from`}>{t('ledger.from')}</Label>
              <Input
                id={`${id}-from`}
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor={`${id}-to`}>{t('ledger.to')}</Label>
              <Input
                id={`${id}-to`}
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </>
        )}
        <div className="grid gap-1">
          <Label htmlFor={`${id}-warehouses`}>{t('ledger.warehouses')}</Label>
          <select
            id={`${id}-warehouses`}
            multiple
            className="min-w-48 rounded-md border bg-background px-2 py-1 text-sm"
            value={warehouses.map(String)}
            onChange={(e) => setWarehouses(chosen(e))}
          >
            {(warehouseList.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-categories`}>{t('ledger.categories')}</Label>
          <select
            id={`${id}-categories`}
            multiple
            className="min-w-48 rounded-md border bg-background px-2 py-1 text-sm"
            value={categories.map(String)}
            onChange={(e) => setCategories(chosen(e))}
          >
            {(categoryList.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <Button
          variant="secondary"
          disabled={download.isPending}
          onClick={() => download.mutate('xlsx')}
        >
          {t('ledger.xlsx')}
        </Button>
        <Button
          variant="secondary"
          disabled={download.isPending}
          onClick={() => download.mutate('pdf')}
        >
          {t('ledger.pdf')}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{t(`ledger.hints.${tab}`)}</p>
      {error === null ? null : (
        <p role="alert" className="text-sm text-danger">
          {error instanceof ApiError ? error.message : String(error)}
        </p>
      )}
      {data.data === undefined ? null : tab === 'stock' ? (
        <StockTable rows={(data.data as Stock).rows} />
      ) : tab === 'details' ? (
        <Details data={data.data as Ledger} />
      ) : (
        <Summary data={data.data as Ledger} />
      )}
    </div>
  );

  function Summary({ data }: { readonly data: Ledger }): ReactElement {
    const rows = data.rows as readonly SummaryRow[];
    if (rows.length === 0)
      return <p className="text-sm text-muted-foreground">{t('ledger.empty')}</p>;
    const q = (f: Figure) => format.decimal(f.qty, 3);
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className={`${cell} text-start`}>{t('ledger.product')}</th>
              <th className={`${cell} text-start`}>{t('ledger.unit')}</th>
              <th className={`${cell} text-end`}>{t('ledger.opening')}</th>
              {IN_TYPES.map((k) => (
                <th key={k} className={`${cell} text-end`}>
                  {t(`ledger.types.${k}`)}
                </th>
              ))}
              <th className={`${cell} text-end font-semibold`}>{t('ledger.totalIn')}</th>
              {OUT_TYPES.map((k) => (
                <th key={k} className={`${cell} text-end`}>
                  {t(`ledger.types.${k}`)}
                </th>
              ))}
              <th className={`${cell} text-end font-semibold`}>{t('ledger.totalOut')}</th>
              <th className={`${cell} text-end font-semibold`}>{t('ledger.closing')}</th>
              {data.valued ? (
                <th className={`${cell} text-end`}>{t('ledger.closingValue')}</th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.product.id} className="border-b">
                <td className={cell}>{r.product.name}</td>
                <td className={cell}>{r.product.uom}</td>
                <td className={num}>{q(r.opening)}</td>
                {IN_TYPES.map((k) => (
                  <td key={k} className={num}>
                    {q(r.in[k])}
                  </td>
                ))}
                <td className={`${num} font-semibold`}>{q(r.totalIn)}</td>
                {OUT_TYPES.map((k) => (
                  <td key={k} className={num}>
                    {q(r.out[k])}
                  </td>
                ))}
                <td className={`${num} font-semibold`}>{q(r.totalOut)}</td>
                <td className={`${num} font-semibold`}>{q(r.closing)}</td>
                {data.valued ? <td className={num}>{format.decimal(r.closing.value, 2)}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  function Details({ data }: { readonly data: Ledger }): ReactElement {
    const rows = data.rows as readonly DetailRow[];
    if (rows.length === 0)
      return <p className="text-sm text-muted-foreground">{t('ledger.empty')}</p>;
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className={`${cell} text-start`}>{t('ledger.date')}</th>
              <th className={`${cell} text-start`}>{t('ledger.reference')}</th>
              <th className={`${cell} text-start`}>{t('ledger.origin')}</th>
              <th className={`${cell} text-start`}>{t('ledger.product')}</th>
              <th className={`${cell} text-start`}>{t('ledger.fromPlace')}</th>
              <th className={`${cell} text-start`}>{t('ledger.toPlace')}</th>
              <th className={`${cell} text-start`}>{t('ledger.movement')}</th>
              <th className={`${cell} text-end`}>{t('ledger.quantity')}</th>
              {data.valued ? <th className={`${cell} text-end`}>{t('ledger.value')}</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: movement rows have no id of their own
              <tr key={i} className="border-b">
                <td className={cell}>{format.date(r.date)}</td>
                <td className={cell}>{r.reference}</td>
                <td className={cell}>{r.origin ?? ''}</td>
                <td className={cell}>
                  {r.product.name} <span className="text-muted-foreground">{r.product.uom}</span>
                </td>
                <td className={cell}>{r.from}</td>
                <td className={cell}>{r.to}</td>
                <td className={cell}>{t(`ledger.types.${r.type}`)}</td>
                <td className={num}>{format.decimal(r.qty, 3)}</td>
                {data.valued ? <td className={num}>{format.decimal(r.value, 2)}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  function StockTable({ rows }: { readonly rows: readonly StockRow[] }): ReactElement {
    if (rows.length === 0)
      return <p className="text-sm text-muted-foreground">{t('ledger.empty')}</p>;
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className={`${cell} text-start`}>{t('ledger.product')}</th>
              <th className={`${cell} text-start`}>{t('ledger.unit')}</th>
              <th className={`${cell} text-start`}>{t('ledger.location')}</th>
              <th className={`${cell} text-end`}>{t('ledger.onHand')}</th>
              <th className={`${cell} text-end`}>{t('ledger.reserved')}</th>
              <th className={`${cell} text-end`}>{t('ledger.available')}</th>
              <th className={`${cell} text-end`}>{t('ledger.incoming')}</th>
              <th className={`${cell} text-end`}>{t('ledger.outgoing')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.product.id}-${r.location.id}`} className="border-b">
                <td className={cell}>{r.product.name}</td>
                <td className={cell}>{r.product.uom}</td>
                <td className={cell}>{r.location.name}</td>
                <td className={num}>{format.decimal(r.onHand, 3)}</td>
                <td className={num}>{format.decimal(r.reserved, 3)}</td>
                <td className={num}>{format.decimal(r.available, 3)}</td>
                <td className={num}>{format.decimal(r.incoming, 3)}</td>
                <td className={num}>{format.decimal(r.outgoing, 3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
}
