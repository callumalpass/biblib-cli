#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import YAML from 'yaml';
import { loadConfig, writeDefaultConfig, defaultConfigPath } from './config.js';
import { ensureCitekey, extractYear } from './citekey.js';
import { TranslationServerClient } from './translation-server-client.js';
import { CslItem, BiblibCliConfig } from './types.js';
import { frontmatterBlock, frontmatterYaml, writeMarkdownFrontmatter } from './frontmatter.js';
import { NodeTranslationServerManager } from './server-manager.js';
import { downloadAttachments } from './attachments.js';

function parseCslJson(raw: string): CslItem {
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    if (!parsed[0] || typeof parsed[0] !== 'object') {
      throw new Error('JSON does not contain a valid CSL object');
    }
    return parsed[0] as CslItem;
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('JSON is not a valid CSL object');
  }
  return parsed as CslItem;
}

function outputForFormat(format: 'json' | 'yaml' | 'frontmatter', csl: CslItem, config: Awaited<ReturnType<typeof loadConfig>>['config']): string {
  if (format === 'yaml') {
    return frontmatterYaml(csl, config);
  }
  if (format === 'frontmatter') {
    return frontmatterBlock(csl, config);
  }
  return JSON.stringify(csl, null, 2);
}

function sanitizeFileSegment(value: string): string {
  return value
    .replace(/[<>:"\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderFilenameTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/{{\s*([^}\s]+)\s*}}/g, (_m, key: string) => vars[key] ?? '');
}

function resolveRootRelative(baseRoot: string, configuredPath: string): string {
  if (path.isAbsolute(configuredPath)) {
    return path.join(baseRoot, configuredPath.replace(/^[/\\]+/, ''));
  }
  return path.join(baseRoot, configuredPath);
}

function resolveOutputNotePath(
  markdownFile: string | undefined,
  csl: CslItem,
  config: BiblibCliConfig,
  rootDir: string
): string {
  if (markdownFile && markdownFile.trim() !== '') {
    return path.isAbsolute(markdownFile)
      ? markdownFile
      : path.join(rootDir, markdownFile);
  }

  const firstAuthor = Array.isArray(csl.author) ? csl.author[0] : undefined;
  const authorFamily = typeof firstAuthor?.family === 'string'
    ? firstAuthor.family
    : typeof firstAuthor?.literal === 'string'
      ? firstAuthor.literal
      : '';

  const vars: Record<string, string> = {
    citekey: typeof csl.id === 'string' ? csl.id : '',
    title: typeof csl.title === 'string' ? csl.title : '',
    year: extractYear(csl),
    author_family: authorFamily
  };

  const rendered = sanitizeFileSegment(renderFilenameTemplate(config.filenameTemplate, vars)) || '@untitled';
  const withExt = rendered.endsWith('.md') ? rendered : `${rendered}.md`;
  const notesBase = resolveRootRelative(rootDir, config.literatureNotePath);
  return path.join(notesBase, withExt);
}

async function ensureServerIfNeeded(
  ensureRequested: boolean,
  config: BiblibCliConfig,
  serverUrl: string
): Promise<void> {
  const shouldEnsure = ensureRequested || config.serverManagement.autoStart;
  if (!shouldEnsure) return;

  const manager = new NodeTranslationServerManager(config.serverManagement);
  await manager.ensureRunning(serverUrl, config.requestTimeoutMs);
}

const program = new Command();

program
  .name('biblib')
  .description('Retrieve bibliographic metadata and write CSL-JSON YAML frontmatter')
  .version('0.2.0')
  .option('--config <path>', 'Path to config file (default: ~/.config/biblib/config.yaml)');

program
  .command('init-config')
  .description('Create default config file')
  .option('--force', 'Overwrite existing config file', false)
  .action(async (options, command) => {
    const root = command.parent as Command;
    const cfgPath = root.opts().config as string | undefined;
    const written = await writeDefaultConfig(cfgPath, options.force);
    process.stdout.write(`${written}\n`);
  });

program
  .command('fetch')
  .description('Fetch metadata from Translation Server and output CSL/frontmatter')
  .argument('<query>', 'Identifier or URL')
  .option('--format <format>', 'json|yaml|frontmatter', 'json')
  .option('--output <path>', 'Write output to file instead of stdout')
  .option('--server-url <url>', 'Override Translation Server URL')
  .option('--ensure-server', 'Ensure Translation Server is running (managed node process)', false)
  .action(async (query: string, options, command) => {
    const root = command.parent as Command;
    const cfgPath = root.opts().config as string | undefined;
    const { config } = await loadConfig(cfgPath);
    const rootDir = path.resolve(config.rootFolderPath);

    const serverUrl = options.serverUrl || config.translationServerUrl;
    await ensureServerIfNeeded(options.ensureServer, config, serverUrl);

    const client = new TranslationServerClient(serverUrl, config.requestTimeoutMs);
    const csl = ensureCitekey(
      await client.fetchCsl(query),
      config.citekey.template,
      config.citekey.minLength,
      config.citekey.randomDigits,
      false
    );

    const format = options.format as 'json' | 'yaml' | 'frontmatter';
    if (!['json', 'yaml', 'frontmatter'].includes(format)) {
      throw new Error(`Unsupported format: ${format}`);
    }

    const output = outputForFormat(format, csl, config);

    if (options.output) {
      const target = path.resolve(options.output);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, output, 'utf8');
      return;
    }

    process.stdout.write(output + (output.endsWith('\n') ? '' : '\n'));
  });

program
  .command('write')
  .description('Fetch metadata and merge/replace YAML frontmatter in a Markdown file')
  .argument('<query>', 'Identifier or URL')
  .argument('[markdown-file]', 'Target markdown file (optional)')
  .option('--replace', 'Replace frontmatter instead of shallow merge', false)
  .option('--dry-run', 'Print result without writing', false)
  .option('--attachments', 'Download available attachments and add paths to frontmatter', false)
  .option('--skip-attachments', 'Skip attachment download for this run', false)
  .option('--server-url <url>', 'Override Translation Server URL')
  .option('--ensure-server', 'Ensure Translation Server is running (managed node process)', false)
  .action(async (query: string, markdownFile: string | undefined, options, command) => {
    const root = command.parent as Command;
    const cfgPath = root.opts().config as string | undefined;
    const { config } = await loadConfig(cfgPath);
    const rootDir = path.resolve(config.rootFolderPath);

    const serverUrl = options.serverUrl || config.translationServerUrl;
    await ensureServerIfNeeded(options.ensureServer, config, serverUrl);

    const client = new TranslationServerClient(serverUrl, config.requestTimeoutMs);
    const fetched = await client.fetchCslWithRaw(query);
    const csl = ensureCitekey(
      fetched.csl,
      config.citekey.template,
      config.citekey.minLength,
      config.citekey.randomDigits,
      false
    );
    const shouldDownloadAttachments = options.skipAttachments
      ? false
      : (config.attachments.enabled || options.attachments);

    let cslWithAttachments: CslItem = csl;
    if (shouldDownloadAttachments) {
      const citekey = typeof csl.id === 'string' ? csl.id : 'ref';
      const attachmentPaths = await downloadAttachments(fetched.raw, csl, citekey, config, rootDir);
      if (attachmentPaths.length > 0) {
        cslWithAttachments = {
          ...csl,
          attachment: attachmentPaths,
          attachments: attachmentPaths,
          pdflink: attachmentPaths[0]
        };
      }
    }
    const outputPath = resolveOutputNotePath(markdownFile, csl, config, rootDir);

    const mode = options.replace ? 'replace' : config.write.mergeStrategy;
    const result = await writeMarkdownFrontmatter(outputPath, cslWithAttachments, config, mode, options.dryRun);

    if (options.dryRun) {
      process.stdout.write(result + (result.endsWith('\n') ? '' : '\n'));
    } else {
      const printable = path.relative(process.cwd(), outputPath) || outputPath;
      process.stdout.write(`${printable}\n`);
    }
  });

program
  .command('from-json')
  .description('Read CSL-JSON from file and merge/replace YAML frontmatter in a Markdown file')
  .argument('<json-file>', 'CSL-JSON file path')
  .argument('<markdown-file>', 'Target markdown file')
  .option('--replace', 'Replace frontmatter instead of shallow merge', false)
  .option('--dry-run', 'Print result without writing', false)
  .action(async (jsonFile: string, markdownFile: string, options, command) => {
    const root = command.parent as Command;
    const cfgPath = root.opts().config as string | undefined;
    const { config } = await loadConfig(cfgPath);
    const rootDir = path.resolve(config.rootFolderPath);

    const raw = await fs.readFile(path.resolve(jsonFile), 'utf8');
    const parsed = parseCslJson(raw);
    const csl = ensureCitekey(
      parsed,
      config.citekey.template,
      config.citekey.minLength,
      config.citekey.randomDigits,
      false
    );

    const mode = options.replace ? 'replace' : config.write.mergeStrategy;
    const targetPath = path.isAbsolute(markdownFile) ? markdownFile : path.join(rootDir, markdownFile);
    const result = await writeMarkdownFrontmatter(targetPath, csl, config, mode, options.dryRun);

    if (options.dryRun) {
      process.stdout.write(result + (result.endsWith('\n') ? '' : '\n'));
    }
  });

const server = program
  .command('server')
  .description('Manage Translation Server process (node src/server.js)');

server
  .command('status')
  .description('Show server reachability and managed process status')
  .option('--server-url <url>', 'Override Translation Server URL')
  .action(async (options, command) => {
    const root = command.parent?.parent as Command;
    const cfgPath = root.opts().config as string | undefined;
    const { config } = await loadConfig(cfgPath);

    const serverUrl = options.serverUrl || config.translationServerUrl;
    const manager = new NodeTranslationServerManager(config.serverManagement);
    const status = await manager.status(serverUrl, config.requestTimeoutMs);

    process.stdout.write(`serverUrl: ${serverUrl}\n`);
    process.stdout.write(`reachable: ${status.reachable}\n`);
    process.stdout.write(`process: ${status.process}\n`);
    process.stdout.write(`pid: ${status.pid ?? 'none'}\n`);
    process.stdout.write(`sourcePath: ${config.serverManagement.sourcePath}\n`);
    process.stdout.write(`logFile: ${config.serverManagement.logFile}\n`);
  });

server
  .command('start')
  .description('Start Translation Server from source via node src/server.js')
  .option('--server-url <url>', 'Override Translation Server URL')
  .action(async (options, command) => {
    const root = command.parent?.parent as Command;
    const cfgPath = root.opts().config as string | undefined;
    const { config } = await loadConfig(cfgPath);

    const serverUrl = options.serverUrl || config.translationServerUrl;
    const manager = new NodeTranslationServerManager(config.serverManagement);
    await manager.start(serverUrl);
    process.stdout.write(`Started Translation Server at ${serverUrl}\n`);
  });

server
  .command('stop')
  .description('Stop managed Translation Server process')
  .action(async (_options, command) => {
    const root = command.parent?.parent as Command;
    const cfgPath = root.opts().config as string | undefined;
    const { config } = await loadConfig(cfgPath);

    const manager = new NodeTranslationServerManager(config.serverManagement);
    await manager.stop();
    process.stdout.write('Stopped managed Translation Server process\n');
  });

program
  .command('show-config')
  .description('Print effective config as YAML')
  .action(async (_options, command) => {
    const root = command.parent as Command;
    const cfgPath = root.opts().config as string | undefined;
    const loaded = await loadConfig(cfgPath);

    process.stdout.write(`# configPath: ${loaded.path}\n`);
    process.stdout.write(YAML.stringify(loaded.config));
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.stderr.write(`Hint: initialize config with 'biblib init-config' (default: ${defaultConfigPath()})\n`);
  process.exit(1);
});
