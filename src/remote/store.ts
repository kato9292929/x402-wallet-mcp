/**
 * Short-lived state for the remote server: payments waiting for approval, built payments waiting
 * for the wallet's signature, results, 24-hour totals and remembered refusals.
 *
 * On Vercel this is Upstash Redis (the variables the Vercel Marketplace integration sets:
 * KV_REST_API_URL / KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
 * Without them, outside Vercel, it falls back to memory (local runs and tests).
 */
export interface Store {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSec: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Sets only if the key does not exist. Returns whether it was set. */
  setIfAbsent(key: string, value: unknown, ttlSec: number): Promise<boolean>;
  /** Adds `by` and (re)sets the expiry. Returns the new value. */
  incr(key: string, by: number, ttlSec: number): Promise<number>;
}

export class StoreConfigError extends Error {}

export function memoryStore(now: () => number = Date.now): Store {
  const m = new Map<string, { v: string; exp: number }>();
  const live = (k: string) => {
    const e = m.get(k);
    if (e && e.exp <= now()) {
      m.delete(k);
      return undefined;
    }
    return e;
  };
  return {
    async get<T>(k: string) {
      const e = live(k);
      return e ? (JSON.parse(e.v) as T) : null;
    },
    async set(k, v, ttl) {
      m.set(k, { v: JSON.stringify(v), exp: now() + ttl * 1000 });
    },
    async del(k) {
      m.delete(k);
    },
    async setIfAbsent(k, v, ttl) {
      if (live(k)) return false;
      m.set(k, { v: JSON.stringify(v), exp: now() + ttl * 1000 });
      return true;
    },
    async incr(k, by, ttl) {
      const n = (live(k) ? Number(JSON.parse(m.get(k)!.v)) : 0) + by;
      m.set(k, { v: JSON.stringify(n), exp: now() + ttl * 1000 });
      return n;
    },
  };
}

export async function upstashStore(url: string, token: string): Promise<Store> {
  const { Redis } = await import("@upstash/redis");
  const r = new Redis({ url, token });
  return {
    async get<T>(k: string) {
      return ((await r.get<T>(k)) ?? null) as T | null;
    },
    async set(k, v, ttl) {
      await r.set(k, v, { ex: ttl });
    },
    async del(k) {
      await r.del(k);
    },
    async setIfAbsent(k, v, ttl) {
      return (await r.set(k, v, { ex: ttl, nx: true })) === "OK";
    },
    async incr(k, by, ttl) {
      const n = await r.incrby(k, by);
      await r.expire(k, ttl);
      return n;
    },
  };
}

let cached: Promise<Store> | undefined;

export function getStore(): Promise<Store> {
  cached ??= (async () => {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (url && token) return upstashStore(url, token);
    if (process.env.VERCEL) {
      throw new StoreConfigError("Storage is not set up: add Upstash Redis to this Vercel project.");
    }
    return memoryStore();
  })();
  cached.catch(() => (cached = undefined));
  return cached;
}
