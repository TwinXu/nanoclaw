import { describe, it, expect, vi } from 'vitest';

import { findChannel, formatOutbound, routeOutbound } from './router.js';
import { Channel } from './types.js';

// --- Mock config ---

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Andy',
}));

// --- Helpers ---

function createMockChannel(overrides?: Partial<Channel>): Channel {
  return {
    name: 'mock',
    connect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    ownsJid: vi.fn().mockReturnValue(false),
    disconnect: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createWhatsAppChannel(): Channel {
  return createMockChannel({
    name: 'whatsapp',
    ownsJid: vi.fn((jid: string) => jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net')),
    prefixAssistantName: true,
  });
}

function createFeishuChannel(): Channel {
  return createMockChannel({
    name: 'feishu',
    ownsJid: vi.fn((jid: string) => jid.endsWith('@feishu')),
    prefixAssistantName: false,
  });
}

// --- Tests ---

describe('multi-channel routing', () => {
  describe('findChannel', () => {
    it('routes WhatsApp JID to WhatsApp channel', () => {
      const wa = createWhatsAppChannel();
      const feishu = createFeishuChannel();
      const channels = [wa, feishu];

      expect(findChannel(channels, 'group@g.us')).toBe(wa);
      expect(findChannel(channels, 'user@s.whatsapp.net')).toBe(wa);
    });

    it('routes Feishu JID to Feishu channel', () => {
      const wa = createWhatsAppChannel();
      const feishu = createFeishuChannel();
      const channels = [wa, feishu];

      expect(findChannel(channels, 'oc_abc123@feishu')).toBe(feishu);
      expect(findChannel(channels, 'ou_xyz@feishu')).toBe(feishu);
    });

    it('returns undefined for unknown JID', () => {
      const wa = createWhatsAppChannel();
      const feishu = createFeishuChannel();
      const channels = [wa, feishu];

      expect(findChannel(channels, 'unknown:123')).toBeUndefined();
    });

    it('returns undefined when no channels', () => {
      expect(findChannel([], 'group@g.us')).toBeUndefined();
    });

    it('works with single Feishu channel (WhatsApp disabled)', () => {
      const feishu = createFeishuChannel();
      const channels = [feishu];

      expect(findChannel(channels, 'oc_abc@feishu')).toBe(feishu);
      expect(findChannel(channels, 'group@g.us')).toBeUndefined();
    });
  });

  describe('formatOutbound', () => {
    it('prefixes assistant name for WhatsApp', () => {
      const wa = createWhatsAppChannel();
      const result = formatOutbound(wa, 'Hello');
      expect(result).toBe('Andy: Hello');
    });

    it('does not prefix assistant name for Feishu', () => {
      const feishu = createFeishuChannel();
      const result = formatOutbound(feishu, 'Hello');
      expect(result).toBe('Hello');
    });

    it('strips internal tags before formatting', () => {
      const feishu = createFeishuChannel();
      const result = formatOutbound(feishu, '<internal>thinking</internal>Result here');
      expect(result).toBe('Result here');
    });

    it('returns empty string for internal-only output', () => {
      const wa = createWhatsAppChannel();
      const result = formatOutbound(wa, '<internal>just thinking</internal>');
      expect(result).toBe('');
    });
  });

  describe('routeOutbound', () => {
    it('sends to correct channel based on JID', async () => {
      const wa = createWhatsAppChannel();
      const feishu = createFeishuChannel();
      const channels = [wa, feishu];

      await routeOutbound(channels, 'oc_abc@feishu', 'Hello Feishu');
      expect(feishu.sendMessage).toHaveBeenCalledWith('oc_abc@feishu', 'Hello Feishu');
      expect(wa.sendMessage).not.toHaveBeenCalled();

      await routeOutbound(channels, 'group@g.us', 'Hello WA');
      expect(wa.sendMessage).toHaveBeenCalledWith('group@g.us', 'Hello WA');
    });

    it('throws for unroutable JID', () => {
      const wa = createWhatsAppChannel();
      const channels = [wa];

      expect(() => routeOutbound(channels, 'oc_abc@feishu', 'msg')).toThrow('No channel for JID');
    });
  });

  describe('ownsJid cross-channel isolation', () => {
    it('WhatsApp does not own Feishu JIDs', () => {
      const wa = createWhatsAppChannel();
      expect(wa.ownsJid('oc_abc@feishu')).toBe(false);
    });

    it('Feishu does not own WhatsApp JIDs', () => {
      const feishu = createFeishuChannel();
      expect(feishu.ownsJid('group@g.us')).toBe(false);
      expect(feishu.ownsJid('user@s.whatsapp.net')).toBe(false);
    });
  });
});

describe('getAvailableGroups filter (channel-aware)', () => {
  // getAvailableGroups depends on DB (better-sqlite3) which has binding issues
  // in this environment. Test the filter logic directly instead.

  it('channels.some(ch => ch.ownsJid(jid)) correctly filters by channel', () => {
    const wa = createWhatsAppChannel();
    const feishu = createFeishuChannel();
    const channels = [wa, feishu];

    const testJids = [
      { jid: 'group@g.us', expected: true },
      { jid: 'user@s.whatsapp.net', expected: true },
      { jid: 'oc_abc@feishu', expected: true },
      { jid: '__group_sync__', expected: false },
      { jid: 'random:123', expected: false },
    ];

    for (const { jid, expected } of testJids) {
      const passes = jid !== '__group_sync__' && channels.some((ch) => ch.ownsJid(jid));
      expect(passes, `Expected ${jid} to ${expected ? 'pass' : 'fail'} filter`).toBe(expected);
    }
  });

  it('filter works with Feishu-only (WhatsApp disabled)', () => {
    const feishu = createFeishuChannel();
    const channels = [feishu];

    expect(channels.some((ch) => ch.ownsJid('oc_abc@feishu'))).toBe(true);
    expect(channels.some((ch) => ch.ownsJid('group@g.us'))).toBe(false);
  });

  it('filter works with WhatsApp-only (no Feishu)', () => {
    const wa = createWhatsAppChannel();
    const channels = [wa];

    expect(channels.some((ch) => ch.ownsJid('group@g.us'))).toBe(true);
    expect(channels.some((ch) => ch.ownsJid('oc_abc@feishu'))).toBe(false);
  });
});
