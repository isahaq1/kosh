/**
 * The chatter of a record (registered as the `chatter` component; forms with `chatter: true` show it): send a
 * message or log a note with @mentions and files, follow the record, plan and complete activities, and read the
 * timeline of messages and changes. The server decides everything (who may see, post, edit, follow); this renders
 * what it answers and hides itself for users without the Messaging access level.
 */
import {
  Alert,
  ApiError,
  Badge,
  Button,
  Dialog,
  Input,
  type KoshApi,
  Label,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  type NodeComponentProps,
  Select,
  Spinner,
  Textarea,
  useKosh,
} from '@kosh/ui';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Bell,
  BellOff,
  CircleCheck,
  Download,
  EllipsisVertical,
  FileText,
  ListTodo,
  Mail,
  Paperclip,
  Phone,
  Upload,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ActivityItem,
  ChangeItem,
  Chatter as ChatterPage,
  FieldChange,
  MessageItem,
  TimelineItem,
  UserRef,
} from '../chatter.js';

export interface FileInfo {
  readonly id: number;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
}
interface ActivityType {
  readonly id: number;
  readonly name: string;
  readonly icon: string;
  readonly days: number;
}

const ICONS: Record<string, typeof CircleCheck> = {
  'list-todo': ListTodo,
  phone: Phone,
  users: Users,
  mail: Mail,
  upload: Upload,
  'circle-check': CircleCheck,
};

const enc = encodeURIComponent;

/** `YYYY-MM-DD` of today in the browser's calendar, `days` ahead. */
function isoDay(days = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')
  ).toUpperCase();
}

/** @internal Initials of a user (the chat reuses it). */
export function Avatar({ user }: { readonly user: UserRef | null }): ReactElement {
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground"
    >
      {user === null ? '·' : initials(user.name)}
    </span>
  );
}

/** @internal Downloads an attachment through the browser (the chat reuses it). */
export async function save(api: KoshApi, file: FileInfo): Promise<void> {
  const { blob, filename } = await api.download(
    `/api/v1/attachments/${file.id}/download`,
    undefined,
    'GET',
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const IMAGE = /^image\/(png|jpeg|gif|webp)$/;

function Thumbnail({
  api,
  file,
}: {
  readonly api: KoshApi;
  readonly file: FileInfo;
}): ReactElement | null {
  const image = useQuery({
    queryKey: ['attachment', file.id],
    queryFn: async () =>
      URL.createObjectURL(
        (
          await api.download(
            `/api/v1/attachments/${file.id}/download?inline=true`,
            undefined,
            'GET',
          )
        ).blob,
      ),
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (image.data === undefined) return null;
  return (
    <img src={image.data} alt={file.name} className="max-h-40 rounded-md border object-contain" />
  );
}

/** @internal The files of a message, or of a draft with their removal (the chat reuses it). */
export function Files({
  api,
  files,
  onRemove,
}: {
  readonly api: KoshApi;
  readonly files: readonly FileInfo[];
  readonly onRemove?: (file: FileInfo) => void;
}): ReactElement | null {
  const { t } = useTranslation('messaging');
  if (files.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2">
      {files.map((file) => (
        <li key={file.id} className="flex flex-col gap-1">
          {IMAGE.test(file.mime) && onRemove === undefined ? (
            <Thumbnail api={api} file={file} />
          ) : null}
          <span className="inline-flex items-center gap-1 rounded-md border bg-surface px-2 py-1 text-xs">
            <FileText className="size-3.5" aria-hidden />
            <button
              type="button"
              className="max-w-48 truncate hover:underline"
              aria-label={t('file', { name: file.name })}
              onClick={() => void save(api, file)}
            >
              {file.name}
            </button>
            {onRemove === undefined ? (
              <Download className="size-3.5 text-muted-foreground" aria-hidden />
            ) : (
              <button
                type="button"
                aria-label={t('removeFile', { name: file.name })}
                onClick={() => onRemove(file)}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** @internal The text with the picked mentions turned into tokens (`@[Name](user:12)`) for the server. */
export function withMentions(text: string, mentions: readonly UserRef[]): string {
  let out = text;
  for (const m of [...mentions].sort((a, b) => b.name.length - a.name.length))
    out = out.split(`@${m.name}`).join(`@[${m.name.replace(/[[\]]/g, '')}](user:${m.id})`);
  return out;
}

/** @internal A textarea that suggests users after `@` (a combobox: arrows, Enter / Tab to pick, Escape to close). */
export function MentionArea({
  api,
  value,
  onChange,
  onMention,
  onSubmit,
  placeholder,
  label,
}: {
  readonly api: KoshApi;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onMention: (user: UserRef) => void;
  readonly onSubmit: () => void;
  readonly placeholder: string;
  readonly label: string;
}): ReactElement {
  const { t } = useTranslation('messaging');
  const listId = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const people = useQuery({
    queryKey: ['names', 'res.users', query],
    queryFn: () => api.names('res.users', { q: query ?? '', limit: 6 }),
    enabled: query !== null,
  });
  const options = query === null ? [] : (people.data ?? []);
  const track = (text: string, caret: number) => {
    const match = /(?:^|\s)@([^\s@]{0,30})$/.exec(text.slice(0, caret));
    setQuery(match === null ? null : (match[1] ?? ''));
    setActive(0);
  };
  const pick = (user: { id: number; displayName: string }) => {
    const el = area.current;
    const caret = el?.selectionStart ?? value.length;
    const before = value.slice(0, caret).replace(/@([^\s@]{0,30})$/, `@${user.displayName} `);
    const next = before + value.slice(caret);
    onChange(next);
    onMention({ id: user.id, name: user.displayName });
    setQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(before.length, before.length);
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (options.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActive(
          (i) => (i + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length,
        );
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const option = options[active];
        if (option !== undefined) pick(option);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setQuery(null);
        return;
      }
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onSubmit();
    }
  };
  const open = options.length > 0;
  return (
    <div className="relative">
      <Textarea
        ref={area}
        rows={3}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          track(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
      />
      {/* The combobox pattern: focus stays in the textarea, options are referenced by aria-activedescendant. */}
      <div
        id={listId}
        role="listbox"
        aria-label={t('mentionSuggestions')}
        hidden={!open}
        className="absolute start-0 top-full z-20 mt-1 min-w-56 rounded-md border bg-surface p-1 shadow-md"
      >
        {options.map((o, i) => (
          <div
            key={o.id}
            id={`${listId}-${i}`}
            role="option"
            tabIndex={-1}
            aria-selected={i === active}
            className={`cursor-pointer rounded px-2 py-1 text-sm ${i === active ? 'bg-muted' : ''}`}
            onMouseDown={(e) => {
              e.preventDefault();
              pick(o);
            }}
          >
            {o.displayName}
          </div>
        ))}
      </div>
    </div>
  );
}

function Composer({
  api,
  model,
  id,
  kind,
  onDone,
}: {
  readonly api: KoshApi;
  readonly model: string;
  readonly id: number;
  readonly kind: 'comment' | 'note';
  readonly onDone: () => void;
}): ReactElement {
  const { t } = useTranslation('messaging');
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState<UserRef[]>([]);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const post = useMutation({
    mutationFn: () =>
      api.call<MessageItem>('POST', `/api/v1/chatter/${enc(model)}/${id}/messages`, {
        kind,
        text: withMentions(text, mentions),
        attachments: files.map((f) => f.id),
      }),
    onSuccess: () => {
      setText('');
      setMentions([]);
      setFiles([]);
      setError(null);
      onDone();
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });
  const attach = async (list: FileList | null) => {
    for (const file of Array.from(list ?? [])) {
      setUploading(file.name);
      try {
        const info = await api.upload<FileInfo>(
          `/api/v1/attachments/${enc(model)}/${id}`,
          file,
          file.name,
        );
        setFiles((current) => [...current, info]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading(null);
      }
    }
    if (picker.current !== null) picker.current.value = '';
  };
  const remove = (file: FileInfo) => {
    setFiles((current) => current.filter((f) => f.id !== file.id));
    void api.call('DELETE', `/api/v1/attachments/${file.id}`).catch(() => undefined);
  };
  const submit = () => {
    if (text.trim() !== '' && !post.isPending) post.mutate();
  };
  return (
    <div
      className={`grid gap-2 rounded-md border p-3 ${kind === 'note' ? 'bg-muted/40' : 'bg-surface'}`}
    >
      <MentionArea
        api={api}
        value={text}
        onChange={setText}
        onMention={(u) => setMentions((m) => (m.some((x) => x.id === u.id) ? m : [...m, u]))}
        onSubmit={submit}
        label={kind === 'comment' ? t('sendMessage') : t('logNote')}
        placeholder={kind === 'comment' ? t('messagePlaceholder') : t('notePlaceholder')}
      />
      <Files api={api} files={files} onRemove={remove} />
      {uploading === null ? null : (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {t('uploading', { name: uploading })}
        </p>
      )}
      {error === null ? null : <Alert tone="danger">{error}</Alert>}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          busy={post.isPending}
          disabled={text.trim() === ''}
          onClick={submit}
        >
          {kind === 'comment' ? t('send') : t('log')}
        </Button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          aria-hidden
          tabIndex={-1}
          onChange={(e) => void attach(e.target.files)}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => picker.current?.click()}
          aria-label={t('attach')}
        >
          <Paperclip aria-hidden />
        </Button>
      </div>
    </div>
  );
}

function ScheduleDialog({
  api,
  model,
  id,
  open,
  onOpenChange,
  onDone,
}: {
  readonly api: KoshApi;
  readonly model: string;
  readonly id: number;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDone: () => void;
}): ReactElement {
  const { t } = useTranslation('messaging');
  const { uid } = useKosh();
  const types = useQuery({
    queryKey: ['activity-types'],
    queryFn: () => api.call<{ types: ActivityType[] }>('GET', '/api/v1/activities/types'),
    enabled: open,
  });
  const users = useQuery({
    queryKey: ['names', 'res.users', 'all'],
    queryFn: () => api.names('res.users', { q: '', limit: 100 }),
    enabled: open,
  });
  const [type, setType] = useState<string | null>(null);
  const [summary, setSummary] = useState('');
  const [note, setNote] = useState('');
  const [deadline, setDeadline] = useState<string | null>(null);
  const [assignee, setAssignee] = useState<string>(String(uid));
  const [error, setError] = useState<string | null>(null);
  const typeId =
    type ?? (types.data?.types[0] === undefined ? null : String(types.data.types[0].id));
  const chosen = types.data?.types.find((x) => String(x.id) === typeId);
  const due = deadline ?? isoDay(chosen?.days ?? 0);
  const schedule = useMutation({
    mutationFn: () =>
      api.call('POST', `/api/v1/chatter/${enc(model)}/${id}/activities`, {
        type: Number(typeId),
        summary,
        note,
        deadline: due,
        assignee: Number(assignee),
      }),
    onSuccess: () => {
      setSummary('');
      setNote('');
      setDeadline(null);
      setError(null);
      onOpenChange(false);
      onDone();
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });
  const ids = {
    type: useId(),
    summary: useId(),
    deadline: useId(),
    assignee: useId(),
    note: useId(),
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('scheduleActivity')}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            busy={schedule.isPending}
            disabled={typeId === null}
            onClick={() => schedule.mutate()}
          >
            {t('schedule')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <div className="grid gap-1">
          <Label htmlFor={ids.type}>{t('type')}</Label>
          <Select
            id={ids.type}
            value={typeId}
            onChange={(v) => {
              setType(v);
              setDeadline(null);
            }}
            options={(types.data?.types ?? []).map((x) => ({ value: String(x.id), label: x.name }))}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={ids.summary}>{t('summary')}</Label>
          <Input
            id={ids.summary}
            value={summary}
            maxLength={200}
            onChange={(e) => setSummary(e.target.value)}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor={ids.deadline}>{t('deadline')}</Label>
            <Input
              id={ids.deadline}
              type="date"
              value={due}
              onChange={(e) => setDeadline(e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={ids.assignee}>{t('assignee')}</Label>
            <Select
              id={ids.assignee}
              value={assignee}
              onChange={setAssignee}
              options={(users.data ?? []).map((u) => ({
                value: String(u.id),
                label: u.displayName,
              }))}
            />
          </div>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={ids.note}>{t('noteLabel')}</Label>
          <Textarea
            id={ids.note}
            rows={2}
            value={note}
            maxLength={4000}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {error === null ? null : <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}

function Activities({
  api,
  activities,
  onChanged,
}: {
  readonly api: KoshApi;
  readonly activities: readonly ActivityItem[];
  readonly onChanged: () => void;
}): ReactElement | null {
  const { t } = useTranslation('messaging');
  const { format } = useKosh();
  const [completing, setCompleting] = useState<ActivityItem | null>(null);
  const [feedback, setFeedback] = useState('');
  const feedbackId = useId();
  const done = useMutation({
    mutationFn: (a: ActivityItem) =>
      api.call('POST', `/api/v1/activities/${a.id}/done`, { feedback }),
    onSuccess: () => {
      setCompleting(null);
      setFeedback('');
      onChanged();
    },
  });
  const cancel = useMutation({
    mutationFn: (a: ActivityItem) => api.call('DELETE', `/api/v1/activities/${a.id}`),
    onSuccess: onChanged,
  });
  if (activities.length === 0) return null;
  const today = isoDay();
  return (
    <section aria-labelledby={`${feedbackId}-h`} className="grid gap-2">
      <h3 id={`${feedbackId}-h`} className="text-sm font-semibold">
        {t('activities')}
      </h3>
      <ul className="grid gap-2">
        {activities.map((a) => {
          const Icon = ICONS[a.type.icon] ?? CircleCheck;
          const tone = a.deadline < today ? 'danger' : a.deadline === today ? 'warning' : 'neutral';
          return (
            <li
              key={a.id}
              className="flex flex-wrap items-start gap-3 rounded-md border bg-surface p-3"
            >
              <Icon className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
              <div className="grid min-w-0 flex-1 gap-0.5">
                <p className="text-sm">
                  <span className="font-medium">{a.type.name}</span>
                  {a.summary === null ? null : <>: {a.summary}</>}{' '}
                  <span className="text-muted-foreground">
                    {a.assignee === null ? null : t('for', { name: a.assignee.name })}
                  </span>
                </p>
                {a.note === null ? null : (
                  <p className="whitespace-pre-line text-xs text-muted-foreground">{a.note}</p>
                )}
              </div>
              <Badge tone={tone}>
                {tone === 'danger' ? `${t('overdue')} · ` : ''}
                {a.deadline === today ? t('dueToday') : t('due', { date: format.date(a.deadline) })}
              </Badge>
              {a.mine ? (
                <div className="flex gap-1">
                  <Button size="sm" variant="secondary" onClick={() => setCompleting(a)}>
                    <CircleCheck aria-hidden />
                    {t('markDone')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t('cancelActivity')}
                    busy={cancel.isPending && cancel.variables?.id === a.id}
                    onClick={() => cancel.mutate(a)}
                  >
                    <X aria-hidden />
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <Dialog
        open={completing !== null}
        onOpenChange={(open) => {
          if (!open) setCompleting(null);
        }}
        title={
          completing === null
            ? t('markDone')
            : `${completing.type.name}${completing.summary === null ? '' : `: ${completing.summary}`}`
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setCompleting(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              busy={done.isPending}
              onClick={() => {
                if (completing !== null) done.mutate(completing);
              }}
            >
              {t('done')}
            </Button>
          </>
        }
      >
        <div className="grid gap-1">
          <Label htmlFor={feedbackId}>{t('feedback')}</Label>
          <Textarea
            id={feedbackId}
            rows={3}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
        </div>
      </Dialog>
    </section>
  );
}

function Followers({
  api,
  model,
  id,
  page,
  onChanged,
}: {
  readonly api: KoshApi;
  readonly model: string;
  readonly id: number;
  readonly page: ChatterPage;
  readonly onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation('messaging');
  const [adding, setAdding] = useState(false);
  const [user, setUser] = useState<string | null>(null);
  const users = useQuery({
    queryKey: ['names', 'res.users', 'all'],
    queryFn: () => api.names('res.users', { q: '', limit: 100 }),
    enabled: adding,
  });
  const change = useMutation({
    mutationFn: (body: { follow: boolean; user?: number }) =>
      api.call('POST', `/api/v1/chatter/${enc(model)}/${id}/followers`, body),
    onSuccess: () => {
      setAdding(false);
      setUser(null);
      onChanged();
    },
  });
  const selectId = useId();
  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        variant={page.following ? 'secondary' : 'ghost'}
        busy={change.isPending && change.variables?.user === undefined}
        onClick={() => change.mutate({ follow: !page.following })}
        aria-pressed={page.following}
      >
        {page.following ? <Bell aria-hidden /> : <BellOff aria-hidden />}
        {page.following ? t('following') : t('follow')}
      </Button>
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" variant="ghost">
            <Users aria-hidden />
            {t('followers', { count: page.followers.length })}
          </Button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuLabel>{t('followers', { count: page.followers.length })}</MenuLabel>
          {page.followers.length === 0 ? <MenuItem disabled>{t('noFollowers')}</MenuItem> : null}
          {page.followers.map((f) => (
            <MenuItem
              key={f.id}
              disabled={!page.canManageFollowers && !page.following}
              onSelect={(e) => {
                if (!page.canManageFollowers) {
                  e.preventDefault();
                  return;
                }
                change.mutate({ follow: false, user: f.id });
              }}
              aria-label={page.canManageFollowers ? t('removeFollower', { name: f.name }) : f.name}
            >
              {f.name}
              {page.canManageFollowers ? <X className="ms-auto size-3.5" aria-hidden /> : null}
            </MenuItem>
          ))}
          {page.canManageFollowers ? (
            <>
              <MenuSeparator />
              <MenuItem onSelect={() => setAdding(true)}>
                <UserPlus aria-hidden />
                {t('addFollower')}
              </MenuItem>
            </>
          ) : null}
        </MenuContent>
      </Menu>
      <Dialog
        open={adding}
        onOpenChange={setAdding}
        title={t('addFollower')}
        footer={
          <Button
            variant="primary"
            disabled={user === null}
            busy={change.isPending}
            onClick={() => change.mutate({ follow: true, user: Number(user) })}
          >
            {t('addFollower')}
          </Button>
        }
      >
        <Label htmlFor={selectId}>{t('assignee')}</Label>
        <Select
          id={selectId}
          value={user}
          onChange={setUser}
          options={(users.data ?? [])
            .filter((u) => !page.followers.some((f) => f.id === u.id))
            .map((u) => ({ value: String(u.id), label: u.displayName }))}
        />
      </Dialog>
    </div>
  );
}

function valueText(
  change: FieldChange,
  side: 'old' | 'new',
  format: ReturnType<typeof useKosh>['format'],
  yesNo: (v: boolean) => string,
): string {
  const label = side === 'old' ? change.oldLabel : change.newLabel;
  if (label !== undefined) return label;
  const value = change[side];
  if (value === null || value === undefined || value === '') return '—';
  switch (change.kind) {
    case 'decimal':
    case 'monetary':
      return typeof value === 'string' ? format.decimal(value) : String(value);
    case 'integer':
    case 'float':
      return format.number(Number(value));
    case 'date':
      return format.date(String(value));
    case 'datetime':
      return format.datetime(String(value));
    case 'boolean':
      return yesNo(value === true);
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

function Change({ item }: { readonly item: ChangeItem }): ReactElement {
  const { t } = useTranslation('messaging');
  const { format } = useKosh();
  return (
    <div className="flex gap-3">
      <Avatar user={item.author} />
      <div className="grid gap-1 text-sm">
        <p>
          <span className="font-medium">{item.author?.name ?? t('system')}</span>{' '}
          <time className="text-xs text-muted-foreground" dateTime={item.at}>
            {format.datetime(item.at)}
          </time>
        </p>
        {item.action === 'create' ? (
          <p className="text-muted-foreground">{t('created')}</p>
        ) : (
          <ul className="grid gap-0.5">
            {item.changes.map((c) => (
              <li key={c.field} className="text-muted-foreground">
                <span className="text-surface-foreground">{c.label}</span>:{' '}
                <span className="line-through decoration-muted-foreground/60">
                  {valueText(c, 'old', format, (v) => (v ? t('yes') : t('no')))}
                </span>{' '}
                <span aria-hidden>→</span>{' '}
                <span className="font-medium text-surface-foreground">
                  {valueText(c, 'new', format, (v) => (v ? t('yes') : t('no')))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Message({
  api,
  item,
  onChanged,
}: {
  readonly api: KoshApi;
  readonly item: MessageItem;
  readonly onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation('messaging');
  const { format } = useKosh();
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const edit = useMutation({
    mutationFn: (text: string) =>
      api.call('PATCH', `/api/v1/chatter/messages/${item.id}`, { text }),
    onSuccess: () => {
      setEditing(null);
      onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.call('DELETE', `/api/v1/chatter/messages/${item.id}`),
    onSuccess: () => {
      setConfirming(false);
      onChanged();
    },
  });
  const editable = item.mine && (item.kind === 'comment' || item.kind === 'note');
  return (
    <article
      className={`flex gap-3 rounded-md p-2 ${item.kind === 'note' ? 'bg-muted/40' : ''}`}
      aria-label={`${item.author?.name ?? t('system')}, ${format.datetime(item.at)}`}
    >
      <Avatar user={item.author} />
      <div className="grid min-w-0 flex-1 gap-1">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{item.author?.name ?? t('system')}</span>
          <time className="text-xs text-muted-foreground" dateTime={item.at}>
            {format.datetime(item.at)}
          </time>
          {item.kind === 'note' ? <Badge tone="neutral">{t('note')}</Badge> : null}
          {item.editedAt === null ? null : (
            <span className="text-xs text-muted-foreground">({t('edited')})</span>
          )}
          {editable ? (
            <Menu>
              <MenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="ms-auto size-7"
                  aria-label={t('actions')}
                >
                  <EllipsisVertical aria-hidden />
                </Button>
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem onSelect={() => setEditing(item.text ?? '')}>{t('edit')}</MenuItem>
                <MenuItem onSelect={() => setConfirming(true)}>{t('delete')}</MenuItem>
              </MenuContent>
            </Menu>
          ) : null}
        </p>
        {editing === null ? (
          <div
            className="prose-sm max-w-none break-words text-sm [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_.mention]:rounded [&_.mention]:bg-primary/10 [&_.mention]:px-1 [&_.mention]:text-primary [&_ul]:list-disc [&_ul]:ps-5"
            // Rendered by the server from escaped text (body.ts): no user markup reaches the page.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered, escaped by construction
            dangerouslySetInnerHTML={{ __html: item.body }}
          />
        ) : (
          <div className="grid gap-2">
            <Textarea
              rows={3}
              value={editing}
              aria-label={t('edit')}
              onChange={(e) => setEditing(e.target.value)}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                busy={edit.isPending}
                onClick={() => edit.mutate(editing)}
              >
                {t('save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                {t('cancel')}
              </Button>
            </div>
          </div>
        )}
        <Files api={api} files={item.attachments} />
      </div>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('delete')}
        description={t('deleteConfirm')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              {t('cancel')}
            </Button>
            <Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate()}>
              {t('delete')}
            </Button>
          </>
        }
      />
    </article>
  );
}

function dayOf(at: string): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function Timeline({
  api,
  items,
  onChanged,
}: {
  readonly api: KoshApi;
  readonly items: readonly TimelineItem[];
  readonly onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation('messaging');
  const { format } = useKosh();
  const groups = useMemo(() => {
    const out: { day: string; items: TimelineItem[] }[] = [];
    for (const item of items) {
      const day = dayOf(item.at);
      const last = out.at(-1);
      if (last?.day === day) last.items.push(item);
      else out.push({ day, items: [item] });
    }
    return out;
  }, [items]);
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{t('empty')}</p>;
  const today = isoDay();
  const yesterday = isoDay(-1);
  return (
    <ol className="grid gap-4" aria-label={t('chatter')}>
      {groups.map((g) => (
        <li key={g.day} className="grid gap-2">
          <h4 className="flex items-center gap-3 text-xs font-medium text-muted-foreground">
            <span className="h-px flex-1 bg-border" aria-hidden />
            {g.day === today
              ? t('today')
              : g.day === yesterday
                ? t('yesterday')
                : format.date(g.day)}
            <span className="h-px flex-1 bg-border" aria-hidden />
          </h4>
          <ol className="grid gap-3">
            {g.items.map((item) => (
              <li key={`${item.type}-${item.id}`}>
                {item.type === 'message' ? (
                  <Message api={api} item={item} onChanged={onChanged} />
                ) : (
                  <Change item={item} />
                )}
              </li>
            ))}
          </ol>
        </li>
      ))}
    </ol>
  );
}

/** The chatter component. */
export function Chatter({ record, model, api, version }: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('messaging');
  const queryClient = useQueryClient();
  const id = typeof record?.id === 'number' ? record.id : null;
  const [mode, setMode] = useState<'comment' | 'note' | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const key = ['chatter', model, id, version];
  const page = useInfiniteQuery({
    queryKey: key,
    enabled: id !== null,
    initialPageParam: '' as string,
    queryFn: ({ pageParam }) =>
      api.call<ChatterPage>(
        'GET',
        `/api/v1/chatter/${enc(model)}/${id}${pageParam === '' ? '' : `?${pageParam}`}`,
      ),
    getNextPageParam: (last) =>
      last.next === null
        ? undefined
        : new URLSearchParams(
            Object.entries(last.next).map(([k, v]) => [k, String(v)] as [string, string]),
          ).toString(),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['chatter', model, id] });
  if (id === null) return null;
  if (page.error instanceof ApiError && page.error.status === 403) return null; // no Messaging access
  const first = (page.data as InfiniteData<ChatterPage> | undefined)?.pages[0];
  const items = (page.data?.pages ?? []).flatMap((p) => p.items);
  let body: ReactNode;
  if (page.isPending) body = <Spinner label={t('chatter')} />;
  else if (page.error !== null) body = <Alert tone="danger">{page.error.message}</Alert>;
  else
    body = (
      <>
        <Activities api={api} activities={first?.activities ?? []} onChanged={refresh} />
        <Timeline api={api} items={items} onChanged={refresh} />
        {page.hasNextPage ? (
          <Button
            variant="ghost"
            size="sm"
            className="justify-self-center"
            busy={page.isFetchingNextPage}
            onClick={() => void page.fetchNextPage()}
          >
            {t('older')}
          </Button>
        ) : null}
      </>
    );
  return (
    <section aria-label={t('chatter')} className="grid gap-4 rounded-lg border bg-surface p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={mode === 'comment' ? 'primary' : 'secondary'}
          aria-pressed={mode === 'comment'}
          onClick={() => setMode(mode === 'comment' ? null : 'comment')}
        >
          {t('sendMessage')}
        </Button>
        <Button
          size="sm"
          variant={mode === 'note' ? 'primary' : 'secondary'}
          aria-pressed={mode === 'note'}
          onClick={() => setMode(mode === 'note' ? null : 'note')}
        >
          {t('logNote')}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setScheduling(true)}>
          <ListTodo aria-hidden />
          {t('scheduleActivity')}
        </Button>
        <div className="ms-auto">
          {first === undefined ? null : (
            <Followers api={api} model={model} id={id} page={first} onChanged={refresh} />
          )}
        </div>
      </div>
      {mode === null ? null : (
        <Composer key={mode} api={api} model={model} id={id} kind={mode} onDone={refresh} />
      )}
      <ScheduleDialog
        api={api}
        model={model}
        id={id}
        open={scheduling}
        onOpenChange={setScheduling}
        onDone={refresh}
      />
      {body}
    </section>
  );
}
