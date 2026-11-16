/** A module that breaks the standard: a model without a label, a list without a search spec, no form. */
export const library = {
  name: 'library',
  version: '1.0.0',
  depends: [],
  shutro: {
    models: [{ name: 'library.book', fields: { name: { kind: 'char' } } }],
  },
  views: { 'library.book.list': { type: 'list', model: 'library.book' } },
};
