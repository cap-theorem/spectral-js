import {
  LeaseExpiredError,
  SidecarUnavailableError,
  SpectralError,
  apiError,
  type Op,
} from "./errors.ts";
import { formatDuration, parseDuration } from "./wire.ts";

export const VERSION = "0.1.0";
export const DEFAULT_ADDR = "http://127.0.0.1:8000";
export const ADDR_ENV = "SPECTRAL_ADDR";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ERROR_BODY = 4096;

export interface ClientOptions {
  addr?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface Registration {
  service: string;
  instanceId: string;
  endpoint: string;
  ttlMs: number;
}

export interface Lease {
  token: string;
  ttlMs: number;
  expiresAt: Date;
}

export interface Provider {
  service: string;
  instanceId: string;
  endpoint: string;
}

export type State = "joining" | "active" | "leaving" | "left";

export interface Status {
  ready: boolean;
  state: State;
}

export interface CallOptions {
  signal?: AbortSignal;
}

interface RequestInit {
  query?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal | undefined;
}

type JSONObject = Record<string, unknown>;

export class SpectralClient {
  readonly addr: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions = {}) {
    const addr = (options.addr || readEnv(ADDR_ENV) || DEFAULT_ADDR).replace(/\/+$/, "");

    let url: URL;
    try {
      url = new URL(addr);
    } catch {
      throw new TypeError(`spectral: invalid addr "${addr}"`);
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.host === "") {
      throw new TypeError(`spectral: addr "${addr}" must be an http(s) URL with a host`);
    }

    this.addr = addr;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async register(reg: Registration, options: CallOptions = {}): Promise<Lease> {
    const data = await this.#do("register", "POST", "/register", {
      body: {
        service: reg.service,
        instance_id: reg.instanceId,
        endpoint: reg.endpoint,
        ttl: formatDuration(reg.ttlMs),
      },
      signal: options.signal,
    });

    const obj = asObject("register", data);
    const ttl = stringField("register", obj, "ttl");
    const expiresAt = new Date(stringField("register", obj, "expires_at"));

    let ttlMs: number;
    try {
      ttlMs = parseDuration(ttl);
    } catch (err) {
      throw new SpectralError(`spectral register: invalid ttl "${ttl}" in response`, { cause: err });
    }
    if (Number.isNaN(expiresAt.getTime())) {
      throw new SpectralError("spectral register: invalid expires_at in response");
    }

    return {
      token: stringField("register", obj, "token"),
      ttlMs,
      expiresAt,
    };
  }

  async renew(token: string, options: CallOptions = {}): Promise<void> {
    await this.#do("renew", "POST", "/renew", { body: { token }, signal: options.signal });
  }

  async lookup(service: string, options: CallOptions = {}): Promise<Provider> {
    const data = await this.#do("lookup", "GET", "/lookup", { query: { service }, signal: options.signal });
    const obj = asObject("lookup", data);

    return {
      service: stringField("lookup", obj, "service"),
      instanceId: typeof obj["instance_id"] === "string" ? obj["instance_id"] : "",
      endpoint: stringField("lookup", obj, "endpoint"),
    };
  }

  async status(options: CallOptions = {}): Promise<Status> {
    const data = await this.#do("status", "GET", "/status", { signal: options.signal });
    const obj = asObject("status", data);

    if (typeof obj["ready"] !== "boolean") {
      throw new SpectralError('spectral status: invalid response: missing "ready"');
    }

    return {
      ready: obj["ready"],
      state: stringField("status", obj, "state") as State,
    };
  }

  async keepAlive(lease: Lease, options: CallOptions = {}): Promise<void> {
    const intervalMs = Math.floor(lease.ttlMs / 3);
    if (intervalMs <= 0) {
      throw new RangeError(`spectral keepAlive: lease ttl ${lease.ttlMs}ms is too short`);
    }

    const signal = options.signal;
    let deadline = performance.now() + lease.ttlMs;

    while (true) {
      const stopped = await sleep(intervalMs, signal);
      if (stopped) {
        return;
      }

      const now = performance.now();
      try {
        await this.renew(lease.token, { ...(signal ? { signal } : {}) });
        deadline = now + lease.ttlMs;
      } catch (err) {
        if (signal?.aborted) {
          return;
        }
        if (err instanceof LeaseExpiredError) {
          throw err;
        }
        if (now >= deadline) {
          throw new LeaseExpiredError(`spectral keepAlive: lease expired, last renew failed: ${describe(err)}`, {
            cause: err,
          });
        }
      }
    }
  }

  async #do(op: Op, method: string, path: string, init: RequestInit): Promise<unknown> {
    let url = this.addr + path;
    if (init.query) {
      url += `?${new URLSearchParams(init.query).toString()}`;
    }

    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": `spectral-js/${VERSION}`,
    };
    let body: string | undefined;
    if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers["content-type"] = "application/json";
    }

    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await this.#fetch(url, { method, headers, ...(body === undefined ? {} : { body }), signal });
    } catch (err) {
      if (init.signal?.aborted) {
        throw init.signal.reason;
      }
      throw new SidecarUnavailableError(`spectral ${op}: sidecar unavailable at ${this.addr}: ${describe(err)}`, {
        cause: err,
      });
    }

    const text = await res.text();
    if (!res.ok) {
      throw apiError(op, res.status, text.slice(0, MAX_ERROR_BODY).trim());
    }
    if (text === "") {
      return undefined;
    }

    try {
      return JSON.parse(text);
    } catch (err) {
      throw new SpectralError(`spectral ${op}: invalid JSON response`, { cause: err });
    }
  }
}

function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

function asObject(op: Op, data: unknown): JSONObject {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new SpectralError(`spectral ${op}: invalid response: expected a JSON object`);
  }
  return data as JSONObject;
}

function stringField(op: Op, obj: JSONObject, key: string): string {
  const value = obj[key];
  if (typeof value !== "string") {
    throw new SpectralError(`spectral ${op}: invalid response: missing "${key}"`);
  }
  return value;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? `: ${err.cause.message}` : "";
    return `${err.message}${cause}`;
  }
  return String(err);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(true);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
