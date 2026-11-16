/** A module of a company's own that meets the standard: a labelled model with a list, a form and a search. */
export const clean = {
  name: 'clean',
  version: '1.0.0',
  depends: [],
  shutro: {
    models: [{ name: 'clean.note', label: 'Note', fields: { name: { kind: 'char' } } }],
  },
  views: {
    'clean.note.list': { type: 'list', model: 'clean.note' },
    'clean.note.form': { type: 'form', model: 'clean.note' },
  },
  search: { 'clean.note': { fields: ['name'] } },
};
