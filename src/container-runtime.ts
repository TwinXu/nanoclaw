/**
 * Container Runtime Abstraction for NanoClaw
 *
 * Auto-detects Apple Container or Docker and provides a unified interface
 * for mount args, lifecycle commands, and health checks.
 */
import { execFile, execFileSync, execSync } from 'child_process';

import { logger } from './logger.js';

export type ContainerRuntime = 'apple-container' | 'docker';

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

let cachedRuntime: ContainerRuntime | null = null;

/**
 * Detect and return the container runtime.
 * Checks CONTAINER_RUNTIME env var first, then probes for available CLIs.
 * Result is cached after first call.
 */
export function getRuntime(): ContainerRuntime {
  if (cachedRuntime) return cachedRuntime;

  const envRuntime = process.env.CONTAINER_RUNTIME;
  if (envRuntime) {
    if (envRuntime !== 'apple-container' && envRuntime !== 'docker') {
      throw new Error(
        `Invalid CONTAINER_RUNTIME="${envRuntime}". Must be "apple-container" or "docker".`,
      );
    }
    cachedRuntime = envRuntime;
    logger.info({ runtime: cachedRuntime }, 'Container runtime set via CONTAINER_RUNTIME env var');
    return cachedRuntime;
  }

  // Probe Apple Container first (more specific)
  try {
    execSync('container --version', { stdio: 'pipe', timeout: 5000 });
    cachedRuntime = 'apple-container';
    logger.info({ runtime: cachedRuntime }, 'Detected container runtime');
    return cachedRuntime;
  } catch {
    // Not available
  }

  // Probe Docker
  try {
    execSync('docker --version', { stdio: 'pipe', timeout: 5000 });
    cachedRuntime = 'docker';
    logger.info({ runtime: cachedRuntime }, 'Detected container runtime');
    return cachedRuntime;
  } catch {
    // Not available
  }

  throw new Error(
    'No container runtime found. Install Apple Container (macOS 26+) or Docker.',
  );
}

/**
 * Return the CLI binary name for the detected runtime.
 */
export function getRuntimeBinary(): string {
  const runtime = getRuntime();
  return runtime === 'apple-container' ? 'container' : 'docker';
}

/**
 * Build CLI args for a single volume mount.
 *
 * Apple Container: readonly uses --mount, read-write uses -v
 * Docker: always uses -v with optional :ro suffix
 */
export function buildMountArg(mount: VolumeMount): string[] {
  const runtime = getRuntime();

  if (runtime === 'apple-container') {
    if (mount.readonly) {
      return [
        '--mount',
        `type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`,
      ];
    }
    return ['-v', `${mount.hostPath}:${mount.containerPath}`];
  }

  // Docker: -v with optional :ro suffix
  if (mount.readonly) {
    return ['-v', `${mount.hostPath}:${mount.containerPath}:ro`];
  }
  return ['-v', `${mount.hostPath}:${mount.containerPath}`];
}

/**
 * Ensure the container runtime is running and ready.
 * Apple Container: check system status, auto-start if needed.
 * Docker: check `docker info`.
 */
export function ensureRuntimeRunning(): void {
  const runtime = getRuntime();

  if (runtime === 'apple-container') {
    try {
      execSync('container system status', { stdio: 'pipe' });
      logger.debug('Apple Container system already running');
    } catch {
      logger.info('Starting Apple Container system...');
      try {
        execSync('container system start', { stdio: 'pipe', timeout: 30000 });
        logger.info('Apple Container system started');
      } catch (err) {
        logger.error({ err }, 'Failed to start Apple Container system');
        console.error(
          '\n' +
          '+-----------------------------------------------------------------+\n' +
          '|  FATAL: Apple Container system failed to start                  |\n' +
          '|                                                                 |\n' +
          '|  Agents cannot run without Apple Container. To fix:             |\n' +
          '|  1. Install from: https://github.com/apple/container/releases  |\n' +
          '|  2. Run: container system start                                 |\n' +
          '|  3. Restart NanoClaw                                            |\n' +
          '+-----------------------------------------------------------------+\n',
        );
        throw new Error('Apple Container system is required but failed to start');
      }
    }
  } else {
    try {
      execSync('docker info', { stdio: 'pipe', timeout: 10000 });
      logger.debug('Docker daemon is running');
    } catch {
      logger.error('Docker daemon is not running');
      console.error(
        '\n' +
        '+-----------------------------------------------------------------+\n' +
        '|  FATAL: Docker is not running                                   |\n' +
        '|                                                                 |\n' +
        '|  Agents cannot run without Docker. To fix:                      |\n' +
        '|  macOS: Start Docker Desktop or OrbStack                        |\n' +
        '|  Linux: sudo systemctl start docker                             |\n' +
        '|                                                                 |\n' +
        '|  Install from: https://docker.com/products/docker-desktop       |\n' +
        '+-----------------------------------------------------------------+\n',
      );
      throw new Error('Docker is required but not running');
    }
  }

  logger.info({ runtime }, 'Container runtime ready');
}

interface RunningContainer {
  name: string;
  status: string;
}

/**
 * List running containers with names starting with the given prefix.
 * Returns a normalized list regardless of runtime.
 */
export function listRunningContainers(prefix: string): RunningContainer[] {
  const runtime = getRuntime();
  const binary = getRuntimeBinary();

  try {
    if (runtime === 'apple-container') {
      const output = execFileSync(binary, ['ls', '--format', 'json'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      const containers: { status: string; configuration: { id: string } }[] =
        JSON.parse(output || '[]');
      return containers
        .filter((c) => c.configuration.id.startsWith(prefix))
        .map((c) => ({ name: c.configuration.id, status: c.status }));
    }

    // Docker: use --format to get structured output
    const output = execFileSync(
      binary,
      ['ps', '--filter', `name=${prefix}`, '--format', '{{.Names}}\t{{.Status}}'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    return output
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name, ...statusParts] = line.split('\t');
        return { name, status: statusParts.join('\t') };
      });
  } catch (err) {
    logger.warn({ err, runtime }, 'Failed to list running containers');
    return [];
  }
}

/**
 * Stop a container by name (synchronous).
 */
export function stopContainer(name: string): void {
  const binary = getRuntimeBinary();
  try {
    execFileSync(binary, ['stop', name], { stdio: 'pipe', timeout: 15000 });
  } catch {
    // Already stopped or doesn't exist
  }
}

/**
 * Stop a container by name (async, with timeout).
 * Used in timeout handlers where we don't want to block.
 */
export function stopContainerAsync(
  name: string,
  timeout = 15000,
): Promise<void> {
  const binary = getRuntimeBinary();
  return new Promise((resolve) => {
    execFile(binary, ['stop', name], { timeout }, (err) => {
      if (err) {
        logger.warn({ name, err }, 'Async container stop failed');
      }
      resolve();
    });
  });
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const orphans = listRunningContainers('nanoclaw-')
      .filter((c) => c.status === 'running' || c.status.startsWith('Up'));
    for (const { name } of orphans) {
      stopContainer(name);
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans.map((c) => c.name) },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

/** Reset cached runtime (for testing) */
export function _resetRuntimeCache(): void {
  cachedRuntime = null;
}
