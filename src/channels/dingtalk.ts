import {
  DWClient,
  DWClientDownStream,
  TOPIC_ROBOT,
} from 'dingtalk-stream';

import fs from 'node:fs';
import path from 'node:path';

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
  content?: {
    richText?: Array<{
      type?: string;         // "picture" for images
      text?: string;         // text nodes
      downloadCode?: string; // image download code
      pictureDownloadCode?: string; // alternative download code
    }>;
  };
  richText?: unknown; // legacy — actual data is in content.richText
  picture?: { picURL: string; downloadCode?: string };
  file?: { fileName: string; downloadCode: string; spaceId?: string; fileId?: string };
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
      const msgKey = 'sampleMarkdown';
      const msgParam = JSON.stringify({ title: ASSISTANT_NAME, text: truncated });
      if (isGroup) {
        await this.sendGroupViaOpenAPI(conversationId, msgKey, msgParam);
      } else {
        await this.sendDmViaOpenAPI(conversationId, msgKey, msgParam);
      }
      logger.info({ jid, length: truncated.length, isGroup }, 'DingTalk message sent via OpenAPI');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send DingTalk message');
    }
  }

  /** Download media (image or file) from a DingTalk message to a local directory. */
  async downloadMedia(
    messageId: string,
    fileKey: string,
    destDir: string,
    requestId: string,
    mediaType?: string,
  ): Promise<string | null> {
    try {
      let mediaResp: Response;

      if (fileKey.startsWith('http://') || fileKey.startsWith('https://')) {
        // Direct URL (picURL for images) — fetch directly
        mediaResp = await fetch(fileKey);
      } else {
        // downloadCode (for file messages) — resolve to temp URL via API
        const token = await this.getAccessToken();
        const resolveResp = await fetch('https://api.dingtalk.com/v1.0/robot/messageFiles/download', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-acs-dingtalk-access-token': token,
          },
          body: JSON.stringify({
            downloadCode: fileKey,
            robotCode: DINGTALK_ROBOT_CODE,
          }),
        });

        if (!resolveResp.ok) {
          const body = await resolveResp.text();
          logger.error({ messageId, fileKey, status: resolveResp.status, body }, 'Failed to resolve DingTalk download code');
          return null;
        }

        const resolveData = await resolveResp.json() as { downloadUrl?: string };
        if (!resolveData.downloadUrl) {
          logger.error({ messageId, fileKey }, 'DingTalk download code resolved but no downloadUrl');
          return null;
        }

        mediaResp = await fetch(resolveData.downloadUrl);
      }

      if (!mediaResp.ok) {
        logger.error({ messageId, fileKey, status: mediaResp.status }, 'Failed to fetch DingTalk media');
        return null;
      }

      // Determine extension from content-type
      const contentType = mediaResp.headers.get('content-type') || '';
      let ext: string;
      if (mediaType === 'file') {
        // Try content-disposition for original filename extension
        const disposition = mediaResp.headers.get('content-disposition') || '';
        const filenameMatch = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
        if (filenameMatch) {
          const origName = decodeURIComponent(filenameMatch[1].replace(/"/g, ''));
          const dotIdx = origName.lastIndexOf('.');
          ext = dotIdx >= 0 ? origName.slice(dotIdx) : '.bin';
        } else if (contentType.includes('pdf')) {
          ext = '.pdf';
        } else if (contentType.includes('zip')) {
          ext = '.zip';
        } else if (contentType.includes('word') || contentType.includes('docx')) {
          ext = '.docx';
        } else if (contentType.includes('excel') || contentType.includes('spreadsheet') || contentType.includes('xlsx')) {
          ext = '.xlsx';
        } else {
          ext = '.bin';
        }
      } else {
        ext = '.png';
        if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = '.jpg';
        else if (contentType.includes('gif')) ext = '.gif';
        else if (contentType.includes('webp')) ext = '.webp';
      }

      const filename = `${requestId}${ext}`;
      const destPath = path.join(destDir, filename);

      const arrayBuf = await mediaResp.arrayBuffer();
      fs.writeFileSync(destPath, Buffer.from(arrayBuf));

      logger.info({ messageId, fileKey, destPath, mediaType }, 'DingTalk media downloaded');
      return filename;
    } catch (err) {
      logger.error({ messageId, fileKey, err }, 'Failed to download DingTalk media');
      return null;
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

  /** Parse message content. Returns plain text with media metadata tags. */
  private extractContent(msg: DingTalkRobotMessage): string {
    if (msg.msgtype === 'text' && msg.text) {
      return msg.text.content.trim();
    }
    if (msg.msgtype === 'richText' && msg.content?.richText) {
      // richText is an array of nodes: {type:"picture", downloadCode:...} and {text:...}
      // Extract pictures as metadata tags and text as plain text.
      const parts: string[] = [];
      for (const node of msg.content.richText) {
        if (node.type === 'picture') {
          const code = node.downloadCode || node.pictureDownloadCode;
          if (code) {
            parts.push(`[图片 image_key=${code} message_id=${msg.msgId}]`);
          }
        } else if (node.text) {
          const trimmed = node.text.trim();
          if (trimmed) parts.push(trimmed);
        }
      }
      return parts.join(' ') || '[richText message]';
    }
    if (msg.msgtype === 'richText') {
      return '[richText message]';
    }
    if (msg.msgtype === 'picture' && msg.picture?.picURL) {
      // DM picture messages use picURL (direct URL).
      // downloadMedia() handles HTTP URLs directly.
      return `[图片 image_key=${msg.picture.picURL} message_id=${msg.msgId}]`;
    }
    if (msg.msgtype === 'file' && msg.file) {
      // DM-only: file messages use downloadCode for retrieval
      return `[文件 file_key=${msg.file.downloadCode} file_name=${msg.file.fileName} message_id=${msg.msgId}]`;
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

  /** Send an image file to a DingTalk chat. */
  async sendImage(jid: string, filePath: string, caption?: string): Promise<void> {
    const conversationId = jid.replace(/@dingtalk$/, '');

    try {
      const mediaId = await this.uploadMedia(filePath, 'image');
      if (!mediaId) return;

      const isGroup = this.webhookCache.get(conversationId)?.isGroup ?? true;
      const msgKey = 'sampleImageMsg';
      const msgParam = JSON.stringify({ photoURL: mediaId });

      if (isGroup) {
        await this.sendGroupViaOpenAPI(conversationId, msgKey, msgParam);
      } else {
        await this.sendDmViaOpenAPI(conversationId, msgKey, msgParam);
      }

      logger.info({ jid, mediaId }, 'DingTalk image sent');

      if (caption) {
        await this.sendMessage(jid, caption);
      }
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send DingTalk image');
    }
  }

  /** Send a file attachment to a DingTalk chat. */
  async sendFile(jid: string, filePath: string, fileName: string): Promise<void> {
    const conversationId = jid.replace(/@dingtalk$/, '');

    try {
      const mediaId = await this.uploadMedia(filePath, 'file');
      if (!mediaId) return;

      const isGroup = this.webhookCache.get(conversationId)?.isGroup ?? true;
      const msgKey = 'sampleFile';
      const msgParam = JSON.stringify({ mediaId, fileName, fileType: path.extname(fileName).replace('.', '') });

      if (isGroup) {
        await this.sendGroupViaOpenAPI(conversationId, msgKey, msgParam);
      } else {
        await this.sendDmViaOpenAPI(conversationId, msgKey, msgParam);
      }

      logger.info({ jid, mediaId, fileName }, 'DingTalk file sent');
    } catch (err) {
      logger.error({ jid, filePath, fileName, err }, 'Failed to send DingTalk file');
    }
  }

  // --- Send helpers ---

  /** Generic group message send via OpenAPI. */
  private async sendGroupViaOpenAPI(conversationId: string, msgKey: string, msgParam: string): Promise<void> {
    const token = await this.getAccessToken();

    const resp = await fetch('https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify({
        msgParam,
        msgKey,
        openConversationId: conversationId,
        robotCode: DINGTALK_ROBOT_CODE,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`OpenAPI send failed: ${resp.status} ${body}`);
    }
  }

  /** Generic DM message send via OpenAPI. */
  private async sendDmViaOpenAPI(conversationId: string, msgKey: string, msgParam: string): Promise<void> {
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
        msgParam,
        msgKey,
        robotCode: DINGTALK_ROBOT_CODE,
        userIds: [senderUserId],
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`OpenAPI DM send failed: ${resp.status} ${body}`);
    }
  }

  /** Upload a file to DingTalk media storage. Returns media_id or null. */
  private async uploadMedia(filePath: string, type: 'image' | 'file'): Promise<string | null> {
    try {
      const token = await this.getAccessToken();

      const formData = new FormData();
      const fileBuffer = fs.readFileSync(filePath);
      const fileName = path.basename(filePath);
      const blob = new Blob([fileBuffer]);
      formData.append('media', blob, fileName);

      const resp = await fetch(
        `https://oapi.dingtalk.com/media/upload?access_token=${token}&type=${type}`,
        { method: 'POST', body: formData },
      );

      if (!resp.ok) {
        const body = await resp.text();
        logger.error({ filePath, type, status: resp.status, body }, 'DingTalk media upload failed');
        return null;
      }

      const data = await resp.json() as { media_id?: string; errcode?: number; errmsg?: string };
      if (data.errcode && data.errcode !== 0) {
        logger.error({ filePath, type, errcode: data.errcode, errmsg: data.errmsg }, 'DingTalk media upload error');
        return null;
      }

      if (!data.media_id) {
        logger.error({ filePath, type }, 'DingTalk media upload returned no media_id');
        return null;
      }

      logger.info({ filePath, type, mediaId: data.media_id }, 'DingTalk media uploaded');
      return data.media_id;
    } catch (err) {
      logger.error({ filePath, type, err }, 'Failed to upload DingTalk media');
      return null;
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
