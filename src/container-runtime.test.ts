import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process
const mockExecSync = vi.fn();
const mockExecFileSync = vi.fn();
const mockExecFile = vi.fn(
  (_bin: string, _args: string[], _opts: unknown, cb?: (err: Error | null) => void) => {
    if (cb) cb(null);
  },
);
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  execFile: (...args: unknown[]) => (mockExecFile as (...a: unknown[]) => unknown)(...args),
}));

import {
  getRuntime,
  getRuntimeBinary,
  buildMountArg,
  ensureRuntimeRunning,
  listRunningContainers,
  stopContainer,
  stopContainerAsync,
  _resetRuntimeCache,
} from './container-runtime.js';

describe('container-runtime', () => {
  beforeEach(() => {
    _resetRuntimeCache();
    delete process.env.CONTAINER_RUNTIME;
    mockExecSync.mockReset();
    mockExecFileSync.mockReset();
    mockExecFile.mockReset();
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
      },
    );
  });

  afterEach(() => {
    delete process.env.CONTAINER_RUNTIME;
  });

  describe('getRuntime', () => {
    it('uses CONTAINER_RUNTIME env var when set to apple-container', () => {
      process.env.CONTAINER_RUNTIME = 'apple-container';
      expect(getRuntime()).toBe('apple-container');
    });

    it('uses CONTAINER_RUNTIME env var when set to docker', () => {
      process.env.CONTAINER_RUNTIME = 'docker';
      expect(getRuntime()).toBe('docker');
    });

    it('throws on invalid CONTAINER_RUNTIME value', () => {
      process.env.CONTAINER_RUNTIME = 'podman';
      expect(() => getRuntime()).toThrow('Invalid CONTAINER_RUNTIME="podman"');
    });

    it('detects apple-container by probing CLI', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'container --version') return 'container 1.0';
        throw new Error('not found');
      });
      expect(getRuntime()).toBe('apple-container');
    });

    it('falls back to docker when apple-container not available', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'docker --version') return 'Docker version 24.0.0';
        throw new Error('not found');
      });
      expect(getRuntime()).toBe('docker');
    });

    it('throws when no runtime is available', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });
      expect(() => getRuntime()).toThrow('No container runtime found');
    });

    it('caches the result after first call', () => {
      process.env.CONTAINER_RUNTIME = 'docker';
      getRuntime();
      getRuntime();
      // execSync should not be called since env var was used
      expect(mockExecSync).not.toHaveBeenCalled();
    });
  });

  describe('getRuntimeBinary', () => {
    it('returns "container" for apple-container', () => {
      process.env.CONTAINER_RUNTIME = 'apple-container';
      expect(getRuntimeBinary()).toBe('container');
    });

    it('returns "docker" for docker', () => {
      process.env.CONTAINER_RUNTIME = 'docker';
      expect(getRuntimeBinary()).toBe('docker');
    });
  });

  describe('buildMountArg', () => {
    describe('apple-container runtime', () => {
      beforeEach(() => {
        process.env.CONTAINER_RUNTIME = 'apple-container';
      });

      it('uses --mount for readonly mounts', () => {
        const args = buildMountArg({
          hostPath: '/host/path',
          containerPath: '/container/path',
          readonly: true,
        });
        expect(args).toEqual([
          '--mount',
          'type=bind,source=/host/path,target=/container/path,readonly',
        ]);
      });

      it('uses -v for read-write mounts', () => {
        const args = buildMountArg({
          hostPath: '/host/path',
          containerPath: '/container/path',
          readonly: false,
        });
        expect(args).toEqual(['-v', '/host/path:/container/path']);
      });
    });

    describe('docker runtime', () => {
      beforeEach(() => {
        process.env.CONTAINER_RUNTIME = 'docker';
      });

      it('uses -v with :ro for readonly mounts', () => {
        const args = buildMountArg({
          hostPath: '/host/path',
          containerPath: '/container/path',
          readonly: true,
        });
        expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
      });

      it('uses -v without :ro for read-write mounts', () => {
        const args = buildMountArg({
          hostPath: '/host/path',
          containerPath: '/container/path',
          readonly: false,
        });
        expect(args).toEqual(['-v', '/host/path:/container/path']);
      });
    });
  });

  describe('ensureRuntimeRunning', () => {
    it('checks apple-container system status when running', () => {
      process.env.CONTAINER_RUNTIME = 'apple-container';
      mockExecSync.mockReturnValue('');
      ensureRuntimeRunning();
      expect(mockExecSync).toHaveBeenCalledWith(
        'container system status',
        expect.objectContaining({ stdio: 'pipe' }),
      );
    });

    it('auto-starts apple-container when not running', () => {
      process.env.CONTAINER_RUNTIME = 'apple-container';
      let callCount = 0;
      mockExecSync.mockImplementation((cmd: string) => {
        callCount++;
        if (cmd === 'container system status' && callCount === 1) {
          throw new Error('not running');
        }
        return '';
      });
      ensureRuntimeRunning();
      expect(mockExecSync).toHaveBeenCalledWith(
        'container system start',
        expect.objectContaining({ stdio: 'pipe', timeout: 30000 }),
      );
    });

    it('throws when apple-container fails to start', () => {
      process.env.CONTAINER_RUNTIME = 'apple-container';
      mockExecSync.mockImplementation(() => {
        throw new Error('failed');
      });
      expect(() => ensureRuntimeRunning()).toThrow('Apple Container system is required but failed to start');
    });

    it('checks docker info when docker runtime', () => {
      process.env.CONTAINER_RUNTIME = 'docker';
      mockExecSync.mockReturnValue('');
      ensureRuntimeRunning();
      expect(mockExecSync).toHaveBeenCalledWith(
        'docker info',
        expect.objectContaining({ stdio: 'pipe', timeout: 10000 }),
      );
    });

    it('throws when docker is not running', () => {
      process.env.CONTAINER_RUNTIME = 'docker';
      mockExecSync.mockImplementation(() => {
        throw new Error('not running');
      });
      expect(() => ensureRuntimeRunning()).toThrow('Docker is required but not running');
    });
  });

  describe('listRunningContainers', () => {
    it('parses apple-container JSON format', () => {
      process.env.CONTAINER_RUNTIME = 'apple-container';
      mockExecFileSync.mockReturnValue(JSON.stringify([
        { status: 'running', configuration: { id: 'nanoclaw-test-1' } },
        { status: 'running', configuration: { id: 'nanoclaw-test-2' } },
        { status: 'running', configuration: { id: 'other-container' } },
      ]));

      const result = listRunningContainers('nanoclaw-');
      expect(result).toEqual([
        { name: 'nanoclaw-test-1', status: 'running' },
        { name: 'nanoclaw-test-2', status: 'running' },
      ]);
    });

    it('parses docker ps format', () => {
      process.env.CONTAINER_RUNTIME = 'docker';
      mockExecFileSync.mockReturnValue(
        'nanoclaw-test-1\tUp 5 minutes\nnanoclaw-test-2\tUp 10 minutes\n',
      );

      const result = listRunningContainers('nanoclaw-');
      expect(result).toEqual([
        { name: 'nanoclaw-test-1', status: 'Up 5 minutes' },
        { name: 'nanoclaw-test-2', status: 'Up 10 minutes' },
      ]);
    });

    it('passes args array to execFileSync (no shell injection)', () => {
      process.env.CONTAINER_RUNTIME = 'docker';
      mockExecFileSync.mockReturnValue('');

      listRunningContainers('nanoclaw-');
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        ['ps', '--filter', 'name=nanoclaw-', '--format', '{{.Names}}\t{{.Status}}'],
        expect.any(Object),
      );
    });

    it('returns empty array on error', () => {
      process.env.CONTAINER_RUNTIME = 'docker';
      mockExecFileSync.mockImplementation(() => {
        throw new Error('docker not running');
      });

      const result = listRunningContainers('nanoclaw-');
      expect(result).toEqual([]);
    });

    it('returns empty array for empty output', () => {
      process.env.CONTAINER_RUNTIME = 'docker';
      mockExecFileSync.mockReturnValue('');

      const result = listRunningContainers('nanoclaw-');
      expect(result).toEqual([]);
    });
  });

  describe('stopContainer', () => {
    it('calls execFileSync with correct args', () => {
      process.env.CONTAINER_RUNTIME = 'docker';
      stopContainer('nanoclaw-test-123');
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        ['stop', 'nanoclaw-test-123'],
        expect.objectContaining({ stdio: 'pipe', timeout: 15000 }),
      );
    });

    it('does not throw when container already stopped', () => {
      process.env.CONTAINER_RUNTIME = 'docker';
      mockExecFileSync.mockImplementation(() => {
        throw new Error('No such container');
      });
      expect(() => stopContainer('nonexistent')).not.toThrow();
    });
  });

  describe('stopContainerAsync', () => {
    it('calls execFile with correct args', async () => {
      process.env.CONTAINER_RUNTIME = 'docker';
      await stopContainerAsync('nanoclaw-test-456');
      expect(mockExecFile).toHaveBeenCalledWith(
        'docker',
        ['stop', 'nanoclaw-test-456'],
        expect.objectContaining({ timeout: 15000 }),
        expect.any(Function),
      );
    });

    it('resolves even when exec fails', async () => {
      process.env.CONTAINER_RUNTIME = 'docker';
      mockExecFile.mockImplementation(
        (_bin: string, _args: string[], _opts: unknown, cb?: (err: Error | null) => void) => {
          if (cb) cb(new Error('stop failed'));
        },
      );
      // Should not reject
      await expect(stopContainerAsync('failing-container')).resolves.toBeUndefined();
    });

    it('uses custom timeout', async () => {
      process.env.CONTAINER_RUNTIME = 'apple-container';
      await stopContainerAsync('test', 5000);
      expect(mockExecFile).toHaveBeenCalledWith(
        'container',
        ['stop', 'test'],
        expect.objectContaining({ timeout: 5000 }),
        expect.any(Function),
      );
    });
  });
});
