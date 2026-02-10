import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { z } from 'zod';
import { BiblibCliConfig } from './types.js';

function defaultCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  return xdg && xdg.trim() !== '' ? xdg : path.join(os.homedir(), '.cache');
}

const defaultPidFile = path.join(defaultCacheDir(), 'biblib', 'translation-server.pid');
const defaultLogFile = path.join(defaultCacheDir(), 'biblib', 'translation-server.log');
const defaultSourcePath = path.join(os.homedir(), 'projects', 'translation-server');

const configSchema = z.object({
  rootFolderPath: z.string().min(1).default('.'),
  translationServerUrl: z.string().url().default('http://127.0.0.1:1969'),
  requestTimeoutMs: z.number().int().positive().default(20000),
  literatureNoteTag: z.string().min(1).default('literature_note'),
  literatureNotePath: z.string().min(1).default('.'),
  attachmentFolderPath: z.string().min(1).default('attachments'),
  filenameTemplate: z.string().min(1).default('@{{citekey}}'),
  customFrontmatterFields: z.array(z.object({
    name: z.string().min(1),
    template: z.string(),
    enabled: z.boolean().default(true)
  })).default([
    { name: 'year', template: '{{year}}', enabled: true }
  ]),
  citekey: z.object({
    template: z.string().default('{{author_family}}{{year}}'),
    minLength: z.number().int().min(1).default(6),
    randomDigits: z.number().int().min(1).max(8).default(4)
  }).default({
    template: '{{author_family}}{{year}}',
    minLength: 6,
    randomDigits: 4
  }),
  write: z.object({
    mergeStrategy: z.enum(['shallow', 'replace']).default('shallow'),
    preserveFields: z.array(z.string()).default(['tags'])
  }).default({
    mergeStrategy: 'shallow',
    preserveFields: ['tags']
  }),
  serverManagement: z.object({
    enabled: z.boolean().default(false),
    autoStart: z.boolean().default(false),
    sourcePath: z.string().default(defaultSourcePath),
    nodeCommand: z.string().min(1).default('node'),
    pidFile: z.string().default(defaultPidFile),
    logFile: z.string().default(defaultLogFile),
    startupTimeoutMs: z.number().int().min(1000).default(20000),
    pollIntervalMs: z.number().int().min(100).default(500)
  }).default({
    enabled: false,
    autoStart: false,
    sourcePath: defaultSourcePath,
    nodeCommand: 'node',
    pidFile: defaultPidFile,
    logFile: defaultLogFile,
    startupTimeoutMs: 20000,
    pollIntervalMs: 500
  }),
  attachments: z.object({
    enabled: z.boolean().default(false),
    maxFiles: z.number().int().min(1).max(20).default(3),
    pdfOnly: z.boolean().default(true),
    createSubfolderByCitekey: z.boolean().default(true),
    timeoutMs: z.number().int().min(1000).default(30000)
  }).default({
    enabled: false,
    maxFiles: 3,
    pdfOnly: true,
    createSubfolderByCitekey: true,
    timeoutMs: 30000
  })
});

export function defaultConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() !== '' ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'biblib', 'config.yaml');
}

export function defaultConfigObject(): BiblibCliConfig {
  return configSchema.parse({});
}

export async function loadConfig(configPath?: string): Promise<{ path: string; config: BiblibCliConfig }> {
  const resolvedPath = path.resolve(configPath || process.env.BIBLIB_CONFIG || defaultConfigPath());

  try {
    const raw = await fs.readFile(resolvedPath, 'utf8');
    const parsed = YAML.parse(raw) ?? {};
    const config = configSchema.parse(parsed);
    return { path: resolvedPath, config };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { path: resolvedPath, config: defaultConfigObject() };
    }
    throw error;
  }
}

export async function writeDefaultConfig(configPath?: string, force = false): Promise<string> {
  const target = path.resolve(configPath || defaultConfigPath());
  const dir = path.dirname(target);

  await fs.mkdir(dir, { recursive: true });

  if (!force) {
    try {
      await fs.access(target);
      throw new Error(`Config already exists at ${target}. Use --force to overwrite.`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  const output = YAML.stringify(defaultConfigObject());
  await fs.writeFile(target, output, 'utf8');
  return target;
}
