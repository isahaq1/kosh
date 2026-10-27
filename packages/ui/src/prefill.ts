/**
 * Values proposed for a new record (the AI assistant's "Fill from a document"), handed from the list to the new
 * record's form in memory — never in the URL, so a document's contents stay out of the history and the logs.
 */

export interface Prefill {
  readonly values: Readonly<Record<string, unknown>>;
  /** The fields whose values are proposals, marked in the form until it is saved. */
  readonly proposed: readonly string[];
}

const pending = new Map<string, Prefill>();

/** Leaves values for the next new record of `action`. */
export function setPrefill(action: string, prefill: Prefill): void {
  pending.set(action, prefill);
}

/** Takes the values left for `action` (once). */
export function takePrefill(action: string): Prefill | undefined {
  const prefill = pending.get(action);
  pending.delete(action);
  return prefill;
}
