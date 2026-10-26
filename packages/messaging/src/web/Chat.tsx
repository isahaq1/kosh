/**
 * The Chat app (RFC 0006 part 6, step 2): a sidebar of pinned, public, group and direct conversations with unread
 * counts, the conversation pane (day separators, grouped messages, reactions, a thread panel, a composer with
 * mentions and files), live through the gateway (changes announced on the channel, typing relayed), and readable
 * offline from the persisted cache. The server decides who sees and may do what; this renders its answers.
 */
import {
  Alert,
  ApiError,
  Badge,
  Button,
  cn,
  Dialog,
  EmptyState,
  Input,
  type KoshApi,
  Label,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  type PageProps,
  Spinner,
  Textarea,
  useKosh,
} from '@kosh/ui';
import {
  type InfiniteData,
  type UseQueryResult,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  ArrowLeft,
  Bell,
  BellOff,
  EllipsisVertical,
  Hash,
  Lock,
  MessageSquareReply,
  MessagesSquare,
  Paperclip,
  Pin,
  Plus,
  Send,
  SmilePlus,
  Users,
  X,
} from 'lucide-react';
import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { ChannelItem, ChatMessageItem } from '../chat.js';
import type { UserRef } from '../chatter.js';
import { Avatar, authorLabel, type FileInfo, Files, MentionArea, withMentions } from './Chatter.js';

const MODEL = 'mail.channel';
const EMOJIS = ['👍', '❤️', '😂', '🎉', '👀', '✅'] as const;
const PROSE =
  'prose-sm max-w-none break-words text-sm [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_.mention]:rounded [&_.mention]:bg-primary/10 [&_.mention]:px-1 [&_.mention]:text-primary [&_ul]:list-disc [&_ul]:ps-5';

interface Page {
  readonly items: readonly ChatMessageItem[];
  readonly next: number | null;
}

/** The caller's channels, live (the list refetches when any channel changes). */
export function useChannels(api: KoshApi): UseQueryResult<{ channels: ChannelItem[] }, Error> {
  const { realtime } = useKosh();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      realtime?.subscribe(`model:${MODEL}`, () => {
        void queryClient.invalidateQueries({ queryKey: ['chat', 'channels'] });
      }),
    [realtime, queryClient],
  );
  return useQuery({
    queryKey: ['chat', 'channels'],
    queryFn: () => api.call<{ channels: ChannelItem[] }>('GET', '/api/v1/chat/channels'),
    retry: false,
  });
}

function dayOf(at: string): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function isoDay(days = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return dayOf(d.toISOString());
}

function ChannelIcon({ channel }: { readonly channel: ChannelItem }): ReactElement {
  if (channel.kind === 'direct') return <Avatar user={channel.direct} />;
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
    >
      {channel.kind === 'channel' ? <Hash className="size-4" /> : <Lock className="size-4" />}
    </span>
  );
}

/** A user picker: a search box with a listbox of names (the combobox pattern). */
function UserPicker({
  api,
  label,
  exclude,
  onPick,
}: {
  readonly api: KoshApi;
  readonly label: string;
  readonly exclude: readonly number[];
  readonly onPick: (user: UserRef) => void;
}): ReactElement {
  const listId = useId();
  const [query, setQuery] = useState('');
  const people = useQuery({
    queryKey: ['names', 'res.users', query],
    queryFn: () => api.names('res.users', { q: query, limit: 8 }),
  });
  const options = (people.data ?? []).filter((u) => !exclude.includes(u.id));
  return (
    <div className="grid gap-1">
      <Input
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={options.length > 0}
        aria-controls={listId}
        placeholder={label}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div id={listId} role="listbox" aria-label={label} className="grid max-h-40 overflow-y-auto">
        {options.map((u) => (
          <div
            key={u.id}
            role="option"
            aria-selected={false}
            tabIndex={0}
            className="cursor-pointer rounded px-2 py-1 text-sm hover:bg-muted"
            onClick={() => onPick({ id: u.id, name: u.displayName })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onPick({ id: u.id, name: u.displayName });
              }
            }}
          >
            {u.displayName}
          </div>
        ))}
      </div>
    </div>
  );
}

function NewGroupDialog({
  api,
  open,
  onOpenChange,
  onCreated,
}: {
  readonly api: KoshApi;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (channel: ChannelItem) => void;
}): ReactElement {
  const { t } = useTranslation('messaging');
  const { uid } = useKosh();
  const id = useId();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'group' | 'channel'>('group');
  const [members, setMembers] = useState<UserRef[]>([]);
  const create = useMutation({
    mutationFn: () =>
      api.call<ChannelItem>('POST', '/api/v1/chat/channels', {
        kind,
        name,
        public: kind === 'channel',
        members: members.map((m) => m.id),
      }),
    onSuccess: (channel) => {
      setName('');
      setMembers([]);
      onOpenChange(false);
      onCreated(channel);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('chat.newGroup')}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            busy={create.isPending}
            disabled={name.trim() === ''}
            onClick={() => create.mutate()}
          >
            {t('chat.create')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <div className="grid gap-1">
          <Label htmlFor={`${id}-name`}>{t('chat.name')}</Label>
          <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <fieldset className="flex gap-2">
          <legend className="sr-only">{t('chat.kind')}</legend>
          <Button
            size="sm"
            variant={kind === 'group' ? 'primary' : 'secondary'}
            aria-pressed={kind === 'group'}
            onClick={() => setKind('group')}
          >
            <Lock aria-hidden /> {t('chat.privateGroup')}
          </Button>
          <Button
            size="sm"
            variant={kind === 'channel' ? 'primary' : 'secondary'}
            aria-pressed={kind === 'channel'}
            onClick={() => setKind('channel')}
          >
            <Hash aria-hidden /> {t('chat.publicChannel')}
          </Button>
        </fieldset>
        <UserPicker
          api={api}
          label={t('chat.addMembers')}
          exclude={[uid, ...members.map((m) => m.id)]}
          onPick={(u) => setMembers((m) => [...m, u])}
        />
        {members.length === 0 ? null : (
          <ul className="flex flex-wrap gap-1" aria-label={t('chat.members')}>
            {members.map((m) => (
              <li key={m.id}>
                <Badge tone="neutral" className="gap-1">
                  {m.name}
                  <button
                    type="button"
                    aria-label={t('chat.removeMember', { name: m.name })}
                    onClick={() => setMembers((list) => list.filter((x) => x.id !== m.id))}
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </Badge>
              </li>
            ))}
          </ul>
        )}
        {create.error === null ? null : <Alert>{create.error.message}</Alert>}
      </div>
    </Dialog>
  );
}

function NewDirectDialog({
  api,
  open,
  onOpenChange,
  onCreated,
}: {
  readonly api: KoshApi;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (channel: ChannelItem) => void;
}): ReactElement {
  const { t } = useTranslation('messaging');
  const { uid } = useKosh();
  const start = useMutation({
    mutationFn: (user: number) =>
      api.call<ChannelItem>('POST', `/api/v1/chat/channels/direct/${user}`),
    onSuccess: (channel) => {
      onOpenChange(false);
      onCreated(channel);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('chat.newMessage')}>
      <div className="grid gap-2">
        <UserPicker
          api={api}
          label={t('chat.to')}
          exclude={[uid]}
          onPick={(u) => start.mutate(u.id)}
        />
        {start.error === null ? null : <Alert>{start.error.message}</Alert>}
      </div>
    </Dialog>
  );
}

/** The composer of a conversation or a thread. */
function ChatComposer({
  api,
  channel,
  parent,
  placeholder,
  autoFocus,
}: {
  readonly api: KoshApi;
  readonly channel: number;
  readonly parent?: number | undefined;
  readonly placeholder: string;
  readonly autoFocus?: boolean;
}): ReactElement {
  const { t } = useTranslation('messaging');
  const { realtime } = useKosh();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState<UserRef[]>([]);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const typedAt = useRef(0);
  const post = useMutation({
    mutationFn: () =>
      api.call<ChatMessageItem>('POST', `/api/v1/chat/channels/${channel}/messages`, {
        text: withMentions(text, mentions),
        parent,
        attachments: files.map((f) => f.id),
      }),
    onSuccess: () => {
      setText('');
      setMentions([]);
      setFiles([]);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['chat', 'messages', channel] });
      void queryClient.invalidateQueries({ queryKey: ['chat', 'channels'] });
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });
  const attach = async (list: FileList | null) => {
    for (const file of Array.from(list ?? [])) {
      setUploading(file.name);
      try {
        const info = await api.upload<FileInfo>(
          `/api/v1/attachments/${MODEL}/${channel}`,
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
  const submit = () => {
    if (text.trim() !== '' && !post.isPending) post.mutate();
  };
  const onChange = (value: string) => {
    setText(value);
    const now = Date.now();
    if (now - typedAt.current > 3000) {
      typedAt.current = now;
      realtime?.sendTyping(MODEL, channel);
    }
  };
  return (
    <div className="grid gap-2 border-t p-3" data-autofocus={autoFocus ? 'true' : undefined}>
      <MentionArea
        api={api}
        value={text}
        onChange={onChange}
        onMention={(u) => setMentions((m) => (m.some((x) => x.id === u.id) ? m : [...m, u]))}
        onSubmit={submit}
        label={placeholder}
        placeholder={placeholder}
      />
      <Files
        api={api}
        files={files}
        onRemove={(file) => {
          setFiles((current) => current.filter((f) => f.id !== file.id));
          void api.call('DELETE', `/api/v1/attachments/${file.id}`).catch(() => undefined);
        }}
      />
      {uploading === null ? null : (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {t('uploading', { name: uploading })}
        </p>
      )}
      {error === null ? null : <Alert>{error}</Alert>}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          busy={post.isPending}
          disabled={text.trim() === ''}
          onClick={submit}
        >
          <Send aria-hidden /> {t('send')}
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
        <span className="ms-auto text-xs text-muted-foreground">{t('chat.sendHint')}</span>
      </div>
    </div>
  );
}

function Reactions({
  api,
  item,
  channel,
}: {
  readonly api: KoshApi;
  readonly item: ChatMessageItem;
  readonly channel: number;
}): ReactElement | null {
  const { t } = useTranslation('messaging');
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (reaction: { emoji: string; mine: boolean }) =>
      reaction.mine
        ? api.call(
            'DELETE',
            `/api/v1/chat/messages/${item.id}/reactions/${encodeURIComponent(reaction.emoji)}`,
          )
        : api.call('POST', `/api/v1/chat/messages/${item.id}/reactions`, {
            emoji: reaction.emoji,
          }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ['chat', 'messages', channel] }),
  });
  if (item.reactions.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1" aria-label={t('chat.reactions')}>
      {item.reactions.map((r) => (
        <li key={r.emoji}>
          <button
            type="button"
            aria-pressed={r.mine}
            aria-label={t('chat.reaction', { emoji: r.emoji, count: r.count })}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs hover:bg-muted',
              r.mine && 'border-primary bg-primary/10',
            )}
            onClick={() => toggle.mutate(r)}
          >
            <span aria-hidden>{r.emoji}</span>
            <span>{r.count}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ChatMessage({
  api,
  item,
  channel,
  canManage,
  compact,
  onReply,
}: {
  readonly api: KoshApi;
  readonly item: ChatMessageItem;
  readonly channel: number;
  readonly canManage: boolean;
  /** Same author as the message right before, within a few minutes: no header. */
  readonly compact: boolean;
  readonly onReply?: ((message: ChatMessageItem) => void) | undefined;
}): ReactElement {
  const { t } = useTranslation('messaging');
  const { format } = useKosh();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['chat', 'messages', channel] });
  const edit = useMutation({
    mutationFn: (text: string) => api.call('PATCH', `/api/v1/chat/messages/${item.id}`, { text }),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.call('DELETE', `/api/v1/chat/messages/${item.id}`),
    onSuccess: refresh,
  });
  const react = useMutation({
    mutationFn: (emoji: string) =>
      api.call('POST', `/api/v1/chat/messages/${item.id}/reactions`, { emoji }),
    onSuccess: refresh,
  });
  const label = `${authorLabel(item, t('system'))}, ${format.datetime(item.at)}`;
  return (
    <article
      className={cn(
        'group relative flex gap-3 rounded-md px-2 py-1 hover:bg-muted/40',
        compact && 'mt-0',
      )}
      aria-label={label}
    >
      {compact ? <span className="w-8 shrink-0" aria-hidden /> : <Avatar user={item.author} />}
      <div className="grid min-w-0 flex-1 gap-1">
        {compact ? null : (
          <p className="flex flex-wrap items-baseline gap-2 text-sm">
            <span className="font-medium">{authorLabel(item, t('system'))}</span>
            <time className="text-xs text-muted-foreground" dateTime={item.at}>
              {format.datetime(item.at)}
            </time>
            {item.editedAt === null ? null : (
              <span className="text-xs text-muted-foreground">({t('edited')})</span>
            )}
          </p>
        )}
        {item.deleted ? (
          <p className="text-sm italic text-muted-foreground">{t('chat.removed')}</p>
        ) : editing === null ? (
          <div
            className={PROSE}
            // Rendered by the server from escaped text (body.ts): no user markup reaches the page.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered, escaped by construction
            dangerouslySetInnerHTML={{ __html: item.body }}
          />
        ) : (
          <div className="grid gap-2">
            <Textarea
              rows={2}
              value={editing}
              aria-label={t('edit')}
              onChange={(e) => setEditing(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) edit.mutate(editing);
                if (e.key === 'Escape') setEditing(null);
              }}
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
        <Reactions api={api} item={item} channel={channel} />
        {onReply !== undefined && item.replyCount > 0 ? (
          <button
            type="button"
            className="justify-self-start text-xs text-primary hover:underline"
            onClick={() => onReply(item)}
          >
            {t('chat.replies', { count: item.replyCount })}
          </button>
        ) : null}
      </div>
      {item.deleted ? null : (
        <div className="absolute -top-3 end-2 hidden items-center gap-0.5 rounded-md border bg-surface p-0.5 shadow-sm group-hover:flex group-focus-within:flex">
          {EMOJIS.slice(0, 3).map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="rounded px-1 text-sm hover:bg-muted"
              aria-label={t('chat.reactWith', { emoji })}
              onClick={() => react.mutate(emoji)}
            >
              {emoji}
            </button>
          ))}
          <Menu>
            <MenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                aria-label={t('chat.moreReactions')}
              >
                <SmilePlus className="size-4" aria-hidden />
              </Button>
            </MenuTrigger>
            <MenuContent align="end">
              {EMOJIS.map((emoji) => (
                <MenuItem key={emoji} onSelect={() => react.mutate(emoji)}>
                  {emoji}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
          {onReply === undefined ? null : (
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label={t('chat.replyInThread')}
              onClick={() => onReply(item)}
            >
              <MessageSquareReply className="size-4" aria-hidden />
            </Button>
          )}
          {item.mine || canManage ? (
            <Menu>
              <MenuTrigger asChild>
                <Button size="icon" variant="ghost" className="size-7" aria-label={t('actions')}>
                  <EllipsisVertical className="size-4" aria-hidden />
                </Button>
              </MenuTrigger>
              <MenuContent align="end">
                {item.mine ? (
                  <MenuItem onSelect={() => setEditing(item.text ?? '')}>{t('edit')}</MenuItem>
                ) : null}
                <MenuItem onSelect={() => remove.mutate()}>{t('delete')}</MenuItem>
              </MenuContent>
            </Menu>
          ) : null}
        </div>
      )}
    </article>
  );
}

/** Messages with day separators; consecutive messages of one author within five minutes share a header. */
function MessageList({
  api,
  items,
  channel,
  canManage,
  onReply,
  label,
}: {
  readonly api: KoshApi;
  /** Oldest first. */
  readonly items: readonly ChatMessageItem[];
  readonly channel: number;
  readonly canManage: boolean;
  readonly onReply?: ((message: ChatMessageItem) => void) | undefined;
  readonly label: string;
}): ReactElement {
  const { t } = useTranslation('messaging');
  const { format } = useKosh();
  const groups = useMemo(() => {
    const out: { day: string; items: ChatMessageItem[] }[] = [];
    for (const item of items) {
      const day = dayOf(item.at);
      const last = out.at(-1);
      if (last?.day === day) last.items.push(item);
      else out.push({ day, items: [item] });
    }
    return out;
  }, [items]);
  const today = isoDay();
  const yesterday = isoDay(-1);
  return (
    <ol className="grid gap-3" aria-label={label}>
      {groups.map((g) => (
        <li key={g.day} className="grid gap-1">
          <h3 className="flex items-center gap-3 py-1 text-xs font-medium text-muted-foreground">
            <span className="h-px flex-1 bg-border" aria-hidden />
            {g.day === today
              ? t('today')
              : g.day === yesterday
                ? t('yesterday')
                : format.date(g.day)}
            <span className="h-px flex-1 bg-border" aria-hidden />
          </h3>
          <ol className="grid">
            {g.items.map((item, i) => {
              const previous = g.items[i - 1];
              const compact =
                previous !== undefined &&
                previous.author?.id === item.author?.id &&
                !previous.deleted &&
                new Date(item.at).getTime() - new Date(previous.at).getTime() < 5 * 60_000;
              return (
                <li key={item.id}>
                  <ChatMessage
                    api={api}
                    item={item}
                    channel={channel}
                    canManage={canManage}
                    compact={compact}
                    onReply={onReply}
                  />
                </li>
              );
            })}
          </ol>
        </li>
      ))}
    </ol>
  );
}

/** Who is typing in the channel, for a few seconds after their last keystroke. */
function useTyping(channel: number): readonly UserRef[] {
  const { realtime, uid } = useKosh();
  const [typing, setTyping] = useState<Map<number, { name: string; until: number }>>(new Map());
  useEffect(() => {
    if (realtime === undefined) return;
    const stop = realtime.onTyping(MODEL, channel, (user) => {
      if (user.uid === uid) return;
      setTyping((m) => new Map(m).set(user.uid, { name: user.name, until: Date.now() + 5000 }));
    });
    const sweep = setInterval(() => {
      setTyping((m) => {
        const now = Date.now();
        if ([...m.values()].every((v) => v.until > now)) return m;
        return new Map([...m].filter(([, v]) => v.until > now));
      });
    }, 1000);
    return () => {
      stop();
      clearInterval(sweep);
    };
  }, [realtime, channel, uid]);
  return [...typing].map(([id, v]) => ({ id, name: v.name }));
}

function ThreadPanel({
  api,
  channel,
  root,
  canManage,
  onClose,
}: {
  readonly api: KoshApi;
  readonly channel: number;
  readonly root: ChatMessageItem;
  readonly canManage: boolean;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useTranslation('messaging');
  const thread = useQuery({
    queryKey: ['chat', 'messages', channel, 'thread', root.id],
    queryFn: () =>
      api.call<Page>(
        'GET',
        `/api/v1/chat/channels/${channel}/messages?thread=${root.id}&limit=100`,
      ),
  });
  return (
    <aside
      aria-label={t('chat.thread')}
      className="flex w-full flex-col border-s bg-surface md:w-96"
    >
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h2 className="text-sm font-semibold">{t('chat.thread')}</h2>
        <Button size="icon" variant="ghost" aria-label={t('chat.closeThread')} onClick={onClose}>
          <X aria-hidden />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        <ChatMessage
          api={api}
          item={root}
          channel={channel}
          canManage={canManage}
          compact={false}
        />
        <div className="my-2 border-t" />
        {thread.isPending ? (
          <Spinner label={t('chat.thread')} />
        ) : (
          <MessageList
            api={api}
            items={thread.data?.items ?? []}
            channel={channel}
            canManage={canManage}
            label={t('chat.thread')}
          />
        )}
      </div>
      <ChatComposer
        api={api}
        channel={channel}
        parent={root.id}
        placeholder={t('chat.replyPlaceholder')}
      />
    </aside>
  );
}

/** One conversation: header, messages (live), typing, composer; a thread panel beside it when open. */
export function Conversation({
  api,
  channel,
  compact = false,
  onBack,
  onClose,
}: {
  readonly api: KoshApi;
  readonly channel: ChannelItem;
  /** The dock's small panel: no thread panel, fewer controls. */
  readonly compact?: boolean;
  readonly onBack?: (() => void) | undefined;
  readonly onClose?: (() => void) | undefined;
}): ReactElement {
  const { t } = useTranslation('messaging');
  const { realtime, uid } = useKosh();
  const queryClient = useQueryClient();
  const id = channel.id;
  const [thread, setThread] = useState<ChatMessageItem | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const page = useInfiniteQuery({
    queryKey: ['chat', 'messages', id],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) =>
      api.call<Page>(
        'GET',
        `/api/v1/chat/channels/${id}/messages?limit=50${pageParam === null ? '' : `&before=${pageParam}`}`,
      ),
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const items = useMemo(
    () =>
      [...((page.data as InfiniteData<Page> | undefined)?.pages ?? [])]
        .flatMap((p) => p.items)
        .reverse(),
    [page.data],
  );
  const typing = useTyping(id);
  // Live: a change on the channel (a post, a reaction, an edit) refetches the tail; our own are already here.
  useEffect(
    () =>
      realtime?.subscribe(`record:${MODEL}:${id}`, (event) => {
        if (event.by === uid) return;
        void queryClient.invalidateQueries({ queryKey: ['chat', 'messages', id] });
      }),
    [realtime, id, uid, queryClient],
  );
  // The read receipt follows what is shown.
  const newest = items.at(-1)?.id;
  const read = useMutation({
    mutationFn: (message: number) =>
      api.call('POST', `/api/v1/chat/channels/${id}/read`, { message }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['chat', 'channels'] }),
  });
  const lastRead = useRef<number | null>(null);
  useEffect(() => {
    if (newest === undefined || !channel.member || lastRead.current === newest) return;
    lastRead.current = newest;
    read.mutate(newest);
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [newest, channel.member, read.mutate]);
  const update = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      api.call('PATCH', `/api/v1/chat/channels/${id}`, values),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['chat', 'channels'] }),
  });
  const join = useMutation({
    mutationFn: () => api.call('POST', `/api/v1/chat/channels/${id}/join`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['chat', 'channels'] }),
  });
  const leave = useMutation({
    mutationFn: () => api.call('POST', `/api/v1/chat/channels/${id}/leave`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['chat', 'channels'] });
      onBack?.();
      onClose?.();
    },
  });
  const title =
    channel.kind === 'direct'
      ? channel.name
      : `${channel.kind === 'channel' ? '#' : ''}${channel.name}`;
  return (
    <div className="flex min-h-0 flex-1">
      <section aria-label={title} className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b px-3 py-2">
          {onBack === undefined ? null : (
            <Button
              size="icon"
              variant="ghost"
              className="md:hidden"
              aria-label={t('chat.back')}
              onClick={onBack}
            >
              <ArrowLeft aria-hidden />
            </Button>
          )}
          <ChannelIcon channel={channel} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{title}</h2>
            {channel.description === null || compact ? null : (
              <p className="truncate text-xs text-muted-foreground">{channel.description}</p>
            )}
          </div>
          {channel.kind === 'direct' || compact ? null : (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Users className="size-3.5" aria-hidden />
              {t('chat.memberCount', { count: channel.memberCount })}
            </span>
          )}
          {channel.member ? (
            <Menu>
              <MenuTrigger asChild>
                <Button size="icon" variant="ghost" aria-label={t('chat.channelActions')}>
                  <EllipsisVertical aria-hidden />
                </Button>
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem onSelect={() => update.mutate({ muted: !channel.muted })}>
                  {channel.muted ? <Bell aria-hidden /> : <BellOff aria-hidden />}
                  {channel.muted ? t('chat.unmute') : t('chat.mute')}
                </MenuItem>
                <MenuItem onSelect={() => update.mutate({ pinned: !channel.pinned })}>
                  <Pin aria-hidden /> {channel.pinned ? t('chat.unpin') : t('chat.pin')}
                </MenuItem>
                {channel.kind === 'direct' ? null : (
                  <>
                    <MenuSeparator />
                    <MenuItem onSelect={() => leave.mutate()}>{t('chat.leave')}</MenuItem>
                  </>
                )}
              </MenuContent>
            </Menu>
          ) : null}
          {onClose === undefined ? null : (
            <Button size="icon" variant="ghost" aria-label={t('chat.close')} onClick={onClose}>
              <X aria-hidden />
            </Button>
          )}
        </header>
        <div className="flex-1 overflow-y-auto px-2 py-3">
          {page.hasNextPage ? (
            <Button
              variant="ghost"
              size="sm"
              className="mb-2 justify-self-center"
              busy={page.isFetchingNextPage}
              onClick={() => void page.fetchNextPage()}
            >
              {t('older')}
            </Button>
          ) : null}
          {page.isPending ? (
            <Spinner label={title} />
          ) : page.error !== null ? (
            <Alert>{page.error.message}</Alert>
          ) : items.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">{t('chat.empty')}</p>
          ) : (
            <MessageList
              api={api}
              items={items}
              channel={id}
              canManage={channel.canManage}
              onReply={compact ? undefined : setThread}
              label={title}
            />
          )}
          <div ref={bottom} />
        </div>
        <p className="h-5 px-3 text-xs text-muted-foreground" aria-live="polite">
          {typing.length === 0
            ? ''
            : t('chat.typing', { names: typing.map((u) => u.name).join(', ') })}
        </p>
        {channel.member ? (
          <ChatComposer
            api={api}
            channel={id}
            placeholder={t('chat.messagePlaceholder', { name: title })}
          />
        ) : (
          <div className="flex items-center justify-between gap-2 border-t p-3">
            <span className="text-sm text-muted-foreground">{t('chat.notMember')}</span>
            <Button variant="primary" busy={join.isPending} onClick={() => join.mutate()}>
              {t('chat.join')}
            </Button>
          </div>
        )}
      </section>
      {thread === null || compact ? null : (
        <ThreadPanel
          api={api}
          channel={id}
          root={thread}
          canManage={channel.canManage}
          onClose={() => setThread(null)}
        />
      )}
    </div>
  );
}

function SidebarSection({
  title,
  channels,
  selected,
  onSelect,
}: {
  readonly title: string;
  readonly channels: readonly ChannelItem[];
  readonly selected: number | null;
  readonly onSelect: (id: number) => void;
}): ReactElement | null {
  const { t } = useTranslation('messaging');
  if (channels.length === 0) return null;
  return (
    <section aria-label={title} className="grid gap-0.5">
      <h3 className="px-2 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <ul>
        {channels.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              aria-current={c.id === selected ? 'page' : undefined}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-muted',
                c.id === selected && 'bg-muted font-medium',
                c.unread > 0 && 'font-semibold',
              )}
              onClick={() => onSelect(c.id)}
            >
              <ChannelIcon channel={c} />
              <span className="min-w-0 flex-1 truncate">
                {c.kind === 'channel' ? '#' : ''}
                {c.name}
              </span>
              {c.muted ? (
                <BellOff className="size-3.5 text-muted-foreground" aria-label={t('chat.muted')} />
              ) : null}
              {c.unread > 0 ? (
                <Badge tone="info" aria-label={t('chat.unread', { count: c.unread })}>
                  {c.unread > 99 ? '99+' : c.unread}
                </Badge>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const SELECTED_KEY = 'kosh.chat.channel';

/** The Chat page. */
export function ChatPage({ api }: PageProps): ReactElement {
  const { t } = useTranslation('messaging');
  const channels = useChannels(api);
  const [selected, setSelected] = useState<number | null>(() => {
    try {
      const stored = sessionStorage.getItem(SELECTED_KEY);
      return stored === null ? null : Number(stored);
    } catch {
      return null;
    }
  });
  const [creating, setCreating] = useState<'group' | 'direct' | null>(null);
  const select = (id: number | null) => {
    setSelected(id);
    try {
      if (id === null) sessionStorage.removeItem(SELECTED_KEY);
      else sessionStorage.setItem(SELECTED_KEY, String(id));
    } catch {
      // storage unavailable: the selection lives for the page
    }
  };
  const list = channels.data?.channels ?? [];
  const current = list.find((c) => c.id === selected) ?? null;
  if (channels.error instanceof ApiError && channels.error.status === 403)
    return (
      <div className="p-4">
        <Alert>{t('chat.noAccess')}</Alert>
      </div>
    );
  const pinned = list.filter((c) => c.pinned);
  const rest = list.filter((c) => !c.pinned);
  let pane: ReactNode;
  if (current !== null)
    pane = (
      <Conversation key={current.id} api={api} channel={current} onBack={() => select(null)} />
    );
  else
    pane = (
      <div className="hidden flex-1 items-center justify-center md:flex">
        <EmptyState
          icon={<MessagesSquare aria-hidden />}
          title={t('chat.pickOne')}
          description={t('chat.pickOneHint')}
        />
      </div>
    );
  return (
    <div className="flex h-[calc(100dvh-8rem)] min-h-96 overflow-hidden rounded-lg border bg-surface">
      <nav
        aria-label={t('chat.conversations')}
        className={cn(
          'w-full shrink-0 flex-col overflow-y-auto border-e p-2 md:flex md:w-72',
          current === null ? 'flex' : 'hidden',
        )}
      >
        <div className="flex items-center justify-between gap-2 px-2 py-1">
          <h1 className="text-base font-semibold">{t('chat.title')}</h1>
          <Menu>
            <MenuTrigger asChild>
              <Button size="icon" variant="ghost" aria-label={t('chat.new')}>
                <Plus aria-hidden />
              </Button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem onSelect={() => setCreating('direct')}>{t('chat.newMessage')}</MenuItem>
              <MenuItem onSelect={() => setCreating('group')}>{t('chat.newGroup')}</MenuItem>
            </MenuContent>
          </Menu>
        </div>
        {channels.isPending ? (
          <Spinner label={t('chat.title')} />
        ) : list.length === 0 ? (
          <p className="p-2 text-sm text-muted-foreground">{t('chat.none')}</p>
        ) : (
          <>
            <SidebarSection
              title={t('chat.pinned')}
              channels={pinned}
              selected={selected}
              onSelect={select}
            />
            <SidebarSection
              title={t('chat.channels')}
              channels={rest.filter((c) => c.kind === 'channel')}
              selected={selected}
              onSelect={select}
            />
            <SidebarSection
              title={t('chat.groups')}
              channels={rest.filter((c) => c.kind === 'group')}
              selected={selected}
              onSelect={select}
            />
            <SidebarSection
              title={t('chat.direct')}
              channels={rest.filter((c) => c.kind === 'direct')}
              selected={selected}
              onSelect={select}
            />
          </>
        )}
      </nav>
      {pane}
      <NewGroupDialog
        api={api}
        open={creating === 'group'}
        onOpenChange={(open) => setCreating(open ? 'group' : null)}
        onCreated={(c) => {
          void channels.refetch();
          select(c.id);
        }}
      />
      <NewDirectDialog
        api={api}
        open={creating === 'direct'}
        onOpenChange={(open) => setCreating(open ? 'direct' : null)}
        onCreated={(c) => {
          void channels.refetch();
          select(c.id);
        }}
      />
    </div>
  );
}
