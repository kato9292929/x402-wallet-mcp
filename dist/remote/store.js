export class StoreConfigError extends Error {
}
export function memoryStore(now = Date.now) {
    const m = new Map();
    const live = (k) => {
        const e = m.get(k);
        if (e && e.exp <= now()) {
            m.delete(k);
            return undefined;
        }
        return e;
    };
    return {
        async get(k) {
            const e = live(k);
            return e ? JSON.parse(e.v) : null;
        },
        async set(k, v, ttl) {
            m.set(k, { v: JSON.stringify(v), exp: now() + ttl * 1000 });
        },
        async del(k) {
            m.delete(k);
        },
        async setIfAbsent(k, v, ttl) {
            if (live(k))
                return false;
            m.set(k, { v: JSON.stringify(v), exp: now() + ttl * 1000 });
            return true;
        },
        async incr(k, by, ttl) {
            const n = (live(k) ? Number(JSON.parse(m.get(k).v)) : 0) + by;
            m.set(k, { v: JSON.stringify(n), exp: now() + ttl * 1000 });
            return n;
        },
    };
}
export async function upstashStore(url, token) {
    const { Redis } = await import("@upstash/redis");
    const r = new Redis({ url, token });
    return {
        async get(k) {
            return ((await r.get(k)) ?? null);
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
let cached;
export function getStore() {
    cached ??= (async () => {
        const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
        const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
        if (url && token)
            return upstashStore(url, token);
        if (process.env.VERCEL) {
            throw new StoreConfigError("Storage is not set up: add Upstash Redis to this Vercel project.");
        }
        return memoryStore();
    })();
    cached.catch(() => (cached = undefined));
    return cached;
}
