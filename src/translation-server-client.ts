import { CslItem, RawTranslationItem } from './types.js';

function isUrl(input: string): boolean {
  try {
    const u = new URL(input);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function postText(url: string, body: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain'
      },
      body,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Translation Server request failed (${response.status} ${response.statusText}) at ${url}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function postJson(url: string, payload: unknown, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Translation Server export failed (${response.status} ${response.statusText}) at ${url}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export class TranslationServerClient {
  constructor(
    private readonly serverUrl: string,
    private readonly timeoutMs: number
  ) {}

  async fetchCsl(query: string): Promise<CslItem> {
    const result = await this.fetchCslWithRaw(query);
    return result.csl;
  }

  async fetchCslWithRaw(query: string): Promise<{ csl: CslItem; raw: RawTranslationItem }> {
    const base = this.serverUrl.replace(/\/+$/, '');
    const endpoint = isUrl(query) ? '/web' : '/search';
    const raw = await postText(`${base}${endpoint}`, query, this.timeoutMs);

    const first = this.extractFirstItem(raw);
    if (!first) {
      throw new Error(`No metadata returned by Translation Server for: ${query}`);
    }

    const exported = await postJson(`${base}/export?format=csljson`, [first], this.timeoutMs);
    const csl = this.extractFirstItem(exported);

    if (!csl || typeof csl !== 'object') {
      throw new Error('Unable to convert Translation Server output to CSL-JSON');
    }

    return {
      csl: csl as CslItem,
      raw: first as RawTranslationItem
    };
  }

  private extractFirstItem(payload: unknown): unknown {
    if (Array.isArray(payload)) {
      return payload[0];
    }
    if (payload && typeof payload === 'object') {
      return payload;
    }
    return undefined;
  }
}
