import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

import {
  ASSISTANT_NAME,
  TRIGGER_PATTERN,
  WECOM_RELAY_URL,
  WECOM_CORP_ID,
  WECOM_AGENT_ID,
  WECOM_WS_TOKEN,
  WECOM_BOT_WEBHOOK_URL,
  WECOM_BOT_WEBHOOK_JID,
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

const MAX_BOT_WEBHOOK_LENGTH = 2048; // Bot webhook text limit
const MAX_AGENT_API_LENGTH = 20000;  // Agent API text message limit (generous)

// --- Reconnect ---

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;

// --- Relay WebSocket message types ---

interface RelayInboundMessage {
  type: 'message';
  corp_id: string;
  msg_id: string;
  msg_type: string;
  from_user: string;
  chat_id: string;
  chat_type: 'single' | 'group';
  content: string;
  xml_raw: string;
  timestamp: number;
}

interface RelaySendResult {
  type: 'send_result';
  req_id: string;
  status: number;
  body: { errcode?: number; errmsg?: string; [key: string]: unknown } | null;
}

type RelayMessage = RelayInboundMessage | RelaySendResult;

// --- Pending API request tracking ---

interface PendingRequest {
  resolve: (result: RelaySendResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const API_REQUEST_TIMEOUT_MS = 30_000;

// --- Channel implementation ---

export interface WeComChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WeComChannel implements Channel {
  name = 'wecom';
  prefixAssistantName = false;

  private ws: WebSocket | null = null;
  private connected = false;
  private opts: WeComChannelOpts;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  // Dedup: msgId -> timestamp
  private seenMessages = new Map<string, DedupEntry>();
  private lastDedupCleanup = Date.now();

  // Pending API proxy requests: reqId -> callbacks
  private pendingRequests = new Map<string, PendingRequest>();

  // Chat type cache: jid -> 'group' | 'single' (populated from inbound messages)
  private chatTypeCache = new Map<string, 'group' | 'single'>();

  constructor(opts: WeComChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    try {
      await this.doConnect();
    } catch (err) {
      // Don't crash NanoClaw if relay is temporarily unreachable at startup.
      // Schedule reconnect and let other channels proceed.
      logger.warn({ err }, 'WeCom relay initial connection failed, will retry in background');
      this.scheduleReconnect();
    }
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${WECOM_RELAY_URL}/ws?corp_id=${encodeURIComponent(WECOM_CORP_ID)}&token=${encodeURIComponent(WECOM_WS_TOKEN)}`;

      this.ws = new WebSocket(url);
      let resolved = false;

      this.ws.on('open', () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        logger.info('Connected to WeCom relay');
        if (!resolved) {
          resolved = true;
          resolve();
        }
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg: RelayMessage = JSON.parse(data.toString());
          if (msg.type === 'message') {
            this.handleMessage(msg as RelayInboundMessage);
          } else if (msg.type === 'send_result') {
            this.handleSendResult(msg as RelaySendResult);
          }
        } catch (err) {
          logger.error({ err }, 'Error parsing WeCom relay message');
        }
      });

      this.ws.on('close', () => {
        this.connected = false;
        logger.warn('WeCom relay WebSocket closed');
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        logger.error({ err }, 'WeCom relay WebSocket error');
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;
    logger.info({ delay, attempt: this.reconnectAttempts }, 'Scheduling WeCom relay reconnect');
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.doConnect();
      } catch (err) {
        logger.error({ err }, 'WeCom relay reconnect failed');
        this.scheduleReconnect();
      }
    }, delay);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const { chatId, chatType } = this.parseJid(jid);
    const useBotWebhook = chatType === 'group' && WECOM_BOT_WEBHOOK_URL && (!WECOM_BOT_WEBHOOK_JID || jid === WECOM_BOT_WEBHOOK_JID);

    // Apply appropriate length limit based on send method
    const maxLen = useBotWebhook ? MAX_BOT_WEBHOOK_LENGTH : MAX_AGENT_API_LENGTH;
    const truncated = text.length > maxLen
      ? text.slice(0, maxLen - 20) + '\n\n...(truncated)'
      : text;

    try {
      // Try Bot webhook first for the specific group it's bound to (simpler, no auth needed)
      if (useBotWebhook) {
        try {
          await this.sendViaBotWebhook(truncated);
          logger.info({ jid, length: truncated.length }, 'WeCom message sent via Bot webhook');
          return;
        } catch (whErr) {
          logger.warn({ jid, err: whErr }, 'Bot webhook send failed, falling back to Agent API');
        }
      }

      // Fallback: Agent API via relay proxy
      if (chatType === 'group') {
        await this.sendToGroup(chatId, truncated);
      } else {
        await this.sendToUser(chatId, truncated);
      }
      logger.info({ jid, length: truncated.length, chatType }, 'WeCom message sent via Agent API');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send WeCom message');
    }
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@wecom');
  }

  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Reject all pending requests
    for (const [reqId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Channel disconnecting'));
      this.pendingRequests.delete(reqId);
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    logger.info('WeCom channel disconnected');
  }

  // --- Inbound message handling ---

  private handleMessage(msg: RelayInboundMessage): void {
    if (!this.tryRecordMessage(msg.msg_id)) {
      logger.debug({ msgId: msg.msg_id }, 'WeCom message deduplicated');
      return;
    }

    const isGroup = msg.chat_type === 'group';
    const jid = isGroup
      ? `${msg.chat_id}@wecom`
      : `${msg.from_user}@wecom`;
    const timestamp = new Date(msg.timestamp * 1000).toISOString();

    let content = this.extractContent(msg);

    // In group chats, prepend trigger if not already present
    if (isGroup && !TRIGGER_PATTERN.test(content.trim())) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    logger.debug({ msgId: msg.msg_id, msgType: msg.msg_type, chatType: msg.chat_type, jid }, 'WeCom message received');

    // Cache chat type for outbound routing
    this.chatTypeCache.set(jid, isGroup ? 'group' : 'single');

    // Notify metadata
    this.opts.onChatMetadata(jid, timestamp, undefined, 'wecom', isGroup);

    // Only deliver full message for registered groups
    const groups = this.opts.registeredGroups();
    if (groups[jid]) {
      this.opts.onMessage(jid, {
        id: msg.msg_id,
        chat_jid: jid,
        sender: msg.from_user,
        sender_name: msg.from_user,
        content,
        timestamp,
        is_from_me: false,
        is_bot_mentioned: true,
      });
    }
  }

  private extractContent(msg: RelayInboundMessage): string {
    switch (msg.msg_type) {
      case 'text':
        return msg.content || '[empty message]';
      case 'image':
        return `[图片 image_key=${msg.content} message_id=${msg.msg_id}]`;
      case 'voice':
        return `[语音消息 media_id=${msg.content}]`;
      case 'video':
        return `[视频消息 media_id=${msg.content}]`;
      case 'file':
        return `[文件 file_key=${msg.content} message_id=${msg.msg_id}]`;
      case 'location':
        return `[位置消息]`;
      case 'link_click':
        return `[链接点击]`;
      default:
        return `[${msg.msg_type} message]`;
    }
  }

  // --- Send result handling ---

  private handleSendResult(result: RelaySendResult): void {
    const pending = this.pendingRequests.get(result.req_id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(result.req_id);
      pending.resolve(result);
    }
  }

  // --- Send methods ---

  /** Send via Bot webhook (group messages only, no auth needed). */
  private async sendViaBotWebhook(text: string): Promise<void> {
    const resp = await fetch(WECOM_BOT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'text',
        text: { content: text },
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Bot webhook send failed: ${resp.status} ${body}`);
    }

    const result = await resp.json() as { errcode?: number; errmsg?: string };
    if (result.errcode && result.errcode !== 0) {
      throw new Error(`Bot webhook error: ${result.errcode} ${result.errmsg}`);
    }
  }

  /** Send text to a group chat via Agent API (proxied through relay). */
  private async sendToGroup(chatId: string, text: string): Promise<void> {
    const result = await this.proxyApiCall('POST', '/cgi-bin/appchat/send', {
      chatid: chatId,
      msgtype: 'text',
      text: { content: text },
    });

    if (result.body?.errcode && result.body.errcode !== 0) {
      throw new Error(`Agent API group send error: ${result.body.errcode} ${result.body.errmsg}`);
    }
  }

  /** Send text to a single user via Agent API (proxied through relay). */
  private async sendToUser(userId: string, text: string): Promise<void> {
    const result = await this.proxyApiCall('POST', '/cgi-bin/message/send', {
      touser: userId,
      msgtype: 'text',
      agentid: parseInt(WECOM_AGENT_ID, 10),
      text: { content: text },
    });

    if (result.body?.errcode && result.body.errcode !== 0) {
      throw new Error(`Agent API user send error: ${result.body.errcode} ${result.body.errmsg}`);
    }
  }

  /** Download media from WeCom via relay proxy. */
  async downloadMedia(
    messageId: string,
    fileKey: string,
    destDir: string,
    requestId: string,
    mediaType?: string,
  ): Promise<string | null> {
    try {
      const result = await this.proxyApiCall('GET', `/cgi-bin/media/get?media_id=${fileKey}`, undefined);

      if (result.status !== 200) {
        logger.error({ messageId, fileKey, status: result.status }, 'Failed to download WeCom media');
        return null;
      }

      // Media download via relay proxy needs binary support which the
      // current text-frame protocol doesn't handle yet.
      logger.warn({ messageId, fileKey }, 'WeCom media download via relay proxy not yet supported for binary content');
      return null;
    } catch (err) {
      logger.error({ messageId, fileKey, err }, 'Failed to download WeCom media');
      return null;
    }
  }

  /** Send an image file to a WeCom chat via Agent API. */
  async sendImage(jid: string, filePath: string, caption?: string): Promise<void> {
    // Image sending requires media upload → relay binary support.
    // For now, send caption as text if provided.
    logger.warn({ jid, filePath }, 'WeCom image sending not yet supported, sending caption as text');
    if (caption) {
      await this.sendMessage(jid, caption);
    }
  }

  /** Send a file attachment to a WeCom chat via Agent API. */
  async sendFile(jid: string, filePath: string, fileName: string): Promise<void> {
    // File sending requires media upload → relay binary support.
    logger.warn({ jid, filePath, fileName }, 'WeCom file sending not yet supported');
  }

  // --- Relay API proxy ---

  /** Send an API request through the relay's proxy and wait for the response. */
  private proxyApiCall(method: string, path: string, body?: any): Promise<RelaySendResult> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WeCom relay not connected'));
        return;
      }

      const reqId = randomUUID();
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        reject(new Error(`WeCom API proxy timeout for ${method} ${path}`));
      }, API_REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(reqId, { resolve, reject, timer });

      const msg: any = {
        type: 'send',
        req_id: reqId,
        method,
        path,
      };
      if (body !== undefined) {
        msg.body = body;
      }

      this.ws.send(JSON.stringify(msg));
    });
  }

  // --- JID helpers ---

  private parseJid(jid: string): { chatId: string; chatType: 'group' | 'single' } {
    const id = jid.replace(/@wecom$/, '');
    // Use cached chat type from inbound messages (reliable).
    // Falls back to 'single' if never seen — Agent API /cgi-bin/message/send
    // works for both users and group members, so this is a safe default.
    const chatType = this.chatTypeCache.get(jid) ?? 'single';
    return { chatId: id, chatType };
  }

  // --- Dedup ---

  private tryRecordMessage(msgId: string): boolean {
    const now = Date.now();

    if (now - this.lastDedupCleanup > DEDUP_CLEANUP_INTERVAL_MS) {
      this.cleanupDedup(now);
      this.lastDedupCleanup = now;
    }

    if (this.seenMessages.has(msgId)) return false;

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
