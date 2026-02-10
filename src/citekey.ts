import crypto from 'node:crypto';
import { CslItem } from './types.js';

function slug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '')
    .toLowerCase();
}

export function extractYear(item: CslItem): string {
  const issued = item.issued;
  if (!issued || typeof issued !== 'object') return '';
  const parts = issued['date-parts'];
  if (Array.isArray(parts) && parts[0] && typeof parts[0][0] === 'number') {
    return String(parts[0][0]);
  }
  if (typeof issued.raw === 'string') {
    const m = issued.raw.match(/\b(\d{4})\b/);
    return m ? m[1] : '';
  }
  return '';
}

function firstAuthorFamily(item: CslItem): string {
  const author = item.author;
  if (!Array.isArray(author) || author.length === 0) return '';
  const first = author[0];
  if (first?.family && typeof first.family === 'string') return first.family;
  if (first?.literal && typeof first.literal === 'string') return first.literal;
  return '';
}

function titleWord(item: CslItem): string {
  if (typeof item.title !== 'string') return '';
  const words = item.title
    .split(/\s+/)
    .map(w => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  return words[0] || '';
}

function applyFormatter(value: string, formatter: string): string {
  switch (formatter) {
    case 'lowercase':
      return value.toLowerCase();
    case 'uppercase':
      return value.toUpperCase();
    case 'titleword':
      return value
        .split(/\s+/)
        .map(w => w.replace(/[^\p{L}\p{N}]/gu, ''))
        .find(Boolean) || '';
    case 'sentence':
      return value
        .split(/\s+/)
        .map(w => w.toLowerCase())
        .map((w, i) => (i === 0 ? (w.charAt(0).toUpperCase() + w.slice(1)) : w))
        .join(' ');
    default:
      return value;
  }
}

function renderCitekeyTemplate(item: CslItem, template: string): string {
  const vars: Record<string, string> = {
    author: firstAuthorFamily(item),
    author_family: firstAuthorFamily(item),
    title: typeof item.title === 'string' ? item.title : '',
    year: extractYear(item),
    citekey: typeof item.id === 'string' ? item.id : ''
  };

  return template.replace(/{{\s*([^}|\s]+)(?:\|([^}\s]+))?\s*}}/g, (_m, key: string, formatter?: string) => {
    const raw = vars[key] ?? '';
    return formatter ? applyFormatter(raw, formatter) : raw;
  });
}

export function generateCitekey(
  item: CslItem,
  template = '{{author|lowercase}}{{title|titleword}}{{year}}',
  minLength = 6,
  randomDigits = 4
): string {
  const rendered = renderCitekeyTemplate(item, template);
  const base = slug(rendered || `${firstAuthorFamily(item)}${titleWord(item)}${extractYear(item)}`) || 'ref';
  if (base.length >= minLength) {
    return base;
  }
  const suffix = crypto.randomInt(0, 10 ** randomDigits).toString().padStart(randomDigits, '0');
  return `${base}${suffix}`;
}

export function ensureCitekey(
  item: CslItem,
  template = '{{author|lowercase}}{{title|titleword}}{{year}}',
  minLength = 6,
  randomDigits = 4,
  preserveExistingId = false
): CslItem {
  const current = item.id;
  if (preserveExistingId && typeof current === 'string' && current.trim() !== '') {
    return item;
  }
  return {
    ...item,
    id: generateCitekey(item, template, minLength, randomDigits)
  };
}
