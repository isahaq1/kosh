/** Inbound email (RFC 0006 part 7). */
export {
  attachInbound,
  discardInbound,
  type InboundContext,
  type InboundItem,
  type InboundOutcome,
  listInbound,
  processInbound,
  receiveMail,
  retryInbound,
} from './handle.js';
export { INBOUND_STATES, type InboundState, mailShutro } from './models.js';
export {
  bodyText,
  cleanHtml,
  cutQuotes,
  fromPostmark,
  htmlToText,
  type InboundAddress,
  type InboundAttachment,
  type InboundMail,
  MAX_TEXT as MAX_INBOUND_TEXT,
  parseInbound,
  parseMail,
} from './parse.js';
export { registerInboundRoutes } from './routes.js';
export {
  type InboundConfig,
  inboundConfigFromEnv,
  parseReplyAddress,
  type ReplyTarget,
  replyAddress,
} from './token.js';
