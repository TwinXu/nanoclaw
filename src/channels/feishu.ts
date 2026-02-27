import * as Lark from '@larksuiteoapi/node-sdk';
import fs from 'fs';
import path from 'path';

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

// --- Markdown → Feishu Post conversion ---

interface PostElement {
  tag: string;
  text?: string;
  href?: string;
  style?: string[];
  user_id?: string; // for "at" tag
}

/**
 * Convert markdown text to Feishu "post" rich-text content paragraphs.
 * Each inner array is one line/paragraph of PostElements.
 */
export function markdownToPost(text: string): PostElement[][] {
  const paragraphs: PostElement[][] = [];
  const lines = text.split('\n');
  let inCodeBlock = false;
  let codeLines: string[] = [];

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        paragraphs.push([{ tag: 'text', text: codeLines.join('\n') }]);
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }
    if (line.trim() === '') continue;

    // Heading: strip # prefix, render bold
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      paragraphs.push(parseInlineElements(headingMatch[2], ['bold']));
      continue;
    }

    // List item: keep the bullet/number prefix as plain text, parse rest
    const listMatch = line.match(/^(\s*-\s+|\s*\d+\.\s+)(.*)$/);
    if (listMatch) {
      paragraphs.push([
        { tag: 'text', text: listMatch[1] },
        ...parseInlineElements(listMatch[2]),
      ]);
      continue;
    }

    paragraphs.push(parseInlineElements(line));
  }

  // Unclosed code block
  if (codeLines.length > 0) {
    paragraphs.push([{ tag: 'text', text: codeLines.join('\n') }]);
  }

  return paragraphs;
}

/** Parse inline markdown (bold, italic, links, strikethrough, inline code) into PostElements. */
function parseInlineElements(text: string, baseStyle?: string[]): PostElement[] {
  const elements: PostElement[] = [];
  // Order: bold-italic (***) > bold (**) > italic (*) > strikethrough (~~) > link > inline code
  const pattern = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~|\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const plain = text.slice(lastIndex, match.index);
      if (plain) {
        const el: PostElement = { tag: 'text', text: plain };
        if (baseStyle) el.style = [...baseStyle];
        elements.push(el);
      }
    }

    if (match[2]) { // ***bold italic***
      elements.push({ tag: 'text', text: match[2], style: [...(baseStyle || []), 'bold', 'italic'] });
    } else if (match[3]) { // **bold**
      elements.push({ tag: 'text', text: match[3], style: [...(baseStyle || []), 'bold'] });
    } else if (match[4]) { // *italic*
      elements.push({ tag: 'text', text: match[4], style: [...(baseStyle || []), 'italic'] });
    } else if (match[5]) { // ~~strikethrough~~
      elements.push({ tag: 'text', text: match[5], style: [...(baseStyle || []), 'lineThrough'] });
    } else if (match[6] && match[7]) { // [text](url)
      elements.push({ tag: 'a', text: match[6], href: match[7] });
    } else if (match[8]) { // `code`
      elements.push({ tag: 'text', text: match[8] });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    const plain = text.slice(lastIndex);
    if (plain) {
      const el: PostElement = { tag: 'text', text: plain };
      if (baseStyle) el.style = [...baseStyle];
      elements.push(el);
    }
  }

  if (elements.length === 0 && text) {
    const el: PostElement = { tag: 'text', text };
    if (baseStyle) el.style = [...baseStyle];
    elements.push(el);
  }

  return elements;
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

  // Chat member cache: chatId -> { members: Map<name, openId>, ts }
  private chatMemberCache = new Map<string, { members: Map<string, string>; ts: number }>();

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
      let postContent = markdownToPost(text);

      // Resolve @Name mentions to Feishu at-elements
      // Require @ at start or after whitespace to avoid false positives (e.g. emails)
      if (/(^|\s)@[^\s@]/.test(text)) {
        const memberMap = await this.getChatMembers(chatId);
        if (memberMap.size > 0) {
          postContent = this.resolveMentionsInPost(postContent, memberMap);
        }
      }

      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ zh_cn: { content: postContent } }),
          msg_type: 'post',
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

  /** Download an image or file from a Feishu message to a local directory. */
  async downloadMedia(
    messageId: string,
    fileKey: string,
    destDir: string,
    requestId: string,
    mediaType?: string,
  ): Promise<string | null> {
    try {
      const type = mediaType === 'file' ? 'file' : 'image';
      const resp = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      });

      // SDK returns { writeFile, getReadableStream, headers }
      const contentType = String(resp.headers?.['content-type'] || '');
      let ext: string;
      if (type === 'file') {
        // Try content-disposition for original filename extension
        const disposition = String(resp.headers?.['content-disposition'] || '');
        const filenameMatch = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
        if (filenameMatch) {
          const origName = decodeURIComponent(filenameMatch[1].replace(/"/g, ''));
          const dotIdx = origName.lastIndexOf('.');
          ext = dotIdx >= 0 ? origName.slice(dotIdx) : '';
        } else if (contentType.includes('pdf')) {
          ext = '.pdf';
        } else if (contentType.includes('zip')) {
          ext = '.zip';
        } else if (contentType.includes('word') || contentType.includes('docx')) {
          ext = '.docx';
        } else if (contentType.includes('excel') || contentType.includes('spreadsheet') || contentType.includes('xlsx')) {
          ext = '.xlsx';
        } else if (contentType.includes('powerpoint') || contentType.includes('presentation') || contentType.includes('pptx')) {
          ext = '.pptx';
        } else {
          ext = '.bin';
        }
      } else {
        ext = '.png';
        if (contentType.includes('jpeg') || contentType.includes('jpg'))
          ext = '.jpg';
        else if (contentType.includes('gif')) ext = '.gif';
        else if (contentType.includes('webp')) ext = '.webp';
      }

      const filename = `${requestId}${ext}`;
      const destPath = path.join(destDir, filename);

      await resp.writeFile(destPath);

      logger.info(
        { messageId, fileKey, destPath, type },
        'Feishu media downloaded',
      );
      return filename;
    } catch (err) {
      logger.error(
        { messageId, fileKey, err },
        'Failed to download Feishu media',
      );
      return null;
    }
  }

  /** Upload and send an image file to a Feishu chat. */
  async sendImage(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    const chatId = jid.replace(/@feishu$/, '');

    try {
      // Upload image to get image_key
      const uploadResp = await this.client.im.image.create({
        data: {
          image_type: 'message',
          image: fs.createReadStream(filePath),
        },
      });

      const imageKey = (uploadResp as { image_key?: string } | null)?.image_key;
      if (!imageKey) {
        logger.error({ filePath }, 'Feishu image upload returned no image_key');
        return;
      }

      // Send image message
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ image_key: imageKey }),
          msg_type: 'image',
        },
      });

      logger.info({ jid, imageKey }, 'Feishu image sent');

      // Send caption as a follow-up rich-text message if provided
      if (caption) {
        await this.sendMessage(jid, caption);
      }
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send Feishu image');
    }
  }

  /** Upload and send a file to a Feishu chat. */
  async sendFile(
    jid: string,
    filePath: string,
    fileName: string,
  ): Promise<void> {
    const chatId = jid.replace(/@feishu$/, '');

    try {
      // Upload file to get file_key
      const uploadResp = await this.client.im.file.create({
        data: {
          file_type: 'stream',
          file_name: fileName,
          file: fs.createReadStream(filePath),
        },
      });

      const fileKey = (uploadResp as { file_key?: string } | null)?.file_key;
      if (!fileKey) {
        logger.error({ filePath, fileName }, 'Feishu file upload returned no file_key');
        return;
      }

      // Send file message
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ file_key: fileKey }),
          msg_type: 'file',
        },
      });

      logger.info({ jid, fileKey, fileName }, 'Feishu file sent');
    } catch (err) {
      logger.error({ jid, filePath, fileName, err }, 'Failed to send Feishu file');
    }
  }

  // --- Mention resolution ---

  /** Fetch chat members and cache the name→open_id mapping. */
  private async getChatMembers(chatId: string): Promise<Map<string, string>> {
    const cached = this.chatMemberCache.get(chatId);
    if (cached && Date.now() - cached.ts < NAME_CACHE_TTL_MS) {
      return cached.members;
    }

    // Validate chatId format (Feishu chat IDs start with oc_)
    if (!/^oc_\w+$/.test(chatId)) {
      logger.debug({ chatId }, 'Skipping member fetch for non-group chat');
      return new Map();
    }

    try {
      const members = new Map<string, string>();
      let pageToken: string | undefined;

      do {
        const params: Record<string, string | number> = {
          member_id_type: 'open_id',
          page_size: 100,
        };
        if (pageToken) params.page_token = pageToken;

        const resp = await this.client.request<{
          data?: {
            items?: Array<{ member_id?: string; name?: string }>;
            page_token?: string;
            has_more?: boolean;
          };
        }>({
          method: 'GET',
          url: `/open-apis/im/v1/chats/${chatId}/members`,
          params,
        });

        for (const item of resp?.data?.items || []) {
          if (item.name && item.member_id) {
            if (members.has(item.name)) {
              logger.warn(
                { chatId, name: item.name, existingId: members.get(item.name), newId: item.member_id },
                'Duplicate member name in chat, later entry wins',
              );
            }
            members.set(item.name, item.member_id);
          }
        }

        pageToken = resp?.data?.has_more ? resp?.data?.page_token : undefined;
      } while (pageToken);

      this.chatMemberCache.set(chatId, { members, ts: Date.now() });
      return members;
    } catch (err) {
      logger.debug({ chatId, err }, 'Failed to fetch chat members');
      return new Map();
    }
  }

  /** Replace @Name text fragments in post elements with Feishu at-elements. */
  private resolveMentionsInPost(
    paragraphs: PostElement[][],
    memberMap: Map<string, string>,
  ): PostElement[][] {
    return paragraphs.map(paragraph =>
      paragraph.flatMap(el => {
        if (el.tag !== 'text' || !el.text || !el.text.includes('@')) return [el];
        return this.splitTextOnMentions(el.text, memberMap, el.style);
      }),
    );
  }

  /** Split a text string on @Name patterns, replacing matched names with at-elements. */
  private splitTextOnMentions(
    text: string,
    memberMap: Map<string, string>,
    style?: string[],
  ): PostElement[] {
    const elements: PostElement[] = [];
    const pattern = /@([^\s@,.:;!?，。：；！？]+)/g;
    let lastIndex = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
      const name = match[1];
      const openId = memberMap.get(name);

      if (!openId) continue; // Not a known member, leave as plain text

      // Add text before the mention
      if (match.index > lastIndex) {
        const before = text.slice(lastIndex, match.index);
        const el: PostElement = { tag: 'text', text: before };
        if (style) el.style = [...style];
        elements.push(el);
      }

      // Add at-element
      elements.push({ tag: 'at', user_id: openId });
      lastIndex = match.index + match[0].length;
    }

    // No matches found — return original text element
    if (lastIndex === 0) {
      const el: PostElement = { tag: 'text', text };
      if (style) el.style = [...style];
      return [el];
    }

    // Add remaining text after last match
    if (lastIndex < text.length) {
      const remaining = text.slice(lastIndex);
      const el: PostElement = { tag: 'text', text: remaining };
      if (style) el.style = [...style];
      elements.push(el);
    }

    return elements;
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

    // Extract text content — image/file messages get metadata references instead of placeholders
    let rawContent: string;
    if (msg.message_type === 'image') {
      try {
        const parsed = JSON.parse(msg.content);
        rawContent = `[图片 image_key=${parsed.image_key} message_id=${msg.message_id}]`;
      } catch {
        rawContent = '[image message]';
      }
    } else if (msg.message_type === 'file') {
      try {
        const parsed = JSON.parse(msg.content);
        rawContent = `[文件 file_key=${parsed.file_key} file_name=${parsed.file_name || 'unknown'} message_id=${msg.message_id}]`;
      } catch {
        rawContent = '[file message]';
      }
    } else {
      rawContent = this.parseMessageContent(msg.content, msg.message_type);
    }

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
