import * as Lark from '@larksuiteoapi/node-sdk';

import {
  ASSISTANT_NAME,
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  FEISHU_DOMAIN,
} from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

// --- Dedup ---

const DEDUP_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEDUP_MAX_SIZE = 1000;
const DEDUP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

interface DedupEntry {
  ts: number;
}

// --- Name cache ---

const NAME_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface CachedName {
  name: string;
  ts: number;
}

// --- Feishu message event type ---

export interface FeishuMessageEvent {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    chat_id: string;
    chat_type: 'p2p' | 'group';
    message_type: string;
    content: string; // JSON-encoded
    mentions?: Array<{
      key: string;
      id: { open_id?: string; user_id?: string; union_id?: string };
      name: string;
      tenant_key?: string;
    }>;
  };
}

// --- Channel implementation ---

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class FeishuChannel implements Channel {
  name = 'feishu';
  prefixAssistantName = false;

  private client!: Lark.Client;
  private wsClient!: Lark.WSClient;
  private connected = false;
  private botOpenId = '';
  private opts: FeishuChannelOpts;

  // Dedup: message_id -> timestamp
  private seenMessages = new Map<string, DedupEntry>();
  private lastDedupCleanup = Date.now();

  // Name caches
  private senderNames = new Map<string, CachedName>();
  private chatNames = new Map<string, CachedName>();

  constructor(opts: FeishuChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const domain =
      FEISHU_DOMAIN === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;

    this.client = new Lark.Client({
      appId: FEISHU_APP_ID,
      appSecret: FEISHU_APP_SECRET,
      appType: Lark.AppType.SelfBuild,
      domain,
    });

    // Fetch bot identity via raw API (no typed accessor for bot.info)
    try {
      const resp = await this.client.request<{ bot?: { open_id?: string } }>({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });
      this.botOpenId = resp?.bot?.open_id || '';
      logger.info({ botOpenId: this.botOpenId }, 'Feishu bot identity resolved');
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch Feishu bot info, mention matching may not work');
    }

    // Set up event dispatcher
    const eventDispatcher = new Lark.EventDispatcher({});

    eventDispatcher.register({
      'im.message.receive_v1': async (data: unknown) => {
        const event = data as FeishuMessageEvent;
        try {
          await this.handleMessage(event);
        } catch (err) {
          logger.error({ err, messageId: event?.message?.message_id }, 'Error handling Feishu message');
        }
      },
    });

    // Start WebSocket client
    this.wsClient = new Lark.WSClient({
      appId: FEISHU_APP_ID,
      appSecret: FEISHU_APP_SECRET,
      domain,
      loggerLevel: Lark.LoggerLevel.info,
    });

    this.wsClient.start({ eventDispatcher });

    // Note: WSClient.start() is fire-and-forget — the WS may not be fully
    // connected yet. The Lark SDK handles reconnection internally.
    // We mark connected=true here because the REST API (used for sendMessage)
    // is available immediately; inbound messages will arrive once WS is ready.
    this.connected = true;
    logger.info('Connected to Feishu (WS client started, REST API ready)');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.replace(/@feishu$/, '');

    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      });
      logger.info({ jid, length: text.length }, 'Feishu message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Feishu message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@feishu');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    // WSClient doesn't expose a stop method — connection will be GC'd
  }

  // --- Internal ---

  private async handleMessage(event: FeishuMessageEvent): Promise<void> {
    const msg = event.message;
    if (!msg) return;

    // Skip bot's own messages to prevent self-triggering
    const senderOpenId = event.sender?.sender_id?.open_id || '';
    if (this.botOpenId && senderOpenId === this.botOpenId) return;

    // Dedup
    if (!this.tryRecordMessage(msg.message_id)) {
      logger.debug({ messageId: msg.message_id }, 'Feishu message deduplicated');
      return;
    }

    const jid = `${msg.chat_id}@feishu`;
    const timestamp = new Date().toISOString();

    // Extract text content
    const rawContent = this.parseMessageContent(msg.content, msg.message_type);

    // Process mentions: replace bot mention with @AssistantName, others with @Name
    const content = this.processMentions(rawContent, msg.mentions);

    // Resolve sender name (senderOpenId already extracted above for bot check)
    const senderName = await this.resolveSenderName(senderOpenId);

    // Resolve chat name on first encounter
    const chatName = await this.resolveChatName(msg.chat_id);

    // Always notify about metadata
    this.opts.onChatMetadata(jid, timestamp, chatName || undefined);

    // Only deliver full message for registered groups
    const groups = this.opts.registeredGroups();
    if (groups[jid]) {
      this.opts.onMessage(jid, {
        id: msg.message_id,
        chat_jid: jid,
        sender: senderOpenId,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false, // Bot's own messages are filtered above
      });
    }
  }

  /** Parse message content from JSON. Returns plain text. */
  parseMessageContent(content: string, messageType: string): string {
    try {
      const parsed = JSON.parse(content);
      if (messageType === 'text') {
        return parsed.text || '';
      }
      if (messageType === 'post') {
        return this.parsePostContent(parsed);
      }
      // Unsupported types: image, file, audio, video, etc.
      return `[${messageType} message]`;
    } catch {
      return content;
    }
  }

  /** Extract flat text from post (rich text) content. */
  private parsePostContent(parsed: Record<string, unknown>): string {
    // Post content structure: { title: "...", content: [[{tag, text}, ...], ...] }
    // Or localized: { zh_cn: { title, content }, en_us: { title, content } }
    const parts: string[] = [];

    const extractFromContent = (content: unknown) => {
      if (!Array.isArray(content)) return;
      for (const paragraph of content) {
        if (!Array.isArray(paragraph)) continue;
        for (const element of paragraph) {
          if (element && typeof element === 'object' && 'text' in element) {
            parts.push((element as { text: string }).text);
          }
        }
      }
    };

    if (parsed.title) parts.push(String(parsed.title));
    if (parsed.content) {
      extractFromContent(parsed.content);
    } else {
      // Try localized versions
      for (const locale of Object.values(parsed)) {
        if (locale && typeof locale === 'object' && 'content' in (locale as Record<string, unknown>)) {
          const loc = locale as { title?: string; content: unknown };
          if (loc.title && !parts.includes(loc.title)) parts.push(loc.title);
          extractFromContent(loc.content);
          break; // Use first locale found
        }
      }
    }

    return parts.join(' ').trim() || '[post message]';
  }

  /**
   * Process mentions in message text.
   * Feishu puts @_user_N placeholders in text, and mentions[] maps them.
   * - Bot mentions → @{ASSISTANT_NAME} (so trigger pattern works)
   * - Other mentions → @{name}
   */
  processMentions(
    text: string,
    mentions?: FeishuMessageEvent['message']['mentions'],
  ): string {
    if (!mentions || mentions.length === 0) return text;

    let result = text;
    for (const mention of mentions) {
      const isBotMention =
        this.botOpenId && mention.id.open_id === this.botOpenId;
      const replacement = isBotMention
        ? `@${ASSISTANT_NAME}`
        : `@${mention.name}`;

      // Replace the @_user_N placeholder key
      if (mention.key) {
        result = result.replace(mention.key, replacement);
      }
    }

    return result;
  }

  /** Resolve sender display name by open_id, with caching. */
  private async resolveSenderName(openId: string): Promise<string> {
    if (!openId) return 'Unknown';

    const cached = this.senderNames.get(openId);
    if (cached && Date.now() - cached.ts < NAME_CACHE_TTL_MS) {
      return cached.name;
    }

    try {
      const resp = await this.client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      });
      const name = resp?.data?.user?.name || openId;
      this.senderNames.set(openId, { name, ts: Date.now() });
      return name;
    } catch (err) {
      logger.debug({ openId, err }, 'Failed to resolve Feishu sender name');
      // Cache the fallback to avoid repeated failures
      this.senderNames.set(openId, { name: openId, ts: Date.now() });
      return openId;
    }
  }

  /** Resolve chat name by chat_id, with caching. */
  private async resolveChatName(chatId: string): Promise<string | null> {
    const cached = this.chatNames.get(chatId);
    if (cached && Date.now() - cached.ts < NAME_CACHE_TTL_MS) {
      return cached.name;
    }

    try {
      const resp = await this.client.im.chat.get({
        path: { chat_id: chatId },
      });
      const name = resp?.data?.name || null;
      if (name) {
        this.chatNames.set(chatId, { name, ts: Date.now() });
      }
      return name;
    } catch (err) {
      logger.debug({ chatId, err }, 'Failed to resolve Feishu chat name');
      return null;
    }
  }

  /**
   * Dedup: record a message_id, return true if new (not seen before).
   * Periodically cleans up stale entries.
   */
  private tryRecordMessage(messageId: string): boolean {
    const now = Date.now();

    // Periodic cleanup
    if (now - this.lastDedupCleanup > DEDUP_CLEANUP_INTERVAL_MS) {
      this.cleanupDedup(now);
      this.lastDedupCleanup = now;
    }

    if (this.seenMessages.has(messageId)) return false;

    // Evict oldest if at capacity
    if (this.seenMessages.size >= DEDUP_MAX_SIZE) {
      const oldestKey = this.seenMessages.keys().next().value;
      if (oldestKey) this.seenMessages.delete(oldestKey);
    }

    this.seenMessages.set(messageId, { ts: now });
    return true;
  }

  private cleanupDedup(now: number): void {
    for (const [key, entry] of this.seenMessages) {
      if (now - entry.ts > DEDUP_TTL_MS) {
        this.seenMessages.delete(key);
      }
    }
  }
}
