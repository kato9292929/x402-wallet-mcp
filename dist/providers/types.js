export class ProviderConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = "ProviderConfigError";
    }
}
export function requireEnv(names) {
    const values = {};
    const missing = [];
    for (const n of names) {
        const v = process.env[n]?.trim();
        if (v)
            values[n] = v;
        else
            missing.push(n);
    }
    return { missing, values };
}
export function assertChain(provider, chain) {
    if (!provider.chains().includes(chain)) {
        throw new ProviderConfigError(`${provider.id} wallet does not support ${chain} in the current network mode. Supported: ${provider.chains().join(", ")}`);
    }
}
