import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { BiblibCliConfig, CslItem } from './types.js';
import { extractYear } from './citekey.js';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

function processYamlArray(result: string): string {
  if (result.trim() === '[]' || result.trim() === '[ ]') {
    return '[]';
  }

  if (result.startsWith('[') && result.endsWith(']')) {
    try {
      JSON.parse(result);
      return result;
    } catch {
      if (result.replace(/\s/g, '') === '[]') {
        return '[]';
      }

      const content = result.substring(1, result.length - 1).trim();
      if (!content) {
        return '[]';
      }

      const splitPattern = /,(?=(?:[^"]*"[^"]*")*[^"]*$)/;
      let items = content.split(splitPattern).map(item => item.trim()).filter(Boolean);

      if (items.length === 0) {
        return '[]';
      }

      items = items.map(item => {
        if (item.startsWith('"') && item.endsWith('"')) {
          return item;
        }
        if (item.includes('[[') && item.includes(']]')) {
          return `"${item.replace(/"/g, '\\"')}"`;
        }
        return item;
      });

      return '[' + items.join(',') + ']';
    }
  }

  return result;
}

function getPathValue(data: Record<string, unknown>, pathExpr: string): unknown {
  return pathExpr.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, data);
}

function applyFormatter(value: string, formatter: string): string {
  switch (formatter) {
    case 'lowercase':
      return value.toLowerCase();
    case 'uppercase':
      return value.toUpperCase();
    case 'sentence': {
      const words = value.trim().split(/\s+/).filter(Boolean).map(w => w.toLowerCase());
      if (words.length === 0) return '';
      words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
      return words.join(' ');
    }
    case 'titleword':
      return value
        .split(/\s+/)
        .map(w => w.replace(/[^\p{L}\p{N}]/gu, ''))
        .find(Boolean) || '';
    default:
      return value;
  }
}

function renderTemplate(template: string, vars: Record<string, unknown>): string {
  const renderedSections = template.replace(/{{#\s*([^}\s]+)\s*}}([\s\S]*?){{\/\s*\1\s*}}/g, (_m, key: string, inner: string) => {
    const sectionValue = getPathValue(vars, key);

    if (Array.isArray(sectionValue)) {
      return sectionValue
        .map(item => {
          const localVars = typeof item === 'object' && item !== null
            ? { ...vars, ...(item as Record<string, unknown>), '.': item }
            : { ...vars, '.': item };
          return renderTemplate(inner, localVars);
        })
        .join('');
    }

    if (sectionValue) {
      return renderTemplate(inner, vars);
    }

    return '';
  });

  return renderedSections.replace(/{{\s*([^}|\s]+)(?:\|([^}\s]+))?\s*}}/g, (_m, pathExpr: string, formatter?: string) => {
    const raw = pathExpr === '.'
      ? vars['.']
      : getPathValue(vars, pathExpr);
    if (raw === null || raw === undefined) return '';
    const str = String(raw);
    return formatter ? applyFormatter(str, formatter) : str;
  });
}

function buildTemplateVars(csl: CslItem, attachmentPaths?: string[]): Record<string, unknown> {
  const firstAuthor = Array.isArray(csl.author) ? csl.author[0] : undefined;
  const authorFamily = typeof firstAuthor?.family === 'string'
    ? firstAuthor.family
    : typeof firstAuthor?.literal === 'string'
      ? firstAuthor.literal
      : '';

  const attachmentList = Array.isArray(attachmentPaths)
    ? attachmentPaths
    : Array.isArray(csl.pdflink)
      ? csl.pdflink
      : Array.isArray(csl.attachments)
        ? csl.attachments
        : Array.isArray(csl.attachment)
          ? csl.attachment
          : [];

  const formatAttachmentLink = (rawPath: string): string => {
    if (rawPath.endsWith('.pdf')) return `[[${rawPath}|PDF]]`;
    if (rawPath.endsWith('.epub')) return `[[${rawPath}|EPUB]]`;
    const ext = rawPath.split('.').pop()?.toUpperCase() || 'FILE';
    return `[[${rawPath}|${ext}]]`;
  };

  const formattedAttachments = attachmentList
    .map(v => String(v))
    .filter(Boolean)
    .map(formatAttachmentLink);

  const authors = Array.isArray(csl.author)
    ? csl.author
        .map((a: any) => {
          if (a?.family) return String(a.family);
          if (a?.literal) return String(a.literal);
          return '';
        })
        .filter(Boolean)
    : [];

  const now = new Date();
  const currentDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  return {
    ...csl,
    citekey: csl.id ?? '',
    year: extractYear(csl),
    author_family: authorFamily,
    pdflink: attachmentList,
    raw_pdflinks: attachmentList,
    raw_pdflink: attachmentList[0] || '',
    attachments: formattedAttachments,
    attachment: formattedAttachments[0] || '',
    quoted_attachments: formattedAttachments.map(att => `"${att}"`),
    quoted_attachment: formattedAttachments[0] ? `"${formattedAttachments[0]}"` : '',
    authors,
    links: Array.isArray((csl as any).links) ? (csl as any).links : [],
    currentDate
  };
}

function applyCustomFrontmatterFields(
  target: Record<string, unknown>,
  csl: CslItem,
  config: BiblibCliConfig,
  attachmentPaths?: string[]
): void {
  const vars = buildTemplateVars(csl, attachmentPaths);

  for (const field of config.customFrontmatterFields) {
    if (!field.enabled || target[field.name] !== undefined) {
      continue;
    }

    const rendered = renderTemplate(field.template, vars).trim();
    if (rendered === '') continue;

    if ((rendered.startsWith('[') && rendered.endsWith(']')) || (rendered.startsWith('{') && rendered.endsWith('}'))) {
      const isArrayTemplate = field.template.trim().startsWith('[') && field.template.trim().endsWith(']');
      const normalizedJsonLike = (isArrayTemplate ? processYamlArray(rendered) : rendered)
        .replace(/,\s*]/g, ']')
        .replace(/,\s*}/g, '}');
      try {
        target[field.name] = JSON.parse(normalizedJsonLike);
        continue;
      } catch {
        target[field.name] = rendered;
        continue;
      }
    }

    target[field.name] = rendered;
  }
}

export function cslToFrontmatterObject(csl: CslItem, config: BiblibCliConfig, attachmentPaths?: string[]): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ...csl,
    tags: Array.from(new Set([...(Array.isArray(csl.tags) ? (csl.tags as string[]) : []), config.literatureNoteTag]))
  };

  applyCustomFrontmatterFields(base, csl, config, attachmentPaths);
  return base;
}

export function frontmatterYaml(csl: CslItem, config: BiblibCliConfig, attachmentPaths?: string[]): string {
  const object = cslToFrontmatterObject(csl, config, attachmentPaths);
  return YAML.stringify(object, { lineWidth: 0 });
}

export function frontmatterBlock(csl: CslItem, config: BiblibCliConfig, attachmentPaths?: string[]): string {
  return `---\n${frontmatterYaml(csl, config, attachmentPaths)}---\n`;
}

export async function writeMarkdownFrontmatter(
  filePath: string,
  csl: CslItem,
  config: BiblibCliConfig,
  mode: 'replace' | 'shallow',
  dryRun = false,
  attachmentPaths?: string[]
): Promise<string> {
  const resolved = path.resolve(filePath);
  const current = await fs.readFile(resolved, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });

  const newFm = cslToFrontmatterObject(csl, config, attachmentPaths);
  const match = current.match(FRONTMATTER_RE);

  let body = current;
  let merged = newFm;

  if (match) {
    body = current.slice(match[0].length);

    if (mode === 'shallow') {
      const existing = (YAML.parse(match[1]) ?? {}) as Record<string, unknown>;
      merged = { ...existing, ...newFm };

      for (const key of config.write.preserveFields) {
        if (existing[key] !== undefined) {
          merged[key] = existing[key];
        }
      }
    }
  }

  const next = `---\n${YAML.stringify(merged, { lineWidth: 0 })}---\n${body.replace(/^\n+/, '\n')}`;

  if (!dryRun) {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, next, 'utf8');
  }

  return next;
}
