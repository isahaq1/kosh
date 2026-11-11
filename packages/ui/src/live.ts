/**
 * Live screens (RFC 0010 Phase B): React hooks over the realtime client. A list or board refetches when records of
 * its model change; a form refetches its record when someone else saves it (or, with unsaved changes, says so and
 * offers a reload), and shows who else has it open.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useKosh } from './context.js';
import type { ChangeEvent, PresenceUser } from './realtime.js';

/** Query keys of a model that a change invalidates (lists, boards, groups, totals). */
const MODEL_KEYS = ['list', 'kanban-stats', 'groups', 'totals'] as const;

/** Keeps the model's lists and boards current. */
export function useLiveModel(model: string): void {
  const { realtime } = useKosh();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      realtime?.subscribe(`model:${model}`, () => {
        for (const key of MODEL_KEYS)
          void queryClient.invalidateQueries({ queryKey: [key, model] });
      }),
    [realtime, model, queryClient],
  );
}

/** Query keys of figures computed from a model: stat tiles, report cards and charts, top-record lists. */
const FIGURE_KEYS = ['stat', 'report', 'list'] as const;

/**
 * Keeps figures current (RFC 0033 §3.5): the tiles of a record page and the cards of a dashboard refetch when a
 * record of a model they read changes — at most once a second per model, however many records change.
 */
export function useLiveFigures(models: readonly string[]): void {
  const { realtime } = useKosh();
  const queryClient = useQueryClient();
  const key = [...new Set(models)].sort().join(',');
  useEffect(() => {
    if (realtime === undefined || realtime === null || key === '') return;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const stops = key.split(',').map((model) =>
      realtime.subscribe(`model:${model}`, () => {
        if (timers.has(model)) return;
        timers.set(
          model,
          setTimeout(() => {
            timers.delete(model);
            for (const k of FIGURE_KEYS)
              void queryClient.invalidateQueries({ queryKey: [k, model] });
          }, 1000),
        );
      }),
    );
    return () => {
      for (const stop of stops) stop();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [realtime, key, queryClient]);
}

/** What a live record knows. */
export interface LiveRecord {
  /** Someone else changed the record while this screen had unsaved changes (cleared by `dismiss`). */
  readonly changedByOther: boolean;
  dismiss(): void;
  /** Other users who have the record open right now. */
  readonly others: readonly PresenceUser[];
}

/**
 * Keeps a record current and announces this tab's presence on it. While `dirty`, a change by someone else is
 * reported instead of applied; once the screen is clean again (saved or discarded), the record is refetched.
 */
export function useLiveRecord(model: string, id: number | 'new', dirty: boolean): LiveRecord {
  const { realtime, uid } = useKosh();
  const queryClient = useQueryClient();
  const key = `${model}:${String(id)}`;
  const [seen, setSeen] = useState(key);
  const [changedByOther, setChangedByOther] = useState(false);
  const [others, setOthers] = useState<readonly PresenceUser[]>([]);
  /** A change by someone else arrived while dirty and has not been applied yet. */
  const pending = useRef(false);
  if (seen !== key) {
    // Another record: start clean (state derived from props, set during render).
    setSeen(key);
    setChangedByOther(false);
    setOthers([]);
    pending.current = false;
  }
  useEffect(() => {
    if (realtime === undefined || id === 'new') return;
    const refetch = () => void queryClient.invalidateQueries({ queryKey: ['record', model, id] });
    if (!dirty && pending.current) {
      pending.current = false;
      setChangedByOther(false);
      refetch();
    }
    const stopChanges = realtime.subscribe(`record:${model}:${id}`, (event: ChangeEvent) => {
      if (event.by === uid) return; // our own save: the form already has the result
      if (dirty) {
        pending.current = true;
        setChangedByOther(true);
      } else refetch();
    });
    const stopPresence = realtime.onPresence(model, id, (users) =>
      setOthers(users.filter((u) => u.uid !== uid)),
    );
    const leave = realtime.setPresence(model, id);
    return () => {
      stopChanges();
      stopPresence();
      leave();
    };
  }, [realtime, model, id, dirty, uid, queryClient]);
  return {
    changedByOther,
    dismiss: () => {
      pending.current = false;
      setChangedByOther(false);
    },
    others,
  };
}
