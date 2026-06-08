import { config } from '../config.js';
import { createLogger } from '../util/logger.js';
import { RateLimiter, sleep } from './rateLimiter.js';

const log = createLogger('http');

export interface ApiErrorBody {
  error: {
    message: string;
    code: number;
    data?: unknown;
  };
}

export class ApiError extends Error {
  readonly code: number;
  readonly httpStatus: number;
  readonly data: unknown;

  constructor(httpStatus: number, code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.data = data;
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | string[] | undefined>;
  /** Skip auth header (e.g. for public/global endpoints). */
  noAuth?: boolean;
  maxRetries?: number;
}

export class HttpClient {
  private readonly limiter: RateLimiter;
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(limiter: RateLimiter, baseUrl = config.baseUrl, token = config.token) {
    this.limiter = limiter;
    this.baseUrl = baseUrl;
    this.token = token;
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(this.baseUrl + (path.startsWith('/') ? path : `/${path}`));
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) url.searchParams.append(key, String(v));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method ?? 'GET';
    const url = this.buildUrl(path, opts.query);
    const maxRetries = opts.maxRetries ?? 5;

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (!opts.noAuth) headers.Authorization = `Bearer ${this.token}`;
    let bodyStr: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyStr = JSON.stringify(opts.body);
    }

    let attempt = 0;
    // Retry loop for 429 and 5xx.
    for (;;) {
      attempt++;
      await this.limiter.acquire();

      let res: Response;
      try {
        res = await fetch(url, { method, headers, body: bodyStr });
      } catch (err) {
        if (attempt > maxRetries) throw err;
        const backoff = expBackoff(attempt);
        log.warn(`network error on ${method} ${path}, retry ${attempt} in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }

      if (res.status === 204) return undefined as T;

      // Let the limiter re-tune to the server's advertised limits.
      this.limiter.observeHeaders(res.headers);

      const text = await res.text();
      const json = text ? safeJson(text) : undefined;

      if (res.ok) {
        return json as T;
      }

      // Rate limited
      if (res.status === 429) {
        const retryAfter = parseRetryAfter(res, json);
        this.limiter.penalize(retryAfter);
        if (attempt > maxRetries) {
          throw toApiError(res.status, json, `Rate limited after ${maxRetries} retries`);
        }
        await sleep(retryAfter * 1000 + 50);
        continue;
      }

      // Transient server errors
      if (res.status >= 500 && attempt <= maxRetries) {
        const backoff = expBackoff(attempt);
        log.warn(`server ${res.status} on ${method} ${path}, retry ${attempt} in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }

      throw toApiError(res.status, json);
    }
  }

  get<T>(path: string, query?: RequestOptions['query'], opts?: RequestOptions): Promise<T> {
    return this.request<T>(path, { ...opts, method: 'GET', query });
  }

  post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>(path, { ...opts, method: 'POST', body });
  }

  patch<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>(path, { ...opts, method: 'PATCH', body });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function toApiError(httpStatus: number, json: unknown, fallbackMsg?: string): ApiError {
  const body = json as Partial<ApiErrorBody> | undefined;
  const message = body?.error?.message ?? fallbackMsg ?? `HTTP ${httpStatus}`;
  const code = body?.error?.code ?? httpStatus;
  return new ApiError(httpStatus, code, message, body?.error?.data);
}

function parseRetryAfter(res: Response, json: unknown): number {
  const header = res.headers.get('retry-after');
  if (header) {
    const n = Number(header);
    if (!Number.isNaN(n)) return n;
  }
  const data = (json as Partial<ApiErrorBody>)?.error?.data as { retryAfter?: number } | undefined;
  if (data?.retryAfter) return data.retryAfter;
  return 1;
}

function expBackoff(attempt: number): number {
  const base = Math.min(8000, 250 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * 200);
}
