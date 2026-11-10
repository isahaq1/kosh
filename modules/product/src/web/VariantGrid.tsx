/**
 * The variant grid on an order form (RFC 0030 §3.4, part 2): a button opens a dialog — pick a template, the
 * server lays its variants out as a size × colour matrix, type the quantities — and one line is added per variant
 * through the record's own lines field (the server prices them as it does any line).
 */
import { Alert, Button, Dialog, Input, Label, type NodeComponentProps } from '@kosh/ui';
import { type ReactElement, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface GridVariant {
  readonly id: number;
  readonly name: string;
  readonly listPrice: string;
}
interface Grid {
  readonly template: { readonly id: number; readonly name: string };
  readonly attributes: readonly string[];
  readonly rows: readonly { readonly key: string; readonly label: string }[];
  readonly columns: readonly { readonly id: number; readonly name: string }[];
  readonly cells: Readonly<Record<string, GridVariant | null>>;
}

export function VariantGrid({
  api,
  record,
  model,
  version,
  reload,
  node,
}: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('product');
  const id = useId();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<readonly { id: number; displayName: string }[]>([]);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = String(node.props?.['field'] ?? 'lines');

  // The template search: as typed, a few names.
  useEffect(() => {
    if (!open || grid !== null) return;
    let live = true;
    void api
      .names('product.template', { q, limit: 8 })
      .then((rows) => {
        if (live) setFound(rows);
      })
      .catch(() => {
        if (live) setFound([]);
      });
    return () => {
      live = false;
    };
  }, [api, open, q, grid]);

  if (record === null) return null;

  const choose = async (template: number): Promise<void> => {
    try {
      setGrid(await api.call<Grid>('GET', `/api/v1/product/templates/${template}/grid`));
      setQuantities({});
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const chosen = Object.entries(quantities).filter(
    ([key, qty]) => Number(qty) > 0 && grid?.cells[key] != null,
  );
  const add = async (): Promise<void> => {
    if (grid === null || chosen.length === 0) return;
    setBusy(true);
    try {
      const create = chosen.map(([key, qty]) => {
        const variant = grid.cells[key] as GridVariant;
        return { product: variant.id, name: variant.name, quantity: qty };
      });
      await api.update(model, Number(record.id), { [field]: { create } }, version);
      setOpen(false);
      setGrid(null);
      setQuantities({});
      setError(null);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const columns =
    grid === null
      ? []
      : grid.columns.length === 0
        ? [{ id: 0, name: t('grid.quantity') }]
        : grid.columns;

  return (
    <div className="my-2">
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        {t('grid.open')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setGrid(null);
            setQuantities({});
            setError(null);
          }
        }}
        title={grid === null ? t('grid.title') : grid.template.name}
        description={t('grid.description')}
        wide
        footer={
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t('grid.cancel')}
            </Button>
            <Button
              type="button"
              disabled={grid === null || chosen.length === 0 || busy}
              onClick={() => void add()}
            >
              {t('grid.add', { count: chosen.length })}
            </Button>
          </div>
        }
      >
        {error === null ? null : <Alert tone="danger">{error}</Alert>}
        {grid === null ? (
          <div className="grid gap-2">
            <Label htmlFor={`${id}-q`}>{t('grid.search')}</Label>
            <Input
              id={`${id}-q`}
              value={q}
              placeholder={t('grid.placeholder')}
              onChange={(e) => setQ(e.target.value)}
            />
            {found.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('grid.none')}</p>
            ) : (
              <ul className="grid gap-1">
                {found.map((r) => (
                  <li key={r.id}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void choose(r.id)}
                    >
                      {r.displayName}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="text-start p-1">
                    {grid.attributes.slice(0, -1).join(' / ') || grid.attributes[0] || ''}
                  </th>
                  {columns.map((c) => (
                    <th key={c.id} className="text-start p-1">
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.rows.map((row) => (
                  <tr key={row.key}>
                    <th className="text-start p-1 font-medium">{row.label}</th>
                    {columns.map((c) => {
                      const key = `${row.key}|${c.id}`;
                      const variant = grid.cells[key] ?? null;
                      return (
                        <td key={key} className="p-1">
                          {variant === null ? (
                            <span className="text-muted-foreground" title={t('grid.empty')}>
                              —
                            </span>
                          ) : (
                            <Input
                              aria-label={variant.name}
                              type="number"
                              min={0}
                              step="any"
                              inputMode="decimal"
                              className="w-24"
                              value={quantities[key] ?? ''}
                              onChange={(e) =>
                                setQuantities({ ...quantities, [key]: e.target.value })
                              }
                            />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Dialog>
    </div>
  );
}
