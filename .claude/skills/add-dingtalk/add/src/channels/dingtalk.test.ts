import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  DINGTALK_APP_KEY: 'test-app-key',
  DINGTALK_APP_SECRET: 'test-app-secret',
  DINGTALK_ROBOT_CODE: 'test-robot-code',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Build mock DWClient
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn();
const mockSocketCallBackResponse = vi.fn();
const mockEventListeners = new Map<string, Function[]>();

let registeredCallback: ((res: any) => void) | undefined;

vi.mock('dingtalk-stream', () => ({
  DWClient: vi.fn().mockImplementation(function () {
    mockEventListeners.clear();
    return {
      connected: true,
      registerCallbackListener: vi.fn((topic: string, cb: (res: any) => void) => {
        registeredCallback = cb;
      }),
      connect: mockConnect,
      disconnect: mockDisconnect,
      socketCallBackResponse: mockSocketCallBackResponse,
      on: vi.fn((event: string, handler: Function) => {
        const existing = mockEventListeners.get(event) || [];
        existing.push(handler);
        mockEventListeners.set(event, existing);
      }),
    };
  }),
  TOPIC_ROBOT: '/v1.0/im/bot/messages/get',
  EventAck: { SUCCESS: 'SUCCESS', LATER: 'LATER' },
}));

import { DingTalkChannel, DingTalkChannelOpts, DingTalkRobotMessage } from './dingtalk.js';

// --- Helpers ---

function createTestOpts(overrides?: Partial<DingTalkChannelOpts>): DingTalkChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'conv123@dingtalk': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createRobotMessage(overrides?: Partial<DingTalkRobotMessage>): DingTalkRobotMessage {
  const defaults: DingTalkRobotMessage = {
    conversationId: 'conv123',
    chatbotCorpId: 'corp1',
    chatbotUserId: 'bot1',
    msgId: `msg_${Date.now()}`,
    senderNick: 'Test User',
    isAdmin: false,
    senderStaffId: 'staff1',
    sessionWebhookExpiredTime: Date.now() + 2 * 60 * 60 * 1000, // 2 hours
    createAt: Date.now(),
    senderCorpId: 'corp1',
    conversationType: '2', // group
    senderId: 'sender1',
    sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession/xxx',
    robotCode: 'test-robot-code',
    msgtype: 'text',
    text: { content: 'Hello Andy' },
  };
  return { ...defaults, ...overrides };
}

function createDownstream(msg: DingTalkRobotMessage, messageId?: string) {
  return {
    specVersion: '1.0',
    type: 'CALLBACK',
    headers: {
      appId: 'test-app',
      connectionId: 'conn1',
      contentType: 'application/json',
      messageId: messageId || `downstream_${Date.now()}`,
      time: new Date().toISOString(),
      topic: '/v1.0/im/bot/messages/get',
    },
    data: JSON.stringify(msg),
  };
}

// --- Tests ---

describe('DingTalkChannel', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registeredCallback = undefined;
    vi.clearAllMocks();
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ errcode: 0, errmsg: 'ok' }),
      text: () => Promise.resolve('ok'),
    });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "dingtalk"', () => {
      const channel = new DingTalkChannel(createTestOpts());
      expect(channel.name).toBe('dingtalk');
    });

    it('does not prefix assistant name', () => {
      const channel = new DingTalkChannel(createTestOpts());
      expect(channel.prefixAssistantName).toBe(false);
    });
  });

  // --- JID ownership ---

  describe('ownsJid', () => {
    it('owns @dingtalk JIDs', () => {
      const channel = new DingTalkChannel(createTestOpts());
      expect(channel.ownsJid('conv123@dingtalk')).toBe(true);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new DingTalkChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Feishu JIDs', () => {
      const channel = new DingTalkChannel(createTestOpts());
      expect(channel.ownsJid('oc_abc123@feishu')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new DingTalkChannel(createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new DingTalkChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- Connection ---

  describe('connection', () => {
    it('connects via DWClient', async () => {
      const channel = new DingTalkChannel(createTestOpts());
      await channel.connect();

      expect(channel.isConnected()).toBe(true);
      expect(mockConnect).toHaveBeenCalled();
      expect(registeredCallback).toBeDefined();
    });

    it('disconnects cleanly', async () => {
      const channel = new DingTalkChannel(createTestOpts());
      await channel.connect();
      await channel.disconnect();

      expect(channel.isConnected()).toBe(false);
      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('handles disconnect when not connected', async () => {
      const channel = new DingTalkChannel(createTestOpts());
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Text extraction ---

  describe('text extraction', () => {
    it('extracts text from text message', () => {
      const channel = new DingTalkChannel(createTestOpts());
      const msg = createRobotMessage({ msgtype: 'text', text: { content: 'Hello' } });
      expect((channel as any).extractContent(msg)).toBe('Hello');
    });

    it('trims whitespace from text content', () => {
      const channel = new DingTalkChannel(createTestOpts());
      const msg = createRobotMessage({ msgtype: 'text', text: { content: '  Hello  ' } });
      expect((channel as any).extractContent(msg)).toBe('Hello');
    });

    it('returns placeholder for richText message', () => {
      const channel = new DingTalkChannel(createTestOpts());
      const msg = createRobotMessage({ msgtype: 'richText', text: undefined });
      expect((channel as any).extractContent(msg)).toBe('[richText message]');
    });

    it('returns placeholder for picture message', () => {
      const channel = new DingTalkChannel(createTestOpts());
      const msg = createRobotMessage({ msgtype: 'picture', text: undefined });
      expect((channel as any).extractContent(msg)).toBe('[picture message]');
    });

    it('returns placeholder for unknown message types', () => {
      const channel = new DingTalkChannel(createTestOpts());
      const msg = createRobotMessage({ msgtype: 'video', text: undefined });
      expect((channel as any).extractContent(msg)).toBe('[video message]');
    });

    it('handles text message with missing text field', () => {
      const channel = new DingTalkChannel(createTestOpts());
      const msg = createRobotMessage({ msgtype: 'text', text: undefined });
      expect((channel as any).extractContent(msg)).toBe('[text message]');
    });
  });

  // --- Mention handling (trigger prefix) ---

  describe('mention handling', () => {
    it('prepends @AssistantName for group messages', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      const msg = createRobotMessage({
        conversationType: '2', // group
        text: { content: 'help me with something' },
      });
      registeredCallback!(createDownstream(msg));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'conv123@dingtalk',
        expect.objectContaining({
          content: '@Andy help me with something',
        }),
      );
    });

    it('does not double-prepend when content already has trigger', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      const msg = createRobotMessage({
        conversationType: '2',
        text: { content: '@Andy help me' },
      });
      registeredCallback!(createDownstream(msg));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'conv123@dingtalk',
        expect.objectContaining({
          content: '@Andy help me',
        }),
      );
    });

    it('does not prepend trigger for DM messages', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dm_conv@dingtalk': {
            name: 'DM Chat',
            folder: 'dm',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      const msg = createRobotMessage({
        conversationId: 'dm_conv',
        conversationType: '1', // DM
        text: { content: 'hello' },
      });
      registeredCallback!(createDownstream(msg));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dm_conv@dingtalk',
        expect.objectContaining({
          content: 'hello',
        }),
      );
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      const msg = createRobotMessage();
      registeredCallback!(createDownstream(msg));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'conv123@dingtalk',
        expect.any(String),
        undefined,
        'dingtalk',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'conv123@dingtalk',
        expect.objectContaining({
          chat_jid: 'conv123@dingtalk',
          sender_name: 'Test User',
          is_from_me: false,
          is_bot_mentioned: true,
        }),
      );
    });

    it('only emits metadata for unregistered groups', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      const msg = createRobotMessage({ conversationId: 'unregistered_conv' });
      registeredCallback!(createDownstream(msg));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'unregistered_conv@dingtalk',
        expect.any(String),
        undefined,
        'dingtalk',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('uses senderId as fallback sender name', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      const msg = createRobotMessage({ senderNick: '', senderId: 'user_abc' });
      registeredCallback!(createDownstream(msg));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'conv123@dingtalk',
        expect.objectContaining({
          sender_name: 'user_abc',
        }),
      );
    });

    it('sets is_bot_mentioned to true for all messages', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      const msg = createRobotMessage();
      registeredCallback!(createDownstream(msg));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'conv123@dingtalk',
        expect.objectContaining({
          is_bot_mentioned: true,
        }),
      );
    });

    it('acknowledges message receipt', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      const msg = createRobotMessage();
      const downstream = createDownstream(msg, 'ack-test-id');
      registeredCallback!(downstream);

      expect(mockSocketCallBackResponse).toHaveBeenCalledWith('ack-test-id', {});
    });

    it('reports DM as non-group in metadata', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dm_conv@dingtalk': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      const msg = createRobotMessage({
        conversationId: 'dm_conv',
        conversationType: '1',
      });
      registeredCallback!(createDownstream(msg));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dm_conv@dingtalk',
        expect.any(String),
        undefined,
        'dingtalk',
        false,
      );
    });

    it('handles malformed message data gracefully', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      const downstream = {
        specVersion: '1.0',
        type: 'CALLBACK',
        headers: {
          appId: 'test',
          connectionId: 'conn1',
          contentType: 'application/json',
          messageId: 'bad-msg',
          time: new Date().toISOString(),
          topic: '/v1.0/im/bot/messages/get',
        },
        data: 'not-json',
      };

      // Should not throw
      registeredCallback!(downstream);
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('caches sessionWebhook from incoming messages', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      const webhookUrl = 'https://oapi.dingtalk.com/robot/sendBySession/abc123';
      const expiresAt = Date.now() + 2 * 60 * 60 * 1000;
      const msg = createRobotMessage({
        sessionWebhook: webhookUrl,
        sessionWebhookExpiredTime: expiresAt,
      });
      registeredCallback!(createDownstream(msg));

      // Now send a message — it should use the cached webhook
      await channel.sendMessage('conv123@dingtalk', 'reply');

      expect(mockFetch).toHaveBeenCalledWith(
        webhookUrl,
        expect.objectContaining({
          method: 'POST',
        }),
      );
    });
  });

  // --- Deduplication ---

  describe('deduplication', () => {
    it('deduplicates messages with same msgId', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      const msg = createRobotMessage({ msgId: 'dup_msg_1' });
      registeredCallback!(createDownstream(msg, 'ds1'));
      registeredCallback!(createDownstream(msg, 'ds2'));

      expect(opts.onMessage).toHaveBeenCalledTimes(1);
    });

    it('allows different msgIds', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      const msg1 = createRobotMessage({ msgId: 'unique_1' });
      const msg2 = createRobotMessage({ msgId: 'unique_2' });
      registeredCallback!(createDownstream(msg1));
      registeredCallback!(createDownstream(msg2));

      expect(opts.onMessage).toHaveBeenCalledTimes(2);
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends markdown via webhook when cached', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      // Prime webhook cache via incoming message
      const msg = createRobotMessage({
        sessionWebhook: 'https://example.com/webhook',
        sessionWebhookExpiredTime: Date.now() + 3600000,
      });
      registeredCallback!(createDownstream(msg));
      mockFetch.mockClear();

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ errcode: 0, errmsg: 'ok' }),
        text: () => Promise.resolve('ok'),
      });

      await channel.sendMessage('conv123@dingtalk', 'Hello **world**');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            msgtype: 'markdown',
            markdown: { title: 'Andy', text: 'Hello **world**' },
          }),
        }),
      );
    });

    it('falls back to OpenAPI when webhook expired', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      // Prime with expired webhook
      const msg = createRobotMessage({
        sessionWebhook: 'https://example.com/webhook',
        sessionWebhookExpiredTime: Date.now() - 1000, // already expired
      });
      registeredCallback!(createDownstream(msg));
      mockFetch.mockClear();

      // Mock token fetch + send
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ accessToken: 'tok123', expireIn: 7200 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve('ok'),
        });

      await channel.sendMessage('conv123@dingtalk', 'Hello');

      // First call: access token
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.dingtalk.com/v1.0/oauth2/accessToken',
        expect.any(Object),
      );
      // Second call: send message
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.dingtalk.com/v1.0/robot/groupMessages/send',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-acs-dingtalk-access-token': 'tok123',
          }),
        }),
      );
    });

    it('falls back to OpenAPI when no webhook cached', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ accessToken: 'tok_new', expireIn: 7200 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve('ok'),
        });

      await channel.sendMessage('new_conv@dingtalk', 'Proactive message');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.dingtalk.com/v1.0/oauth2/accessToken',
        expect.any(Object),
      );
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.dingtalk.com/v1.0/robot/groupMessages/send',
        expect.objectContaining({
          body: expect.stringContaining('new_conv'),
        }),
      );
    });

    it('falls back to OpenAPI when webhook send fails', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      // Prime webhook cache (group message)
      const msg = createRobotMessage({
        sessionWebhook: 'https://example.com/webhook',
        sessionWebhookExpiredTime: Date.now() + 3600000,
        conversationType: '2',
      });
      registeredCallback!(createDownstream(msg));
      mockFetch.mockClear();

      // Webhook fails, then token + OpenAPI succeed
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: () => Promise.resolve('Internal Server Error'),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ accessToken: 'fallback_tok', expireIn: 7200 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve('ok'),
        });

      await channel.sendMessage('conv123@dingtalk', 'Test');

      // First call: webhook (fails)
      expect(mockFetch.mock.calls[0][0]).toBe('https://example.com/webhook');
      // Second call: token fetch
      expect(mockFetch.mock.calls[1][0]).toBe('https://api.dingtalk.com/v1.0/oauth2/accessToken');
      // Third call: OpenAPI group send
      expect(mockFetch.mock.calls[2][0]).toBe('https://api.dingtalk.com/v1.0/robot/groupMessages/send');
    });

    it('falls back to OpenAPI when webhook errcode response fails', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      const msg = createRobotMessage({
        sessionWebhook: 'https://example.com/webhook',
        sessionWebhookExpiredTime: Date.now() + 3600000,
        conversationType: '2',
      });
      registeredCallback!(createDownstream(msg));
      mockFetch.mockClear();

      // Webhook returns errcode, then token + OpenAPI succeed
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ errcode: 310000, errmsg: 'token expired' }),
          text: () => Promise.resolve(''),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ accessToken: 'tok', expireIn: 7200 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve('ok'),
        });

      await channel.sendMessage('conv123@dingtalk', 'Test');

      // Should have fallen through to OpenAPI
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch.mock.calls[2][0]).toBe('https://api.dingtalk.com/v1.0/robot/groupMessages/send');
    });

    it('handles total send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      // No webhook cached, OpenAPI also fails
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ accessToken: 'tok', expireIn: 7200 }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: () => Promise.resolve('Server Error'),
        });

      // Should not throw
      await expect(
        channel.sendMessage('conv123@dingtalk', 'Test'),
      ).resolves.toBeUndefined();
    });

    it('strips @dingtalk suffix for API calls', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ accessToken: 'tok', expireIn: 7200 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve('ok'),
        });

      await channel.sendMessage('myconv@dingtalk', 'Test');

      const sendCall = mockFetch.mock.calls[1];
      const body = JSON.parse(sendCall[1].body);
      expect(body.openConversationId).toBe('myconv');
    });
  });

  // --- Access token ---

  describe('access token', () => {
    it('caches access token across calls', async () => {
      const channel = new DingTalkChannel(createTestOpts());
      await channel.connect();

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ accessToken: 'cached_tok', expireIn: 7200 }),
      });

      const token1 = await (channel as any).getAccessToken();
      const token2 = await (channel as any).getAccessToken();

      expect(token1).toBe('cached_tok');
      expect(token2).toBe('cached_tok');
      // Should only fetch once (second call uses cache)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('refreshes expired token', async () => {
      const channel = new DingTalkChannel(createTestOpts());
      await channel.connect();

      // First token: expires immediately (0 seconds)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: 'tok1', expireIn: 0 }),
      });

      const token1 = await (channel as any).getAccessToken();
      expect(token1).toBe('tok1');

      // Second call should refresh since token is expired
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: 'tok2', expireIn: 7200 }),
      });

      const token2 = await (channel as any).getAccessToken();
      expect(token2).toBe('tok2');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws on token fetch failure', async () => {
      const channel = new DingTalkChannel(createTestOpts());
      await channel.connect();

      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
      });

      await expect((channel as any).getAccessToken()).rejects.toThrow('Failed to get DingTalk access token');
    });
  });

  // --- Webhook caching ---

  describe('webhook caching', () => {
    it('uses webhook for same conversation', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      const webhookUrl = 'https://oapi.dingtalk.com/robot/sendBySession/xyz';
      const msg = createRobotMessage({
        sessionWebhook: webhookUrl,
        sessionWebhookExpiredTime: Date.now() + 7200000,
      });
      registeredCallback!(createDownstream(msg));
      mockFetch.mockClear();

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ errcode: 0, errmsg: 'ok' }),
        text: () => Promise.resolve('ok'),
      });

      await channel.sendMessage('conv123@dingtalk', 'test1');
      await channel.sendMessage('conv123@dingtalk', 'test2');

      // Both should use the cached webhook, no token fetch
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).toBe(webhookUrl);
      expect(mockFetch.mock.calls[1][0]).toBe(webhookUrl);
    });

    it('updates webhook cache on new message', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      // First message with webhook A
      const msg1 = createRobotMessage({
        msgId: 'msg_wh_1',
        sessionWebhook: 'https://example.com/webhook-a',
        sessionWebhookExpiredTime: Date.now() + 7200000,
      });
      registeredCallback!(createDownstream(msg1));

      // Second message with webhook B
      const msg2 = createRobotMessage({
        msgId: 'msg_wh_2',
        sessionWebhook: 'https://example.com/webhook-b',
        sessionWebhookExpiredTime: Date.now() + 7200000,
      });
      registeredCallback!(createDownstream(msg2));
      mockFetch.mockClear();

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ errcode: 0, errmsg: 'ok' }),
        text: () => Promise.resolve('ok'),
      });

      await channel.sendMessage('conv123@dingtalk', 'test');

      // Should use webhook B (latest)
      expect(mockFetch.mock.calls[0][0]).toBe('https://example.com/webhook-b');
    });
  });

  // --- DM OpenAPI sends ---

  describe('DM sends via OpenAPI', () => {
    it('uses oToMessages/batchSend for DM conversations', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dm_conv@dingtalk': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      // Prime DM sender cache + expired webhook via incoming DM
      const msg = createRobotMessage({
        conversationId: 'dm_conv',
        conversationType: '1', // DM
        senderStaffId: 'staff_user_1',
        senderId: 'sender_1',
        sessionWebhook: 'https://example.com/webhook',
        sessionWebhookExpiredTime: Date.now() - 1000, // expired
      });
      registeredCallback!(createDownstream(msg));
      mockFetch.mockClear();

      // Mock token + DM send
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ accessToken: 'dm_tok', expireIn: 7200 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve('ok'),
        });

      await channel.sendMessage('dm_conv@dingtalk', 'Hello DM');

      // Should use DM endpoint
      expect(mockFetch.mock.calls[1][0]).toBe('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend');
      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.userIds).toEqual(['staff_user_1']);
      expect(body.robotCode).toBe('test-robot-code');
    });

    it('caches DM sender from senderStaffId preferring over senderId', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dm2@dingtalk': {
            name: 'DM2',
            folder: 'dm2',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      // DM with both senderStaffId and senderId
      const msg = createRobotMessage({
        conversationId: 'dm2',
        conversationType: '1',
        senderStaffId: 'preferred_staff',
        senderId: 'fallback_sender',
        sessionWebhookExpiredTime: Date.now() - 1000,
      });
      registeredCallback!(createDownstream(msg));
      mockFetch.mockClear();

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ accessToken: 'tok', expireIn: 7200 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve('ok'),
        });

      await channel.sendMessage('dm2@dingtalk', 'test');

      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.userIds).toEqual(['preferred_staff']);
    });

    it('falls back to senderId when senderStaffId is empty', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dm3@dingtalk': {
            name: 'DM3',
            folder: 'dm3',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      const msg = createRobotMessage({
        conversationId: 'dm3',
        conversationType: '1',
        senderStaffId: '',
        senderId: 'fallback_id',
        sessionWebhookExpiredTime: Date.now() - 1000,
      });
      registeredCallback!(createDownstream(msg));
      mockFetch.mockClear();

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ accessToken: 'tok', expireIn: 7200 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve('ok'),
        });

      await channel.sendMessage('dm3@dingtalk', 'test');

      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.userIds).toEqual(['fallback_id']);
    });

    it('logs error when no cached sender for DM OpenAPI', async () => {
      const channel = new DingTalkChannel(createTestOpts());
      await channel.connect();

      // No incoming DM message, so no sender cached. Webhook not cached either.
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ accessToken: 'tok', expireIn: 7200 }),
        });

      // Create a DM webhook cache entry (to make it route to DM path) without sender
      (channel as any).webhookCache.set('no_sender_dm', {
        url: 'https://expired.com',
        expiresAt: Date.now() - 1000,
        isGroup: false,
      });

      // Should not throw (outer catch handles it)
      await expect(
        channel.sendMessage('no_sender_dm@dingtalk', 'Test'),
      ).resolves.toBeUndefined();
    });
  });

  // --- Message truncation ---

  describe('message truncation', () => {
    it('truncates messages over 20000 characters', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      // Prime webhook cache
      const msg = createRobotMessage({
        sessionWebhook: 'https://example.com/webhook',
        sessionWebhookExpiredTime: Date.now() + 3600000,
      });
      registeredCallback!(createDownstream(msg));
      mockFetch.mockClear();

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ errcode: 0, errmsg: 'ok' }),
        text: () => Promise.resolve('ok'),
      });

      const longText = 'x'.repeat(25000);
      await channel.sendMessage('conv123@dingtalk', longText);

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.markdown.text.length).toBeLessThanOrEqual(20000);
      expect(sentBody.markdown.text).toContain('...(truncated)');
    });

    it('does not truncate messages under limit', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel(opts);
      await channel.connect();

      const msg = createRobotMessage({
        sessionWebhook: 'https://example.com/webhook',
        sessionWebhookExpiredTime: Date.now() + 3600000,
      });
      registeredCallback!(createDownstream(msg));
      mockFetch.mockClear();

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ errcode: 0, errmsg: 'ok' }),
        text: () => Promise.resolve('ok'),
      });

      const normalText = 'Hello world';
      await channel.sendMessage('conv123@dingtalk', normalText);

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.markdown.text).toBe('Hello world');
    });
  });

  // --- Connection state ---

  describe('connection state', () => {
    it('reflects DWClient connected property', async () => {
      const channel = new DingTalkChannel(createTestOpts());
      await channel.connect();

      // Mock DWClient has connected: true
      expect(channel.isConnected()).toBe(true);
    });

    it('registers open/close event listeners', async () => {
      const channel = new DingTalkChannel(createTestOpts());
      await channel.connect();

      // Verify that 'open' and 'close' listeners were registered
      expect(mockEventListeners.has('open')).toBe(true);
      expect(mockEventListeners.has('close')).toBe(true);
    });
  });
});
