/**
 * Design mode (RFC 0012 §5.6): while it is on, the form shows "Add field" at the end of each section and the list
 * an "Add column" button; choosing one hands the spot to whoever turned design mode on (Kosh Studio's header item),
 * which asks what to add and sends it to the server. The renderers only say where: they change nothing themselves.
 */
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from 'react';

/** Where the user wants to add something. */
export type DesignSpot =
  /** At the end of a form section (a group node). */
  | {
      readonly kind: 'form';
      readonly view: string;
      readonly model: string;
      readonly group: string;
      readonly groupLabel?: string;
    }
  /** After the last column of a list. */
  | {
      readonly kind: 'list';
      readonly view: string;
      readonly model: string;
      /** The last column's node id (the anchor). */
      readonly after: string;
      /** The fields already shown. */
      readonly shown: readonly string[];
    };

export interface DesignContextValue {
  /** Design mode is on. */
  readonly active: boolean;
  setActive(active: boolean): void;
  /** The spot the user chose, until it is handled. */
  readonly spot: DesignSpot | null;
  choose(spot: DesignSpot | null): void;
}

const OFF: DesignContextValue = {
  active: false,
  setActive: () => {},
  spot: null,
  choose: () => {},
};

const Context = createContext<DesignContextValue>(OFF);

/** Design mode's state, for the app shell. */
export function DesignProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const [active, setActive] = useState(false);
  const [spot, choose] = useState<DesignSpot | null>(null);
  const value = useMemo(
    () => ({
      active,
      setActive: (on: boolean) => {
        setActive(on);
        if (!on) choose(null);
      },
      spot,
      choose,
    }),
    [active, spot],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Design mode (off outside a {@link DesignProvider}). */
export function useDesign(): DesignContextValue {
  return useContext(Context);
}
