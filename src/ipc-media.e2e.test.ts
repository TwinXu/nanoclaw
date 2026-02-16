/**
 * E2E tests for the IPC media pipeline.
 *
 * Exercises the real filesystem flow:
 *   agent writes request → host IPC watcher picks it up → deps called → response written
 *
 * Uses a temporary DATA_DIR and resets the IPC watcher singleton between runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// --- Mock config to use a temp DATA_DIR ---
let tmpDir: string;

vi.mock('./config.js', () => {
  // Create tmpDir at module load time so it's ready for imports
  const _os = require('os');
  const _path = require('path');
  const _fs = require('fs');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'nanoclaw-e2e-'));
  // Export a getter so tests can read the value
  return {
    get DATA_DIR() {
      return dir;
    },
    ASSISTANT_NAME: 'Andy',
    IPC_POLL_INTERVAL: 100, // fast polling for tests
    MAIN_GROUP_FOLDER: 'main',
    TIMEZONE: 'UTC',
    __tmpDir: dir,
  };
});

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./db.js', () => ({
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
  getAllTasks: vi.fn(() => []),
}));

import { startIpcWatcher, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Access the temp dir from the mock
const config = await import('./config.js');
tmpDir = (config as unknown as { __tmpDir: string }).__tmpDir;

// --- Helpers ---

function writeJsonFile(dir: string, filename: string, data: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${filename}.tmp`);
  const dest = path.join(dir, filename);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, dest);
}

/** Wait for a condition to become true, with timeout. */
async function waitFor(
  fn: () => boolean,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// --- Test setup ---

const GROUPS: Record<string, RegisteredGroup> = {
  'chat1@feishu': {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@Andy',
    added_at: '2024-01-01T00:00:00.000Z',
  },
  'main-chat@feishu': {
    name: 'Main',
    folder: 'main',
    trigger: 'always',
    added_at: '2024-01-01T00:00:00.000Z',
  },
};

let deps: IpcDeps;
let sendImageCalls: Array<{ jid: string; filePath: string; caption?: string }>;
let downloadMediaCalls: Array<{
  chatJid: string;
  messageId: string;
  fileKey: string;
  destDir: string;
  requestId: string;
}>;
let watcherStarted = false;

// Stable mock functions that persist across tests (watcher captures deps once)
let downloadMediaImpl: IpcDeps['downloadMedia'];

sendImageCalls = [];
downloadMediaCalls = [];

// Default: successful download
downloadMediaImpl = async (chatJid, messageId, fileKey, destDir, requestId) => {
  downloadMediaCalls.push({ chatJid, messageId, fileKey, destDir, requestId });
  const filename = `${requestId}.png`;
  fs.writeFileSync(path.join(destDir, filename), 'fake-image-data');
  return filename;
};

deps = {
  sendMessage: vi.fn(),
  sendImage: vi.fn(async (jid, filePath, caption) => {
    sendImageCalls.push({ jid, filePath, caption });
  }),
  downloadMedia: vi.fn(async (...args: Parameters<IpcDeps['downloadMedia']>) => {
    return downloadMediaImpl(...args);
  }),
  registeredGroups: () => GROUPS,
  registerGroup: vi.fn(),
  syncGroupMetadata: vi.fn(),
  getAvailableGroups: () => [],
  writeGroupsSnapshot: vi.fn(),
};

// Create IPC directories once
const ipcBase = path.join(tmpDir, 'ipc');
for (const group of ['test-group', 'main']) {
  for (const sub of ['messages', 'tasks', 'media', 'media-requests']) {
    fs.mkdirSync(path.join(ipcBase, group, sub), { recursive: true });
  }
}

beforeEach(() => {
  sendImageCalls = [];
  downloadMediaCalls = [];
  // Reset to default successful implementation
  downloadMediaImpl = async (chatJid, messageId, fileKey, destDir, requestId) => {
    downloadMediaCalls.push({ chatJid, messageId, fileKey, destDir, requestId });
    const filename = `${requestId}.png`;
    fs.writeFileSync(path.join(destDir, filename), 'fake-image-data');
    return filename;
  };
  vi.clearAllMocks();
});

afterEach(() => {
  // Clean up only message and media-request files (media files may be checked by assertions)
  const ipcBase = path.join(tmpDir, 'ipc');
  if (fs.existsSync(ipcBase)) {
    for (const group of fs.readdirSync(ipcBase)) {
      const groupDir = path.join(ipcBase, group);
      if (!fs.statSync(groupDir).isDirectory()) continue;
      for (const sub of ['messages', 'media-requests']) {
        const subDir = path.join(groupDir, sub);
        if (!fs.existsSync(subDir)) continue;
        for (const file of fs.readdirSync(subDir)) {
          try { fs.unlinkSync(path.join(subDir, file)); } catch { /* ok */ }
        }
      }
    }
  }
});

// Start the watcher once for all tests (singleton)
function ensureWatcher() {
  if (!watcherStarted) {
    startIpcWatcher(deps);
    watcherStarted = true;
  }
}

// --- E2E Tests ---

describe('IPC media pipeline e2e', () => {
  it('processes media_request and calls downloadMedia', async () => {
    ensureWatcher();

    const requestId = `e2e-${Date.now()}`;
    const mediaRequestsDir = path.join(tmpDir, 'ipc', 'test-group', 'media-requests');
    const mediaDir = path.join(tmpDir, 'ipc', 'test-group', 'media');

    // Write a media request (as the agent would)
    writeJsonFile(mediaRequestsDir, `${requestId}.json`, {
      type: 'media_request',
      requestId,
      messageId: 'msg_test_123',
      imageKey: 'img_key_abc',
      chatJid: 'chat1@feishu',
    });

    // Wait for the watcher to process it
    await waitFor(() => downloadMediaCalls.length > 0);

    // Verify downloadMedia was called with correct args
    expect(downloadMediaCalls[0]).toEqual({
      chatJid: 'chat1@feishu',
      messageId: 'msg_test_123',
      fileKey: 'img_key_abc',
      destDir: mediaDir,
      requestId,
    });

    // Verify the request file was cleaned up
    await waitFor(
      () => !fs.existsSync(path.join(mediaRequestsDir, `${requestId}.json`)),
    );

    // Verify the "downloaded" file exists in media/
    expect(fs.existsSync(path.join(mediaDir, `${requestId}.png`))).toBe(true);
  });

  it('writes error file when downloadMedia returns null', async () => {
    ensureWatcher();

    // Override to simulate download failure
    downloadMediaImpl = async (chatJid, messageId, fileKey, destDir, requestId) => {
      downloadMediaCalls.push({ chatJid, messageId, fileKey, destDir, requestId });
      return null;
    };

    const requestId = `e2e-fail-${Date.now()}`;
    const mediaRequestsDir = path.join(tmpDir, 'ipc', 'test-group', 'media-requests');
    const mediaDir = path.join(tmpDir, 'ipc', 'test-group', 'media');

    writeJsonFile(mediaRequestsDir, `${requestId}.json`, {
      type: 'media_request',
      requestId,
      messageId: 'msg_expired',
      imageKey: 'img_expired',
      chatJid: 'chat1@feishu',
    });

    // Wait for error file to appear
    const errorFile = path.join(mediaDir, `${requestId}.error`);
    await waitFor(() => fs.existsSync(errorFile));

    const errorData = JSON.parse(fs.readFileSync(errorFile, 'utf-8'));
    expect(errorData.error).toBe('Download failed');
    expect(errorData.messageId).toBe('msg_expired');
  });

  it('writes error file when chatJid is missing', async () => {
    ensureWatcher();

    const requestId = `e2e-nojid-${Date.now()}`;
    const mediaRequestsDir = path.join(tmpDir, 'ipc', 'test-group', 'media-requests');
    const mediaDir = path.join(tmpDir, 'ipc', 'test-group', 'media');

    writeJsonFile(mediaRequestsDir, `${requestId}.json`, {
      type: 'media_request',
      requestId,
      messageId: 'msg_nojid',
      imageKey: 'img_nojid',
      // chatJid intentionally omitted
    });

    const errorFile = path.join(mediaDir, `${requestId}.error`);
    await waitFor(() => fs.existsSync(errorFile));

    const errorData = JSON.parse(fs.readFileSync(errorFile, 'utf-8'));
    expect(errorData.error).toBe('Missing chatJid in request');

    // Verify logger.warn was called
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ requestId }),
      'Media request missing chatJid',
    );
  });

  it('processes image_message and calls sendImage with correct host path', async () => {
    ensureWatcher();

    // Create a fake image file in the media directory (as if agent put it there)
    const mediaDir = path.join(tmpDir, 'ipc', 'test-group', 'media');
    const fakeImage = path.join(mediaDir, 'output.png');
    fs.writeFileSync(fakeImage, 'fake-png');

    const messagesDir = path.join(tmpDir, 'ipc', 'test-group', 'messages');

    writeJsonFile(messagesDir, `img-${Date.now()}.json`, {
      type: 'image_message',
      chatJid: 'chat1@feishu',
      filePath: '/workspace/ipc/media/output.png',
      caption: 'Look at this!',
      groupFolder: 'test-group',
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => sendImageCalls.length > 0);

    // Verify sendImage was called with the translated host path
    expect(sendImageCalls[0].jid).toBe('chat1@feishu');
    expect(sendImageCalls[0].filePath).toBe(
      path.resolve(path.join(tmpDir, 'ipc', 'test-group', 'media', 'output.png')),
    );
    expect(sendImageCalls[0].caption).toBe('Look at this!');

    // Verify the message file was cleaned up
    await waitFor(() => {
      const files = fs.readdirSync(messagesDir).filter((f) => f.endsWith('.json'));
      return files.length === 0;
    });
  });

  it('blocks image_message with path traversal', async () => {
    ensureWatcher();

    const messagesDir = path.join(tmpDir, 'ipc', 'test-group', 'messages');

    writeJsonFile(messagesDir, `traversal-${Date.now()}.json`, {
      type: 'image_message',
      chatJid: 'chat1@feishu',
      filePath: '/workspace/ipc/media/../../../etc/passwd',
      groupFolder: 'test-group',
      timestamp: new Date().toISOString(),
    });

    // Wait for the file to be processed (deleted)
    await waitFor(() => {
      const files = fs.readdirSync(messagesDir).filter((f) => f.endsWith('.json'));
      return files.length === 0;
    });

    // sendImage should NOT have been called
    expect(sendImageCalls).toHaveLength(0);

    // Verify path traversal was logged
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/workspace/ipc/media/../../../etc/passwd' }),
      'IPC image path traversal attempt blocked',
    );
  });

  it('blocks image_message from unauthorized group', async () => {
    ensureWatcher();

    const messagesDir = path.join(tmpDir, 'ipc', 'test-group', 'messages');

    // test-group trying to send to main-chat (not its own)
    writeJsonFile(messagesDir, `unauth-${Date.now()}.json`, {
      type: 'image_message',
      chatJid: 'main-chat@feishu',
      filePath: '/workspace/ipc/media/image.png',
      groupFolder: 'test-group',
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => {
      const files = fs.readdirSync(messagesDir).filter((f) => f.endsWith('.json'));
      return files.length === 0;
    });

    expect(sendImageCalls).toHaveLength(0);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ chatJid: 'main-chat@feishu', sourceGroup: 'test-group' }),
      'Unauthorized IPC image message attempt blocked',
    );
  });

  it('main group can send image to any chat', async () => {
    ensureWatcher();

    const messagesDir = path.join(tmpDir, 'ipc', 'main', 'messages');
    const mediaDir = path.join(tmpDir, 'ipc', 'main', 'media');
    fs.writeFileSync(path.join(mediaDir, 'admin-img.png'), 'admin-png');

    writeJsonFile(messagesDir, `main-img-${Date.now()}.json`, {
      type: 'image_message',
      chatJid: 'chat1@feishu',
      filePath: '/workspace/ipc/media/admin-img.png',
      groupFolder: 'main',
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => sendImageCalls.length > 0);

    expect(sendImageCalls[0].jid).toBe('chat1@feishu');
    expect(sendImageCalls[0].filePath).toBe(
      path.resolve(path.join(tmpDir, 'ipc', 'main', 'media', 'admin-img.png')),
    );
  });
});
