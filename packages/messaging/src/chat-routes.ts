/**
 * Chat routes (RFC 0006 part 6). Every route reads the channel as the caller first (404 when the rules hide it)
 * and checks membership for what members do.
 *
 * - `GET    /api/v1/chat/channels`                        mine and the public ones, with unread counts
 * - `POST   /api/v1/chat/channels`                        `{ kind: 'group' | 'channel', name, description?, public?, members? }`
 * - `POST   /api/v1/chat/channels/direct/:user`           the direct conversation with a user (made on first use)
 * - `GET    /api/v1/chat/channels/:id`                    one channel
 * - `PATCH  /api/v1/chat/channels/:id`                    `{ name?, description?, add?, remove?, muted?, pinned? }`
 * - `POST   /api/v1/chat/channels/:id/join|leave`
 * - `GET    /api/v1/chat/channels/:id/messages?before=&limit=&thread=`
 * - `POST   /api/v1/chat/channels/:id/messages`           `{ text, parent? }`
 * - `POST   /api/v1/chat/channels/:id/read`               `{ message? }` the read receipt
 * - `PATCH  /api/v1/chat/messages/:id`                    `{ text }` (its author)
 * - `DELETE /api/v1/chat/messages/:id`                    (its author, the channel's creator or a manager)
 * - `POST   /api/v1/chat/messages/:id/reactions`          `{ emoji }`; `DELETE …/reactions/:emoji`
 */
import type { ModuleContext } from '@kosh/server';
import { positive } from '@kosh/storage';
import type { FastifyRequest } from 'fastify';
import {
  type ChatContext,
  channelItem,
  channelMessages,
  createChannel,
  deleteChatMessage,
  directChannel,
  editChatMessage,
  joinChannel,
  leaveChannel,
  markRead,
  myChannels,
  postChatMessage,
  react,
  unreact,
  updateChannel,
} from './chat.js';
import { pageSize } from './chatter.js';
import { chatterContext } from './routes.js';

type Body = Record<string, unknown>;
const bodyOf = (request: FastifyRequest): Body => {
  const body = request.body;
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Body) : {};
};
const idOf = (request: FastifyRequest, key = 'id'): number =>
  positive((request.params as Record<string, unknown>)[key], key);

/** Registers the chat routes. */
export function registerChatRoutes(context: ModuleContext): void {
  const { app } = context;
  const chat: ChatContext = { ...chatterContext(context), driver: context.driver };

  app.get('/api/v1/chat/channels', async (request) =>
    request.env(async (env) => ({ channels: await myChannels(env) })),
  );

  app.post('/api/v1/chat/channels', async (request, reply) => {
    const channel = await request.env((env) => createChannel(env, bodyOf(request)));
    return reply.code(201).send(channel);
  });

  app.post('/api/v1/chat/channels/direct/:user', async (request) => {
    const user = idOf(request, 'user');
    return request.env((env) => directChannel(env, user));
  });

  app.get('/api/v1/chat/channels/:id', async (request) => {
    const id = idOf(request);
    return request.env((env) => channelItem(env, id));
  });

  app.patch('/api/v1/chat/channels/:id', async (request) => {
    const id = idOf(request);
    return request.env((env) => updateChannel(env, id, bodyOf(request)));
  });

  app.post('/api/v1/chat/channels/:id/join', async (request) => {
    const id = idOf(request);
    return request.env((env) => joinChannel(env, id));
  });

  app.post('/api/v1/chat/channels/:id/leave', async (request, reply) => {
    const id = idOf(request);
    await request.env((env) => leaveChannel(env, id));
    return reply.code(204).send();
  });

  app.get('/api/v1/chat/channels/:id/messages', async (request) => {
    const id = idOf(request);
    const query = request.query as Record<string, unknown>;
    return request.env((env) =>
      channelMessages(env, chat, id, {
        before: query['before'] === undefined ? undefined : positive(query['before'], 'before'),
        thread: query['thread'] === undefined ? undefined : positive(query['thread'], 'thread'),
        limit: pageSize(query['limit'], 50),
      }),
    );
  });

  app.post('/api/v1/chat/channels/:id/messages', async (request, reply) => {
    const id = idOf(request);
    const message = await request.env((env) => postChatMessage(env, chat, id, bodyOf(request)));
    return reply.code(201).send(message);
  });

  app.post('/api/v1/chat/channels/:id/read', async (request) => {
    const id = idOf(request);
    const body = bodyOf(request);
    return request.env((env) =>
      markRead(
        env,
        id,
        body['message'] === undefined ? undefined : positive(body['message'], 'message'),
      ),
    );
  });

  app.patch('/api/v1/chat/messages/:id', async (request) => {
    const id = idOf(request);
    return request.env((env) => editChatMessage(env, chat, id, bodyOf(request)));
  });

  app.delete('/api/v1/chat/messages/:id', async (request, reply) => {
    const id = idOf(request);
    await request.env((env) => deleteChatMessage(env, chat, id));
    return reply.code(204).send();
  });

  app.post('/api/v1/chat/messages/:id/reactions', async (request) => {
    const id = idOf(request);
    return request.env(async (env) => ({
      reactions: await react(env, chat, id, bodyOf(request)['emoji']),
    }));
  });

  app.delete('/api/v1/chat/messages/:id/reactions/:emoji', async (request) => {
    const id = idOf(request);
    const emoji = decodeURIComponent(String((request.params as { emoji: string }).emoji));
    return request.env(async (env) => ({ reactions: await unreact(env, chat, id, emoji) }));
  });
}
