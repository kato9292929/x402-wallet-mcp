import { describe, expect, it } from "vitest";
import { applyPluginOptions } from "../src/plugin-options.js";

describe("plugin options", () => {
  it("does nothing outside a plugin", () => {
    const env: NodeJS.ProcessEnv = { CDP_API_KEY_ID: "from-shell" };
    expect(applyPluginOptions(env)).toBe(false);
    expect(env.CDP_API_KEY_ID).toBe("from-shell");
  });

  it("maps CLAUDE_PLUGIN_OPTION_* and ignores credentials from the shell", () => {
    const env: NodeJS.ProcessEnv = {
      CDP_API_KEY_ID: "from-shell",
      PRIVY_APP_SECRET: "from-shell",
      X402_NETWORK: "mainnet",
      CLAUDE_PLUGIN_OPTION_WALLET_PROVIDER: "cdp",
      CLAUDE_PLUGIN_OPTION_CDP_API_KEY_ID: "from-plugin",
      CLAUDE_PLUGIN_OPTION_PRIVY_APP_SECRET: "${user_config.privy_app_secret}",
      CLAUDE_PLUGIN_OPTION_NETWORK: "testnet",
      CLAUDE_PLUGIN_OPTION_PER_CALL_MAX_USD: " 0.05 ",
      CLAUDE_PLUGIN_OPTION_ALLOWED_HOSTS: "",
    };
    expect(applyPluginOptions(env)).toBe(true);
    expect(env).toMatchObject({ WALLET_PROVIDER: "cdp", CDP_API_KEY_ID: "from-plugin", X402_NETWORK: "testnet", X402_PER_CALL_MAX_USD: "0.05" });
    expect(env.PRIVY_APP_SECRET).toBeUndefined();
    expect(env.X402_ALLOWED_HOSTS).toBeUndefined();
  });
});
