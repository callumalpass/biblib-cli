import fs from 'node:fs/promises';
import path from 'node:path';
import { BiblibCliConfig, CslItem, RawAttachment, RawTranslationItem } from './types.js';

interface AttachmentCandidate {
  url: string;
  title?: string;
  contentType?: string;
}

function sanitizeFilename(input: string): string {
  return input
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extFromContentType(contentType?: string): string {
  if (!contentType) return '';
  const normalized = contentType.toLowerCase();
  if (normalized.includes('application/pdf')) return '.pdf';
  if (normalized.includes('text/html')) return '.html';
  return '';
}

function extFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname);
    return ext && ext.length <= 8 ? ext.toLowerCase() : '';
  } catch {
    return '';
  }
}

function pickFilename(candidate: AttachmentCandidate, index: number, forcedExt: string): string {
  const fallback = `attachment-${String(index + 1).padStart(2, '0')}${forcedExt || ''}`;
  const title = candidate.title ? sanitizeFilename(candidate.title) : '';
  if (!title) return fallback;

  const titleExt = path.extname(title);
  if (titleExt) return title;
  return `${title}${forcedExt || ''}`;
}

function normalizeAttachment(a: RawAttachment): AttachmentCandidate | null {
  if (!a || typeof a !== 'object') return null;
  if (!a.url || typeof a.url !== 'string') return null;
  return {
    url: a.url,
    title: typeof a.title === 'string' ? a.title : undefined,
    contentType: typeof a.mimeType === 'string'
      ? a.mimeType
      : typeof a.contentType === 'string'
        ? a.contentType
        : undefined
  };
}

function looksLikePdfUrl(url: string): boolean {
  return url.toLowerCase().includes('.pdf');
}

function arxivPdfUrl(url: string): string | null {
  const m = url.match(/^https?:\/\/arxiv\.org\/abs\/([^?#]+)(?:[?#].*)?$/i);
  if (!m || !m[1]) return null;
  return `https://arxiv.org/pdf/${m[1]}.pdf`;
}

export function extractAttachmentCandidates(
  raw: RawTranslationItem,
  csl: CslItem,
  config: BiblibCliConfig
): AttachmentCandidate[] {
  const attachments = Array.isArray(raw.attachments) ? raw.attachments : [];
  const candidates = attachments
    .map(normalizeAttachment)
    .filter((a): a is AttachmentCandidate => a !== null)
    .filter(a => {
      if (!config.attachments.pdfOnly) return true;
      const ct = (a.contentType || '').toLowerCase();
      const url = a.url.toLowerCase();
      return ct.includes('application/pdf') || url.endsWith('.pdf');
    });

  if (candidates.length > 0) {
    return candidates.slice(0, config.attachments.maxFiles);
  }

  // Heuristic fallbacks when translators don't emit explicit attachments.
  const fallbackUrls: string[] = [];
  const rawUrl = typeof raw.url === 'string' ? raw.url : '';
  const cslUrl = typeof csl.URL === 'string' ? csl.URL : '';

  for (const u of [rawUrl, cslUrl]) {
    if (!u) continue;
    if (looksLikePdfUrl(u)) fallbackUrls.push(u);
    const arxiv = arxivPdfUrl(u);
    if (arxiv) fallbackUrls.push(arxiv);
  }

  const deduped = Array.from(new Set(fallbackUrls));
  return deduped.slice(0, config.attachments.maxFiles).map(url => ({
    url,
    title: raw.title || csl.title || 'attachment'
  }));
}

async function downloadOne(candidate: AttachmentCandidate, destPath: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(candidate.url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${candidate.url}`);
    }

    const bytes = await response.arrayBuffer();
    await fs.writeFile(destPath, Buffer.from(bytes));
  } finally {
    clearTimeout(timeout);
  }
}

export async function downloadAttachments(
  raw: RawTranslationItem,
  csl: CslItem,
  citekey: string,
  config: BiblibCliConfig,
  rootDir: string
): Promise<string[]> {
  const candidates = extractAttachmentCandidates(raw, csl, config);
  if (candidates.length === 0) return [];

  const attachmentBase = path.isAbsolute(config.attachmentFolderPath)
    ? path.join(rootDir, config.attachmentFolderPath.replace(/^[/\\]+/, ''))
    : path.join(rootDir, config.attachmentFolderPath);

  const baseDir = config.attachments.createSubfolderByCitekey
    ? path.resolve(attachmentBase, citekey)
    : path.resolve(attachmentBase);

  await fs.mkdir(baseDir, { recursive: true });

  const written: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const ext = extFromContentType(c.contentType) || extFromUrl(c.url);
    const filename = pickFilename(c, i, ext);
    const absolutePath = path.join(baseDir, filename);

    await downloadOne(c, absolutePath, config.attachments.timeoutMs);
    const rel = path.relative(rootDir, absolutePath).split(path.sep).join('/');
    written.push(rel);
  }

  return written;
}
