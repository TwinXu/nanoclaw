import {
  DWClient,
  DWClientDownStream,
  TOPIC_ROBOT,
} from 'dingtalk-stream';

import {
  ASSISTANT_NAME,
  DINGTALK_APP_KEY,
  DINGTALK_APP_SECRET,
  DINGTALK_ROBOT_CODE,
  TRIGGER_PATTERN,
} from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// --- Dedup ---

const DEDUP_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEDUP_MAX_SIZE = 1000;
const DEDUP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

interface DedupEntry {
  ts: number;
}

// --- Message limits ---

const MAX_MESSAGE_LENGTH = 20000; // DingTalk markdown limit

// --- Webhook cache ---

interface CachedWebhook {
  url: string;
  expiresAt: number; // ms timestamp
  isGroup: boolean;
}

// --- Access token cache ---

interface CachedToken {
  token: string;
  expiresAt: number; // ms timestamp
}

// --- Robot message data (parsed from DWClientDownStream.data) ---

export interface DingTalkRobotMessage {
  conversationId: string;
  chatbotCorpId: string;
  chatbotUserId: string;
  msgId: string;
  senderNick: string;
  isAdmin: boolean;
  senderStaffId: string;
  sessionWebhookExpiredTime: number;
  createAt: number;
  senderCorpId: string;
  conversationType: string; // "1" = DM, "2" = group
  senderId: string;
  sessionWebhook: string;
  robotCode: string;
  msgtype: string;
  text?: { content: string };
  richText?: unknown;
  picture?: { picURL: string };
}

// --- Channel implementation ---

export interface DingTalkChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DingTalkChannel implements Channel {
  name = 'dingtalk';
  prefixAssistantName = false;

  private client: DWClient | null = null;
  private connected = false;
  private opts: DingTalkChannelOpts;

  // Dedup: msgId -> timestamp
  private seenMessages = new Map<string, DedupEntry>();
  private lastDedupCleanup = Date.now();

  // Webhook cache: conversationId -> CachedWebhook
  private webhookCache = new Map<string, CachedWebhook>();

  // Access token cache
  private accessToken: CachedToken | null = null;

  // DM sender cache: conversationId -> senderId (needed for OpenAPI DM sends)
  private dmSenderCache = new Map<string, string>();

  constructor(opts: DingTalkChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new DWClient({
      clientId: DINGTALK_APP_KEY,
      clientSecret: DINGTALK_APP_SECRET,
    });

    this.client.registerCallbackListener(TOPIC_ROBOT, (res: DWClientDownStream) => {
      try {
        const msg: DingTalkRobotMessage = JSON.parse(res.data);
        this.handleMessage(msg);
        // Acknowledge receipt to prevent DingTalk server retries (60s window)
        this.client!.socketCallBackResponse(res.headers.messageId, {});
      } catch (err) {
        logger.error({ err, messageId: res.headers?.messageId }, 'Error handling DingTalk message');
      }
    });

    await this.client.connect();
    this.connected = true;

    // Track connection state from DWClient's own flag.
    // DWClient auto-reconnects on WebSocket close, but our flag
    // should reflect the real-time state for isConnected() callers.
    if (this.client) {
      const client = this.client;
      const self = this;
      const origOn = client.on?.bind(client);
      if (origOn) {
        origOn('open', () => { self.connected = true; });
        origOn('close', () => { self.connected = false; });
      }
    }

    logger.info('Connected to DingTalk (Stream Mode)');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const conversationId = jid.replace(/@dingtalk$/, '');

    // Truncate to DingTalk's markdown limit
    const truncated = text.length > MAX_MESSAGE_LENGTH
      ? text.slice(0, MAX_MESSAGE_LENGTH - 20) + '\n\n...(truncated)'
      : text;

    try {
      // Try cached sessionWebhook first (no auth needed, ~2hr TTL)
      const webhook = this.webhookCache.get(conversationId);
      if (webhook && Date.now() < webhook.expiresAt) {
        try {
          await this.sendViaWebhook(webhook.url, truncated);
          logger.info({ jid, length: truncated.length }, 'DingTalk message sent via webhook');
          return;
        } catch (whErr) {
          logger.warn({ jid, err: whErr }, 'Webhook send failed, falling back to OpenAPI');
        }
      }

      // Fallback to OpenAPI with access token
      const isGroup = this.webhookCache.get(conversationId)?.isGroup ?? true;
      if (isGroup) {
        await this.sendViaOpenAPI(conversationId, truncated);
      } else {
        await this.sendDmViaOpenAPI(conversationId, truncated);
      }
      logger.info({ jid, length: truncated.length, isGroup }, 'DingTalk message sent via OpenAPI');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send DingTalk message');
    }
  }

  isConnected(): boolean {
    // Check DWClient's own connected flag if available, fall back to ours
    if (this.client && 'connected' in this.client) {
      return (this.client as any).connected as boolean;
    }
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@dingtalk');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this.connected = false;
    logger.info('DingTalk client disconnected');
  }

  // --- Internal ---

  private handleMessage(msg: DingTalkRobotMessage): void {
    // Dedup
    if (!this.tryRecordMessage(msg.msgId)) {
      logger.debug({ msgId: msg.msgId }, 'DingTalk message deduplicated');
      return;
    }

    const jid = `${msg.conversationId}@dingtalk`;
    const timestamp = new Date(msg.createAt).toISOString();
    const isGroup = msg.conversationType === '2';

    // Cache sessionWebhook for sending responses (includes conversation type for OpenAPI fallback)
    if (msg.sessionWebhook) {
      this.webhookCache.set(msg.conversationId, {
        url: msg.sessionWebhook,
        expiresAt: msg.sessionWebhookExpiredTime,
        isGroup,
      });
    }

    // Cache sender for DM conversations (needed for OpenAPI DM sends)
    if (!isGroup) {
      this.dmSenderCache.set(msg.conversationId, msg.senderStaffId || msg.senderId);
    }

    // Extract text content
    let content = this.extractContent(msg);

    // In group chats, DingTalk Stream mode only delivers @bot messages.
    // Prepend trigger so TRIGGER_PATTERN matches (same approach as Telegram).
    if (isGroup && !TRIGGER_PATTERN.test(content.trim())) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    // Notify metadata
    this.opts.onChatMetadata(jid, timestamp, undefined, 'dingtalk', isGroup);

    // Only deliver full message for registered groups
    const groups = this.opts.registeredGroups();
    if (groups[jid]) {
      this.opts.onMessage(jid, {
        id: msg.msgId,
        chat_jid: jid,
        sender: msg.senderId,
        sender_name: msg.senderNick || msg.senderId,
        content,
        timestamp,
        is_from_me: false,
        is_bot_mentioned: true,
      });
    }
  }

  /** Parse message content. Returns plain text. */
  private extractContent(msg: DingTalkRobotMessage): string {
    if (msg.msgtype === 'text' && msg.text) {
      return msg.text.content.trim();
    }
    if (msg.msgtype === 'richText') {
      return '[richText message]';
    }
    if (msg.msgtype === 'picture') {
      return '[picture message]';
    }
    return `[${msg.msgtype} message]`;
  }

  // --- Send methods ---

  private async sendViaWebhook(webhookUrl: string, text: string): Promise<void> {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: {
          title: ASSISTANT_NAME,
          text,
        },
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Webhook send failed: ${resp.status} ${body}`);
    }

    const result = await resp.json() as { errcode?: number; errmsg?: string };
    if (result.errcode && result.errcode !== 0) {
      throw new Error(`Webhook send error: ${result.errcode} ${result.errmsg}`);
    }
  }

  private async sendViaOpenAPI(conversationId: string, text: string): Promise<void> {
    const token = await this.getAccessToken();

    const resp = await fetch('https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify({
        msgParam: JSON.stringify({ title: ASSISTANT_NAME, text }),
        msgKey: 'sampleMarkdown',
        openConversationId: conversationId,
        robotCode: DINGTALK_ROBOT_CODE,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`OpenAPI send failed: ${resp.status} ${body}`);
    }
  }

  private async sendDmViaOpenAPI(conversationId: string, text: string): Promise<void> {
    const token = await this.getAccessToken();

    // DingTalk DM (1:1) messages use batchSend with userIds.
    // We store the senderId from incoming DM messages for this purpose.
    const senderUserId = this.dmSenderCache.get(conversationId);
    if (!senderUserId) {
      throw new Error(`No cached sender for DM conversation ${conversationId}, cannot send via OpenAPI`);
    }

    const resp = await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify({
        msgParam: JSON.stringify({ title: ASSISTANT_NAME, text }),
        msgKey: 'sampleMarkdown',
        robotCode: DINGTALK_ROBOT_CODE,
        userIds: [senderUserId],
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`OpenAPI DM send failed: ${resp.status} ${body}`);
    }
  }

  /** Fetch or return cached DingTalk access token. */
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    // Return cached if still valid (5-min pre-expiry buffer)
    if (this.accessToken && now < this.accessToken.expiresAt - 5 * 60 * 1000) {
      return this.accessToken.token;
    }

    const resp = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appKey: DINGTALK_APP_KEY,
        appSecret: DINGTALK_APP_SECRET,
      }),
    });

    if (!resp.ok) {
      throw new Error(`Failed to get DingTalk access token: ${resp.status}`);
    }

    const data = await resp.json() as { accessToken: string; expireIn: number };
    this.accessToken = {
      token: data.accessToken,
      expiresAt: now + data.expireIn * 1000,
    };

    return data.accessToken;
  }

  // --- Dedup ---

  /**
   * Record a msgId, return true if new (not seen before).
   * Periodically cleans up stale entries.
   */
  private tryRecordMessage(msgId: string): boolean {
    const now = Date.now();

    // Periodic cleanup
    if (now - this.lastDedupCleanup > DEDUP_CLEANUP_INTERVAL_MS) {
      this.cleanupDedup(now);
      this.lastDedupCleanup = now;
    }

    if (this.seenMessages.has(msgId)) return false;

    // Evict oldest if at capacity
    if (this.seenMessages.size >= DEDUP_MAX_SIZE) {
      const oldestKey = this.seenMessages.keys().next().value;
      if (oldestKey) this.seenMessages.delete(oldestKey);
    }

    this.seenMessages.set(msgId, { ts: now });
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
