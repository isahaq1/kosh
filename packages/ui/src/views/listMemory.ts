/**
 * The ids of the list a user last looked at, per model (RFC 0010 §3.4): a form opened from that list shows
 * "3 / 24" and moves to the previous and next record of the same search and order. In memory only.
 */
const lists = new Map<
  string,
  { readonly ids: readonly number[]; readonly offset: number; readonly total: number }
>();

/** Remembers the rows a list shows (one page: `offset` is its first row's position). */
export function rememberList(
  model: string,
  ids: readonly number[],
  offset: number,
  total: number,
): void {
  lists.set(model, { ids, offset, total });
}

/** Where `id` is in the model's last list, and its neighbours there. */
export function neighbours(
  model: string,
  id: number,
):
  | {
      readonly position: number;
      readonly total: number;
      readonly prev?: number;
      readonly next?: number;
    }
  | undefined {
  const list = lists.get(model);
  const index = list?.ids.indexOf(id) ?? -1;
  if (list === undefined || index < 0) return undefined;
  const prev = list.ids[index - 1];
  const next = list.ids[index + 1];
  return {
    position: list.offset + index + 1,
    total: list.total,
    ...(prev === undefined ? {} : { prev }),
    ...(next === undefined ? {} : { next }),
  };
}
