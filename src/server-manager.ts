import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ServerManagementConfig } from './types.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function pingTranslationServer(serverUrl: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(serverUrl.replace(/\/+$/, '/'), { method: 'GET', signal: controller.signal });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function parseHost(serverUrl: string): string {
  return new URL(serverUrl).hostname;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPidFile(pidFile: string): Promise<number | null> {
  try {
    const raw = await fsp.readFile(pidFile, 'utf8');
    const pid = Number(raw.trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      return null;
    }
    return pid;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function removePidFileIfExists(pidFile: string): Promise<void> {
  try {
    await fsp.unlink(pidFile);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw error;
    }
  }
}

export interface NodeServerStatus {
  reachable: boolean;
  pid: number | null;
  process: 'running' | 'stopped' | 'missing';
}

export class NodeTranslationServerManager {
  constructor(private readonly settings: ServerManagementConfig) {}

  async status(serverUrl: string, timeoutMs: number): Promise<NodeServerStatus> {
    const reachable = await pingTranslationServer(serverUrl, Math.min(3000, timeoutMs));
    const pid = await readPidFile(this.settings.pidFile);

    if (!pid) {
      return { reachable, pid: null, process: 'missing' };
    }

    if (isProcessRunning(pid)) {
      return { reachable, pid, process: 'running' };
    }

    return { reachable, pid, process: 'stopped' };
  }

  async start(serverUrl: string): Promise<void> {
    const host = parseHost(serverUrl);
    if (host !== '127.0.0.1' && host !== 'localhost') {
      throw new Error(`Server management only supports localhost URLs. Got host: ${host}`);
    }

    const currentPid = await readPidFile(this.settings.pidFile);
    if (currentPid && isProcessRunning(currentPid)) {
      return;
    }

    if (!this.settings.sourcePath || this.settings.sourcePath.trim() === '') {
      throw new Error('serverManagement.sourcePath is empty. Point it to your translation-server checkout.');
    }

    const sourcePath = path.resolve(this.settings.sourcePath);
    const serverEntry = path.join(sourcePath, 'src', 'server.js');

    try {
      await fsp.access(serverEntry);
    } catch {
      throw new Error(`Translation Server entry not found at ${serverEntry}`);
    }

    await fsp.mkdir(path.dirname(this.settings.pidFile), { recursive: true });
    await fsp.mkdir(path.dirname(this.settings.logFile), { recursive: true });

    const out = fs.openSync(this.settings.logFile, 'a');

    const child = spawn(this.settings.nodeCommand, ['src/server.js'], {
      cwd: sourcePath,
      detached: true,
      stdio: ['ignore', out, out],
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV || 'production'
      }
    });

    child.unref();

    await fsp.writeFile(this.settings.pidFile, `${child.pid}\n`, 'utf8');

    const deadline = Date.now() + this.settings.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (await pingTranslationServer(serverUrl, 1500)) {
        return;
      }

      if (!isProcessRunning(child.pid ?? -1)) {
        await removePidFileIfExists(this.settings.pidFile);
        throw new Error(`Translation Server process exited early. Check logs at ${this.settings.logFile}`);
      }

      await sleep(this.settings.pollIntervalMs);
    }

    throw new Error(`Translation Server did not become ready within ${this.settings.startupTimeoutMs}ms`);
  }

  async stop(): Promise<void> {
    const pid = await readPidFile(this.settings.pidFile);
    if (!pid) {
      return;
    }

    if (!isProcessRunning(pid)) {
      await removePidFileIfExists(this.settings.pidFile);
      return;
    }

    process.kill(pid, 'SIGTERM');

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!isProcessRunning(pid)) {
        await removePidFileIfExists(this.settings.pidFile);
        return;
      }
      await sleep(150);
    }

    process.kill(pid, 'SIGKILL');
    await removePidFileIfExists(this.settings.pidFile);
  }

  async ensureRunning(serverUrl: string, requestTimeoutMs: number): Promise<void> {
    const reachable = await pingTranslationServer(serverUrl, Math.min(3000, requestTimeoutMs));
    if (reachable) {
      return;
    }

    if (!this.settings.enabled) {
      throw new Error('Translation Server is unreachable and serverManagement.enabled is false.');
    }

    await this.start(serverUrl);
  }
}
