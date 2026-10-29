/**
 * App icons by name (`app.icon` in a module manifest): the launcher's tiles and the App manager's cards. Names
 * follow Lucide; an unknown name shows a neutral grid, never a broken image.
 */
import {
  BookOpen,
  Boxes,
  Briefcase,
  Building,
  Building2,
  ChartColumn,
  FolderKanban,
  LayoutGrid,
  ListChecks,
  LockKeyhole,
  type LucideIcon,
  Mail,
  MessageSquare,
  MessagesSquare,
  Package,
  PencilRuler,
  Plug,
  Receipt,
  Ruler,
  ScrollText,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Users,
  Wallet,
  Warehouse,
  Workflow,
} from 'lucide-react';
import type { ReactElement } from 'react';
import { cn } from '../lib/cn.js';

const ICONS: Readonly<Record<string, LucideIcon>> = {
  settings: Settings,
  users: Users,
  contacts: Users,
  box: Package,
  package: Package,
  product: Package,
  boxes: Boxes,
  chart: ChartColumn,
  reports: ChartColumn,
  book: BookOpen,
  'book-open': BookOpen,
  wallet: Wallet,
  accounting: Wallet,
  receipt: Receipt,
  purchase: Receipt,
  'shopping-cart': ShoppingCart,
  sales: ShoppingCart,
  'folder-kanban': FolderKanban,
  projects: FolderKanban,
  ruler: Ruler,
  warehouse: Warehouse,
  inventory: Warehouse,
  'message-square': MessageSquare,
  automation: Workflow,
  studio: PencilRuler,
  mail: Mail,
  messaging: MessageSquare,
  chat: MessagesSquare,
  shield: ShieldCheck,
  permissions: ShieldCheck,
  briefcase: Briefcase,
  plug: Plug,
  focus: ListChecks,
  todo: ListChecks,
  integrations: Plug,
  cart: ShoppingCart,
  company: Building2,
  companies: Building,
  security: LockKeyhole,
  audit: ScrollText,
  apps: LayoutGrid,
  assistant: Sparkles,
  sparkles: Sparkles,
};

/** A tinted square with the app's icon (decorative: the app's name is always shown next to it). */
export function AppIcon({
  name,
  className,
}: {
  readonly name: string | null | undefined;
  readonly className?: string;
}): ReactElement {
  const Icon = (name === null || name === undefined ? undefined : ICONS[name]) ?? LayoutGrid;
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground',
        className,
      )}
    >
      <Icon className="size-5" />
    </span>
  );
}
