/**
 * What every page of the portal shares: the API client, the formatter of the user's language, the language itself,
 * and the shapes the portal API answers with (RFC 0015 §5.5).
 */
import type { Formatter, KoshApi } from '@kosh/ui';
import { createContext, useContext } from 'react';

export interface Me {
  readonly user: number;
  readonly login: string;
  readonly name: string;
  readonly lang: string;
  readonly partner: { readonly id: number; readonly name: string } | null;
  readonly company: { readonly id: number; readonly name: string };
}
export interface FieldMeta {
  readonly key: string;
  readonly label: string;
  readonly kind: string;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
}
export type Row = Readonly<Record<string, unknown>> & { readonly id: number };
export interface DocumentType {
  readonly key: string;
  readonly label: string;
  readonly count: number;
}
export interface DocumentList {
  readonly key: string;
  readonly label: string;
  readonly fields: readonly FieldMeta[];
  readonly items: readonly Row[];
  readonly count: number;
}
export interface PortalAction {
  readonly key: string;
  readonly label: string;
  readonly signature: boolean;
  readonly message: boolean;
}
export interface DocumentView {
  readonly key: string;
  readonly label: string;
  readonly fields: readonly FieldMeta[];
  readonly record: Row;
  readonly lineFields?: readonly FieldMeta[];
  readonly lines?: readonly Row[];
  readonly actions: readonly PortalAction[];
  readonly pdf: boolean;
  readonly thread: boolean;
}
export interface Message {
  readonly id: number;
  readonly at: string;
  readonly body: string;
  readonly author: string;
  readonly mine: boolean;
}

export interface PortalContextValue {
  readonly api: KoshApi;
  readonly format: Formatter;
  readonly lang: string;
  setLang(lang: string): void;
}

export const PortalContext = createContext<PortalContextValue | null>(null);

export function usePortal(): PortalContextValue {
  const value = useContext(PortalContext);
  if (value === null) throw new Error('usePortal needs the PortalContext provider.');
  return value;
}

/** Saves a downloaded file. */
export function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
