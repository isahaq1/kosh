/**
 * Document layouts (RFC 0005 §5): the JSON a template is made of, edited by the designer and compiled to print HTML
 * by `@kosh/reporting`. Shared here so module manifests can ship default templates.
 */
/** One block of a layout. `bind` is a field path on the record (`partner.name`), with Money / dates formatted. */
/** The barcodes a document can draw; `auto` chooses by the value. */
export const BARCODE_SYMBOLOGIES = [
  'auto',
  'code128',
  'code39',
  'ean13',
  'ean8',
  'upca',
  'itf14',
  'datamatrix',
  'pdf417',
] as const;
export type BarcodeSymbology = (typeof BARCODE_SYMBOLOGIES)[number];

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
  /** A QR code of a field's value (a ticket's check-in code, an e-invoice's signed QR), `size` millimetres wide. */
  | {
      readonly kind: 'qr';
      readonly id: string;
      readonly bind: string;
      readonly size?: number;
      readonly label?: string;
    }
  /**
   * A barcode of a field's value (a product's barcode, a badge, a document's number), `size` millimetres wide
   * and `height` millimetres high. `auto` draws EAN-13, EAN-8 or UPC-A when the value is one — its check digit
   * right —, and Code 128 otherwise; a value the asked symbology cannot hold is drawn as Code 128 too.
   */
  | {
      readonly kind: 'barcode';
      readonly id: string;
      readonly bind: string;
      readonly symbology?: BarcodeSymbology;
      readonly size?: number;
      readonly height?: number;
      /** The value in words under the bars (default: shown). */
      readonly text?: boolean;
      readonly label?: string;
    }
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
