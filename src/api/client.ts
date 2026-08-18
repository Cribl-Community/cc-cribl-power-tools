// Thin fetch wrapper around the Cribl platform API.
//
// The platform injects auth and rewrites URLs transparently (see AGENTS.md), so this
// layer only handles: resolving the base URL, JSON encoding, group-context prefixing,
// and turning non-2xx responses into an ApiError carrying the server's message.

declare global {
  interface Window {
    CRIBL_API_URL?: string;
    CRIBL_BASE_PATH?: string;
    getCriblUser?: () => Promise<{ id: string; username: string; email?: string }>;
  }
}

/**
 * Cribl Search endpoints must always be called in the `default_search` group context.
 * (Per AGENTS.md: /search/* endpoints ALWAYS use groupId `default_search`.)
 */
export const SEARCH_PREFIX = '/m/default_search';

/** The Cribl Lake id. Cloud exposes a single lake under the id `default`. */
export const LAKE_ID = 'default';

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function baseUrl(): string {
  const base = window.CRIBL_API_URL;
  if (!base) {
    throw new ApiError(
      'CRIBL_API_URL is not available. This app must run inside Cribl to reach the API.',
      0,
    );
  }
  return base.replace(/\/$/, '');
}

export async function extractError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      if (typeof body.message === 'string' && body.message) return body.message;
      if (typeof body.error === 'string' && body.error) return body.error;
      if (body.error && typeof body.error === 'object') {
        const nested = (body.error as { message?: unknown }).message;
        if (typeof nested === 'string' && nested) return nested;
      }
    } catch {
      // Not JSON — fall through to the raw text.
    }
    return text.slice(0, 500);
  }
  return `${res.status} ${res.statusText}`.trim();
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  /**
   * Send `body` verbatim as `text/plain` instead of JSON-encoding it. Needed by the
   * KV store, whose values are opaque raw strings — a JSON-encoded scalar (e.g. the
   * bare string `"abc"`) is rejected 400 by a strict body parser, and a JSON-quoted
   * value would also break the `kv.<key>` header-injection in config/proxies.yml.
   */
  rawBody?: boolean;
  /** Return the response body as raw text instead of JSON-parsing it. */
  rawResponse?: boolean;
}

/** Perform an API request against `CRIBL_API_URL + path`. Throws ApiError on failure. */
export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, signal, rawBody, rawResponse } = opts;
  let url = baseUrl() + path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) qs.append(k, String(v));
    }
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }

  const headers: Record<string, string> = { Accept: rawResponse ? '*/*' : 'application/json' };
  let payload: string | undefined;
  if (body !== undefined) {
    if (rawBody) {
      headers['Content-Type'] = 'text/plain';
      payload = typeof body === 'string' ? body : String(body);
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }

  const res = await fetch(url, { method, headers, body: payload, signal });

  if (!res.ok) {
    throw new ApiError(await extractError(res), res.status);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  if (rawResponse) return text as T;
  return JSON.parse(text) as T;
}

/**
 * GET a binary resource (e.g. an exported Pack `.crbl` file) from
 * `CRIBL_API_URL + path` and return its raw bytes. Throws ApiError on failure.
 */
export async function apiRequestBinary(
  path: string,
  opts: Omit<RequestOptions, 'body' | 'method'> = {},
): Promise<ArrayBuffer> {
  const { query, signal } = opts;
  let url = baseUrl() + path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) qs.append(k, String(v));
    }
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/octet-stream' },
    signal,
  });
  if (!res.ok) throw new ApiError(await extractError(res), res.status);
  return res.arrayBuffer();
}

/** True when the app is running inside Cribl (API base URL is present). */
export function isConnected(): boolean {
  return Boolean(window.CRIBL_API_URL);
}
