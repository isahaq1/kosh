/**
 * Document layouts (RFC 0005 §5): the JSON a template is made of, edited by the designer and compiled to print HTML
 * by `@kosh/reporting`. Shared here so module manifests can ship default templates.
 */
/** One block of a layout. `bind` is a field path on the record (`partner.name`), with Money / dates formatted. */
export type Block =
  | {
      readonly kind: 'heading';
      readonly id: string;
      readonly text: string;
      readonly level?: 1 | 2 | 3;
    }
  | { readonly kind: 'text'; readonly id: string; readonly text: string }
  | { readonly kind: 'field'; readonly id: string; readonly label?: string; readonly bind: string }
  | {
      readonly kind: 'fields';
      readonly id: string;
      readonly columns?: 2 | 3;
      readonly items: readonly { readonly label?: string; readonly bind: string }[];
    }
  | {
      readonly kind: 'table';
      readonly id: string;
      /** A one2many field of the record, or `$records` for list documents. */
      readonly bind: string;
      readonly columns: readonly {
        readonly label?: string;
        readonly bind: string;
        readonly align?: 'start' | 'end';
        readonly sum?: boolean;
      }[];
    }
  | { readonly kind: 'divider'; readonly id: string }
  | { readonly kind: 'pageBreak'; readonly id: string }
  | { readonly kind: 'signature'; readonly id: string; readonly labels: readonly string[] }
  | {
      readonly kind: 'columns';
      readonly id: string;
      readonly left: readonly Block[];
      readonly right: readonly Block[];
    };

/** A document layout. */
export interface Layout {
  readonly paper?: 'A4' | 'Letter' | 'Legal';
  readonly orientation?: 'portrait' | 'landscape';
  /** `{{company.name}}`-style text; `{{page}}` / `{{pages}}` in the footer. */
  readonly header?: string;
  readonly footer?: string;
  readonly blocks: readonly Block[];
}
