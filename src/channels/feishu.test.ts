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
const mockBotInfoRequest = vi.fn().mockResolvedValue({
  bot: { open_id: 'ou_bot123' },
});

const mockClient = {
  im: {
    message: { create: mockCreate },
    chat: { get: mockChatGet },
  },
  contact: {
    user: { get: mockUserGet },
  },
  request: mockBotInfoRequest,
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

import { FeishuChannel, FeishuChannelOpts, FeishuMessageEvent } from './feishu.js';

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
      expect(mockBotInfoRequest).toHaveBeenCalled();
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
      mockBotInfoRequest.mockRejectedValueOnce(new Error('Network error'));

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

    it('returns placeholder for file message', () => {
      const channel = new FeishuChannel(createTestOpts());
      const result = channel.parseMessageContent('{"file_key":"f_123"}', 'file');
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

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends text message via API', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel(opts);
      await channel.connect();

      await channel.sendMessage('oc_abc123@feishu', 'Hello!');

      expect(mockCreate).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_abc123',
          content: JSON.stringify({ text: 'Hello!' }),
          msg_type: 'text',
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
  });
});
