import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  FEISHU_APP_ID: 'test-app-id',
  FEISHU_APP_SECRET: 'test-app-secret',
  FEISHU_DOMAIN: 'feishu',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Build mock Lark client
const mockCreate = vi.fn().mockResolvedValue(undefined);
const mockUserGet = vi.fn().mockResolvedValue({
  data: { user: { name: 'Test User' } },
});
const mockChatGet = vi.fn().mockResolvedValue({
  data: { name: 'Test Chat' },
});
const mockRequest = vi.fn().mockImplementation(async (opts: { url: string }) => {
  if (opts.url === '/open-apis/bot/v3/info') {
    return { bot: { open_id: 'ou_bot123' } };
  }
  // Default: chat members endpoint returns empty
  return { data: { items: [], has_more: false } };
});

const mockClient = {
  im: {
    message: { create: mockCreate },
    chat: { get: mockChatGet },
  },
  contact: {
    user: { get: mockUserGet },
  },
  request: mockRequest,
};

const mockWsStart = vi.fn();

let registeredHandler: ((data: unknown) => Promise<void>) | undefined;

vi.mock('@larksuiteoapi/node-sdk', () => {
  return {
    Client: vi.fn().mockImplementation(function () { return mockClient; }),
    WSClient: vi.fn().mockImplementation(function () { return { start: mockWsStart }; }),
    EventDispatcher: vi.fn().mockImplementation(function () {
      return {
        register: vi.fn((handlers: Record<string, (data: unknown) => Promise<void>>) => {
          registeredHandler = handlers['im.message.receive_v1'];
        }),
      };
    }),
    AppType: { SelfBuild: 'SelfBuild' },
    Domain: { Feishu: 'feishu', Lark: 'lark' },
    LoggerLevel: { info: 'info' },
  };
});

import { FeishuChannel, FeishuChannelOpts, FeishuMessageEvent, markdownToPost } from './feishu.js';

// --- Helpers ---

function createTestOpts(overrides?: Partial<FeishuChannelOpts>): FeishuChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'oc_abc123@feishu': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createMessageEvent(overrides?: Partial<{
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  messageType: string;
  content: string;
  senderOpenId: string;
  mentions: FeishuMessageEvent['message']['mentions'];
}>): FeishuMessageEvent {
  const defaults = {
    messageId: `msg_${Date.now()}`,
    chatId: 'oc_abc123',
    chatType: 'group' as const,
    messageType: 'text',
    content: '{"text":"Hello Andy"}',
    senderOpenId: 'ou_sender1',
    mentions: undefined,
  };
  const opts = { ...defaults, ...overrides };

  return {
    sender: {
      sender_id: {
        open_id: opts.senderOpenId,
      },
    },
    message: {
      message_id: opts.messageId,
      chat_id: opts.chatId,
      chat_type: opts.chatType,
      message_type: opts.messageType,
      content: opts.content,
      mentions: opts.mentions,
    },
  };
}

// --- Tests ---

describe('FeishuChannel', () => {
  beforeEach(() => {
    registeredHandler = undefined;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "feishu"', () => {
      const channel = new FeishuChannel(createTestOpts());
      expect(channel.name).toBe('feishu');
    });

    it('does not prefix assistant name', () => {
      const channel = new FeishuChannel(createTestOpts());
      expect(channel.prefixAssistantName).toBe(false);
    });
  });

  // --- JID ownership ---

  describe('ownsJid', () => {
    it('owns @feishu JIDs', () => {
      const channel = new FeishuChannel(createTestOpts());
      expect(channel.ownsJid('oc_abc123@feishu')).toBe(true);
    });

    it('owns DM @feishu JIDs', () => {
      const channel = new FeishuChannel(createTestOpts());
      expect(channel.ownsJid('ou_xyz789@feishu')).toBe(true);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new FeishuChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new FeishuChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- Connection ---

  describe('connection', () => {
    it('connects and fetches bot identity', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({ url: '/open-apis/bot/v3/info' }),
      );
      expect(mockWsStart).toHaveBeenCalled();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);

      await channel.connect();
      await channel.disconnect();

      expect(channel.isConnected()).toBe(false);
    });

    it('handles bot info fetch failure gracefully', async () => {
      mockRequest.mockRejectedValueOnce(new Error('Network error'));

      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);
    });
  });

  // --- Text extraction ---

  describe('text extraction', () => {
    it('extracts text from text message', () => {
      const channel = new FeishuChannel(createTestOpts());
      const result = channel.parseMessageContent('{"text":"Hello"}', 'text');
      expect(result).toBe('Hello');
    });

    it('returns placeholder for image message', () => {
      const channel = new FeishuChannel(createTestOpts());
      const result = channel.parseMessageContent('{"image_key":"img_123"}', 'image');
      expect(result).toBe('[image message]');
    });

    it('returns placeholder for file message via parseMessageContent', () => {
      const channel = new FeishuChannel(createTestOpts());
      const result = channel.parseMessageContent('{"file_key":"f_123","file_name":"report.pdf"}', 'file');
      // parseMessageContent still returns placeholder; file metadata is handled in handleMessage
      expect(result).toBe('[file message]');
    });

    it('handles malformed JSON gracefully', () => {
      const channel = new FeishuChannel(createTestOpts());
      const result = channel.parseMessageContent('not-json', 'text');
      expect(result).toBe('not-json');
    });

    it('handles empty text', () => {
      const channel = new FeishuChannel(createTestOpts());
      const result = channel.parseMessageContent('{"text":""}', 'text');
      expect(result).toBe('');
    });

    it('extracts text from post message with direct content', () => {
      const channel = new FeishuChannel(createTestOpts());
      const content = JSON.stringify({
        title: 'My Post',
        content: [[{ tag: 'text', text: 'Hello ' }, { tag: 'text', text: 'world' }]],
      });
      const result = channel.parseMessageContent(content, 'post');
      expect(result).toContain('My Post');
      expect(result).toContain('Hello');
      expect(result).toContain('world');
    });

    it('extracts text from post message with localized content', () => {
      const channel = new FeishuChannel(createTestOpts());
      const content = JSON.stringify({
        zh_cn: {
          title: '标题',
          content: [[{ tag: 'text', text: '你好' }]],
        },
      });
      const result = channel.parseMessageContent(content, 'post');
      expect(result).toBe('标题 你好');
    });

    it('returns placeholder for empty post', () => {
      const channel = new FeishuChannel(createTestOpts());
      const result = channel.parseMessageContent('{}', 'post');
      expect(result).toBe('[post message]');
    });
  });

  // --- Mention processing ---

  describe('mention processing', () => {
    it('replaces bot mention with @AssistantName', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      const result = channel.processMentions(
        '@_user_1 hello',
        [
          {
            key: '@_user_1',
            id: { open_id: 'ou_bot123' },
            name: 'TestBot',
          },
        ],
      );

      expect(result).toBe('@Andy hello');
    });

    it('replaces non-bot mention with @Name', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      const result = channel.processMentions(
        '@_user_1 what do you think?',
        [
          {
            key: '@_user_1',
            id: { open_id: 'ou_someone_else' },
            name: 'Alice',
          },
        ],
      );

      expect(result).toBe('@Alice what do you think?');
    });

    it('handles multiple mentions', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      const result = channel.processMentions(
        '@_user_1 @_user_2 please help',
        [
          {
            key: '@_user_1',
            id: { open_id: 'ou_bot123' },
            name: 'TestBot',
          },
          {
            key: '@_user_2',
            id: { open_id: 'ou_alice' },
            name: 'Alice',
          },
        ],
      );

      expect(result).toBe('@Andy @Alice please help');
    });

    it('returns text unchanged when no mentions', () => {
      const channel = new FeishuChannel(createTestOpts());
      const result = channel.processMentions('plain text', undefined);
      expect(result).toBe('plain text');
    });

    it('returns text unchanged with empty mentions array', () => {
      const channel = new FeishuChannel(createTestOpts());
      const result = channel.processMentions('plain text', []);
      expect(result).toBe('plain text');
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        chatId: 'oc_abc123',
        content: '{"text":"Hello Andy"}',
      });
      await registeredHandler!(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'oc_abc123@feishu',
        expect.any(String),
        expect.any(String),
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'oc_abc123@feishu',
        expect.objectContaining({
          chat_jid: 'oc_abc123@feishu',
          content: 'Hello Andy',
          sender_name: 'Test User',
        }),
      );
    });

    it('only emits metadata for unregistered groups', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        chatId: 'oc_unregistered',
      });
      await registeredHandler!(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'oc_unregistered@feishu',
        expect.any(String),
        expect.any(String),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('uses sender openId as fallback when name resolution fails', async () => {
      mockUserGet.mockRejectedValueOnce(new Error('Permission denied'));

      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        chatId: 'oc_abc123',
        senderOpenId: 'ou_fallback',
      });
      await registeredHandler!(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'oc_abc123@feishu',
        expect.objectContaining({
          sender_name: 'ou_fallback',
        }),
      );
    });

    it('filters out bot own messages', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      // Send a message FROM the bot itself (senderOpenId matches botOpenId)
      const event = createMessageEvent({
        chatId: 'oc_abc123',
        senderOpenId: 'ou_bot123', // matches mock botOpenId
      });
      await registeredHandler!(event);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('sets is_from_me to false on delivered messages', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        chatId: 'oc_abc123',
        senderOpenId: 'ou_human_user',
      });
      await registeredHandler!(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'oc_abc123@feishu',
        expect.objectContaining({
          is_from_me: false,
        }),
      );
    });
    it('delivers image message with metadata reference', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        chatId: 'oc_abc123',
        messageType: 'image',
        content: '{"image_key":"img_v3_abc123"}',
        messageId: 'msg_img_1',
      });
      await registeredHandler!(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'oc_abc123@feishu',
        expect.objectContaining({
          content: '[图片 image_key=img_v3_abc123 message_id=msg_img_1]',
        }),
      );
    });

    it('delivers file message with metadata reference', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        chatId: 'oc_abc123',
        messageType: 'file',
        content: '{"file_key":"file_v3_abc","file_name":"report.pdf"}',
        messageId: 'msg_file_1',
      });
      await registeredHandler!(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'oc_abc123@feishu',
        expect.objectContaining({
          content: '[文件 file_key=file_v3_abc file_name=report.pdf message_id=msg_file_1]',
        }),
      );
    });

    it('handles file message with missing file_name', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        chatId: 'oc_abc123',
        messageType: 'file',
        content: '{"file_key":"file_v3_abc"}',
        messageId: 'msg_file_2',
      });
      await registeredHandler!(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'oc_abc123@feishu',
        expect.objectContaining({
          content: '[文件 file_key=file_v3_abc file_name=unknown message_id=msg_file_2]',
        }),
      );
    });

    it('falls back to placeholder for file with malformed JSON', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        chatId: 'oc_abc123',
        messageType: 'file',
        content: 'not-json',
      });
      await registeredHandler!(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'oc_abc123@feishu',
        expect.objectContaining({
          content: '[file message]',
        }),
      );
    });

    it('falls back to placeholder for image with malformed JSON', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        chatId: 'oc_abc123',
        messageType: 'image',
        content: 'not-json',
      });
      await registeredHandler!(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'oc_abc123@feishu',
        expect.objectContaining({
          content: '[image message]',
        }),
      );
    });
  });

  // --- Deduplication ---

  describe('deduplication', () => {
    it('deduplicates messages with same message_id', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        messageId: 'msg_dup_1',
        chatId: 'oc_abc123',
      });

      await registeredHandler!(event);
      await registeredHandler!(event);

      // onMessage should only be called once
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
    });

    it('allows different message_ids', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      const event1 = createMessageEvent({
        messageId: 'msg_unique_1',
        chatId: 'oc_abc123',
      });
      const event2 = createMessageEvent({
        messageId: 'msg_unique_2',
        chatId: 'oc_abc123',
      });

      await registeredHandler!(event1);
      await registeredHandler!(event2);

      expect(opts.onMessage).toHaveBeenCalledTimes(2);
    });
  });

  // --- Sender name caching ---

  describe('sender name caching', () => {
    it('caches sender names', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      // Send two messages from same sender
      const event1 = createMessageEvent({
        messageId: 'msg_cache_1',
        chatId: 'oc_abc123',
        senderOpenId: 'ou_cached_sender',
      });
      const event2 = createMessageEvent({
        messageId: 'msg_cache_2',
        chatId: 'oc_abc123',
        senderOpenId: 'ou_cached_sender',
      });

      await registeredHandler!(event1);
      await registeredHandler!(event2);

      // user.get should only be called once (second call uses cache)
      // Note: first call is for msg_cache_1, cached for msg_cache_2
      const senderCalls = mockUserGet.mock.calls.filter(
        (call) => call[0]?.path?.user_id === 'ou_cached_sender',
      );
      expect(senderCalls).toHaveLength(1);
    });
  });

  // --- markdownToPost ---

  describe('markdownToPost', () => {
    it('converts plain text to single paragraph', () => {
      expect(markdownToPost('Hello world')).toEqual([
        [{ tag: 'text', text: 'Hello world' }],
      ]);
    });

    it('converts **bold** to bold style', () => {
      expect(markdownToPost('a **bold** word')).toEqual([
        [
          { tag: 'text', text: 'a ' },
          { tag: 'text', text: 'bold', style: ['bold'] },
          { tag: 'text', text: ' word' },
        ],
      ]);
    });

    it('converts *italic* to italic style', () => {
      expect(markdownToPost('an *italic* word')).toEqual([
        [
          { tag: 'text', text: 'an ' },
          { tag: 'text', text: 'italic', style: ['italic'] },
          { tag: 'text', text: ' word' },
        ],
      ]);
    });

    it('converts ***bold italic***', () => {
      const result = markdownToPost('***both***');
      expect(result[0][0]).toEqual({ tag: 'text', text: 'both', style: ['bold', 'italic'] });
    });

    it('converts [text](url) to link', () => {
      expect(markdownToPost('click [here](https://example.com) now')).toEqual([
        [
          { tag: 'text', text: 'click ' },
          { tag: 'a', text: 'here', href: 'https://example.com' },
          { tag: 'text', text: ' now' },
        ],
      ]);
    });

    it('converts ~~strikethrough~~', () => {
      expect(markdownToPost('~~removed~~')).toEqual([
        [{ tag: 'text', text: 'removed', style: ['lineThrough'] }],
      ]);
    });

    it('strips heading markers and makes bold', () => {
      expect(markdownToPost('## Heading')).toEqual([
        [{ tag: 'text', text: 'Heading', style: ['bold'] }],
      ]);
    });

    it('preserves list bullet prefix', () => {
      expect(markdownToPost('- item one')).toEqual([
        [
          { tag: 'text', text: '- ' },
          { tag: 'text', text: 'item one' },
        ],
      ]);
    });

    it('handles code blocks as plain text', () => {
      const md = '```\nconst x = 1;\n```';
      expect(markdownToPost(md)).toEqual([
        [{ tag: 'text', text: 'const x = 1;' }],
      ]);
    });

    it('handles inline `code` as plain text', () => {
      expect(markdownToPost('use `foo()` here')).toEqual([
        [
          { tag: 'text', text: 'use ' },
          { tag: 'text', text: 'foo()' },
          { tag: 'text', text: ' here' },
        ],
      ]);
    });

    it('handles multiple paragraphs', () => {
      const result = markdownToPost('line 1\nline 2');
      expect(result).toHaveLength(2);
    });

    it('skips empty lines', () => {
      const result = markdownToPost('first\n\nsecond');
      expect(result).toHaveLength(2);
      expect(result[0][0].text).toBe('first');
      expect(result[1][0].text).toBe('second');
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends post message via API', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      await channel.sendMessage('oc_abc123@feishu', 'Hello!');

      expect(mockCreate).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_abc123',
          content: JSON.stringify({
            zh_cn: { content: [[{ tag: 'text', text: 'Hello!' }]] },
          }),
          msg_type: 'post',
        },
      });
    });

    it('strips @feishu suffix for API call', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      await channel.sendMessage('ou_dm_user@feishu', 'DM');

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            receive_id: 'ou_dm_user',
          }),
        }),
      );
    });

    it('handles send failure gracefully', async () => {
      mockCreate.mockRejectedValueOnce(new Error('API error'));

      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      // Should not throw
      await expect(
        channel.sendMessage('oc_abc123@feishu', 'Test'),
      ).resolves.toBeUndefined();
    });

    it('resolves @Name to Feishu at-element when member found', async () => {
      mockRequest.mockImplementation(async (opts: { url: string }) => {
        if (opts.url === '/open-apis/bot/v3/info') {
          return { bot: { open_id: 'ou_bot123' } };
        }
        if (opts.url.includes('/members')) {
          return {
            data: {
              items: [
                { member_id: 'ou_alice1', name: 'Alice' },
                { member_id: 'ou_bob2', name: 'Bob' },
              ],
              has_more: false,
            },
          };
        }
        return {};
      });

      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      await channel.sendMessage('oc_abc123@feishu', 'Hey @Alice please help');

      const sentContent = JSON.parse(mockCreate.mock.calls[0][0].data.content);
      const paragraph = sentContent.zh_cn.content[0];
      expect(paragraph).toEqual([
        { tag: 'text', text: 'Hey ' },
        { tag: 'at', user_id: 'ou_alice1' },
        { tag: 'text', text: ' please help' },
      ]);
    });

    it('resolves multiple @mentions in one message', async () => {
      mockRequest.mockImplementation(async (opts: { url: string }) => {
        if (opts.url === '/open-apis/bot/v3/info') {
          return { bot: { open_id: 'ou_bot123' } };
        }
        if (opts.url.includes('/members')) {
          return {
            data: {
              items: [
                { member_id: 'ou_alice1', name: 'Alice' },
                { member_id: 'ou_bob2', name: 'Bob' },
              ],
              has_more: false,
            },
          };
        }
        return {};
      });

      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      await channel.sendMessage('oc_abc123@feishu', '@Alice and @Bob check this');

      const sentContent = JSON.parse(mockCreate.mock.calls[0][0].data.content);
      const paragraph = sentContent.zh_cn.content[0];
      expect(paragraph).toEqual([
        { tag: 'at', user_id: 'ou_alice1' },
        { tag: 'text', text: ' and ' },
        { tag: 'at', user_id: 'ou_bob2' },
        { tag: 'text', text: ' check this' },
      ]);
    });

    it('leaves @Name as plain text when member not found', async () => {
      mockRequest.mockImplementation(async (opts: { url: string }) => {
        if (opts.url === '/open-apis/bot/v3/info') {
          return { bot: { open_id: 'ou_bot123' } };
        }
        if (opts.url.includes('/members')) {
          return { data: { items: [], has_more: false } };
        }
        return {};
      });

      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      await channel.sendMessage('oc_abc123@feishu', 'Hey @Unknown hi');

      const sentContent = JSON.parse(mockCreate.mock.calls[0][0].data.content);
      const paragraph = sentContent.zh_cn.content[0];
      expect(paragraph).toEqual([
        { tag: 'text', text: 'Hey @Unknown hi' },
      ]);
    });

    it('resolves known @mention but leaves unknown as text', async () => {
      mockRequest.mockImplementation(async (opts: { url: string }) => {
        if (opts.url === '/open-apis/bot/v3/info') {
          return { bot: { open_id: 'ou_bot123' } };
        }
        if (opts.url.includes('/members')) {
          return {
            data: {
              items: [{ member_id: 'ou_alice1', name: 'Alice' }],
              has_more: false,
            },
          };
        }
        return {};
      });

      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      await channel.sendMessage('oc_abc123@feishu', '@Alice and @Unknown');

      const sentContent = JSON.parse(mockCreate.mock.calls[0][0].data.content);
      const paragraph = sentContent.zh_cn.content[0];
      expect(paragraph).toEqual([
        { tag: 'at', user_id: 'ou_alice1' },
        { tag: 'text', text: ' and @Unknown' },
      ]);
    });

    it('paginates through all chat members', async () => {
      let callCount = 0;
      mockRequest.mockImplementation(async (opts: { url: string; params?: Record<string, unknown> }) => {
        if (opts.url === '/open-apis/bot/v3/info') {
          return { bot: { open_id: 'ou_bot123' } };
        }
        if (opts.url.includes('/members')) {
          callCount++;
          if (!opts.params?.page_token) {
            // First page
            return {
              data: {
                items: [{ member_id: 'ou_alice1', name: 'Alice' }],
                page_token: 'page2',
                has_more: true,
              },
            };
          }
          // Second page
          return {
            data: {
              items: [{ member_id: 'ou_bob2', name: 'Bob' }],
              has_more: false,
            },
          };
        }
        return {};
      });

      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      await channel.sendMessage('oc_abc123@feishu', '@Alice and @Bob');

      // Should have fetched two pages
      expect(callCount).toBe(2);

      const sentContent = JSON.parse(mockCreate.mock.calls[0][0].data.content);
      const paragraph = sentContent.zh_cn.content[0];
      expect(paragraph).toEqual([
        { tag: 'at', user_id: 'ou_alice1' },
        { tag: 'text', text: ' and ' },
        { tag: 'at', user_id: 'ou_bob2' },
      ]);
    });

    it('caches chat members across sendMessage calls', async () => {
      let memberFetchCount = 0;
      mockRequest.mockImplementation(async (opts: { url: string }) => {
        if (opts.url === '/open-apis/bot/v3/info') {
          return { bot: { open_id: 'ou_bot123' } };
        }
        if (opts.url.includes('/members')) {
          memberFetchCount++;
          return {
            data: {
              items: [{ member_id: 'ou_alice1', name: 'Alice' }],
              has_more: false,
            },
          };
        }
        return {};
      });

      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      await channel.sendMessage('oc_abc123@feishu', 'Hey @Alice');
      await channel.sendMessage('oc_abc123@feishu', 'Again @Alice');

      // Members API should only be called once (cached on second call)
      expect(memberFetchCount).toBe(1);
    });

    it('does not fetch members for non-group chats (DMs)', async () => {
      let memberFetchCount = 0;
      mockRequest.mockImplementation(async (opts: { url: string }) => {
        if (opts.url === '/open-apis/bot/v3/info') {
          return { bot: { open_id: 'ou_bot123' } };
        }
        if (opts.url.includes('/members')) {
          memberFetchCount++;
          return { data: { items: [], has_more: false } };
        }
        return {};
      });

      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      // DM chat IDs start with ou_, not oc_
      await channel.sendMessage('ou_dm_user@feishu', 'Hey @Alice');

      expect(memberFetchCount).toBe(0);
    });

    it('does not fetch members for email-like @ patterns', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      mockRequest.mockClear();
      await channel.sendMessage('oc_abc123@feishu', 'Contact user@example.com');

      const memberCalls = mockRequest.mock.calls.filter(
        (call) => String(call[0]?.url || '').includes('/members'),
      );
      expect(memberCalls).toHaveLength(0);
    });

    it('skips member lookup when text has no @', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      mockRequest.mockClear();
      await channel.sendMessage('oc_abc123@feishu', 'No mentions here');

      // Should not call request for members (only bot info was called during connect)
      const memberCalls = mockRequest.mock.calls.filter(
        (call) => String(call[0]?.url || '').includes('/members'),
      );
      expect(memberCalls).toHaveLength(0);
    });
  });
});
