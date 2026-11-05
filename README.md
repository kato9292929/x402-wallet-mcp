# x402-wallet-mcp

AI エージェントが [x402](https://x402.org) の有料 API を **探して・値段を確かめて・払う** ための stdio MCP サーバーです。
Coinbase の Payments MCP（`npx @coinbase/payments-mcp`）と同じ 8 ツール構成で、ウォレットは `WALLET_PROVIDER` で **CDP / Privy / Crossmint** を切り替えられます。402 が Nevermined のクレジット課金（`nvm:erc4337`）を提示した場合は `NVM_API_KEY` で払えます。

- 支払い上限（1 回あたり / セッション累計 / 許可ホスト）は `~/.x402-wallet-mcp/config.json` で人間だけが設定します。エージェントから変更するツールはありません。
- 既定は `"network": "testnet"`（Base Sepolia / Solana Devnet）。本番 USDC を使うには人間が `"mainnet"` に変える必要があります。

## ツール

| ツール | 内容 |
| - | - |
| `get_wallet_address` | provider のウォレットアドレス（chain ごと） |
| `get_wallet_balance` | USDC 残高（対応 chain すべて。Crossmint staging は USDXM も表示） |
| `show_wallet_app` | 原典の UI の代わりに、入金先アドレス・chain・faucet / onramp の案内・現在の上限をテキストで返す |
| `check_sign_in_status` | provider の認証情報が揃って署名できるか、足りないものは何か |
| `list_bazaar_resources` | CDP Bazaar（公開 discovery API、認証不要）から x402 サービスを検索 / 一覧 |
| `get_resource_details` | 1 件の accepts・価格・説明・入出力スキーマ |
| `make_x402_request` | URL を呼び、402 なら上限内で署名して再送。結果と settle レシート（tx ハッシュ）を返す |
| `check_payment_requirements` | 402 の accepts と「どれを払うか」「上限内か」だけ返す（払わない） |

## クイックスタート

Node.js 20 以上が必要です。

```bash
npx -y x402-wallet-mcp status
```

> npm 公開前は `npx -y github:kato9292929/x402-wallet-mcp` で GitHub から直接起動できます（初回はビルドが走ります）。

`WALLET_PROVIDER` を指定しないと、設定方法を標準エラーに出して終了します。ウォレットなしで探索系ツールだけ使う場合は `WALLET_PROVIDER=none`。

## provider ごとの設定

必要な環境変数の一覧は [`.env.example`](.env.example) にあります。値は MCP クライアント設定の `env` に入れます。

### cdp（Coinbase Developer Platform）

| 変数 | 取得場所 |
| - | - |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | [CDP Portal → API Keys → Secret API Keys](https://portal.cdp.coinbase.com/api-keys/secret) で **Create API Key** → JSON をダウンロード（`id` と `privateKey`） |
| `CDP_WALLET_SECRET` | [CDP Portal → Wallets → Non-custodial → Security](https://portal.cdp.coinbase.com/wallets/non-custodial/security) で **Generate Wallet Secret** |

アカウント（EVM と Solana）は初回利用時に `CDP_ACCOUNT_NAME`（既定 `x402-wallet-mcp`）で自動作成されます。署名は `@coinbase/cdp-sdk/x402` の `CdpX402Client`。対応 chain: Base / Base Sepolia / Solana / Solana Devnet。

### privy

| 変数 | 取得場所 |
| - | - |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | [Privy Dashboard → Configuration → App settings → Basics](https://dashboard.privy.io/apps?page=settings&tab=basics) の **API keys** で **New secret**（Full access） |
| `PRIVY_WALLET_ID` | 下のコマンドで作成（Ethereum 用。Base / Base Sepolia で払う） |
| `PRIVY_SOLANA_WALLET_ID`（任意） | `privy-create-wallet solana` で作成 |

```bash
PRIVY_APP_ID=... PRIVY_APP_SECRET=... npx -y x402-wallet-mcp privy-create-wallet ethereum
```

owner（authorization key）付きのウォレットを使う場合は `PRIVY_AUTHORIZATION_PRIVATE_KEY` も設定します。署名は `@privy-io/node/x402` の `createX402Client`。

### crossmint（EVM のみ）

| 変数 | 取得場所 |
| - | - |
| `CROSSMINT_API_KEY`（別名 `CROSSMINT_SERVER_API_KEY`） | [Crossmint Staging Console → API Keys](https://staging.crossmint.com/console/projects/apiKeys) の server-side key（`sk_staging_...`。staging は全スコープ有効）。本番は [Production Console](https://www.crossmint.com/console/projects/apiKeys) |
| `CROSSMINT_SIGNER_SECRET` | `npx -y x402-wallet-mcp crossmint-gen-secret` で生成（ローカルで 32 バイト乱数。Crossmint には送信されない） |
| `CROSSMINT_WALLET_ADDRESS` | `npx -y x402-wallet-mcp crossmint-create-wallet` で作成（server signer を recovery に持つスマートウォレット） |

staging キーは `network: "testnet"`（Base Sepolia）、本番キーは `"mainnet"`（Base）でのみ動きます。staging では
`npx -y x402-wallet-mcp crossmint-staging-fund 5` で USDXM を受け取れますが、Base Sepolia の x402 seller の多くは USDC を要求するので、USDC は Circle faucet で入れてください。署名は Crossmint ウォレットの `signTypedData` に委譲するカスタム signer（`ExactEvmScheme`）。

### Nevermined（任意・追加スキーム）

| 変数 | 内容 |
| - | - |
| `NVM_API_KEY` | [nevermined.app](https://nevermined.app) → **Settings → Global NVM API Keys**。`sandbox:` キーは sandbox、`live:` キーは live 環境（キーの接頭辞で環境が決まる） |
| `NVM_DELEGATION_ID`（推奨） | 人間が上限と期限を決めて作った delegation。未設定なら初回支払い時に `perSessionMaxUsd`・24 時間で 1 つ作成し、プロセス中は使い回す |
| `NVM_PAYMENT_METHOD_ID`（任意） | 自動作成する delegation に紐づける支払い方法。未設定ならアカウントの有効な `erc4337`（crypto wallet）を使う |

402 の `accepts` に `scheme: "nvm:erc4337"` があり `NVM_API_KEY` が設定されていれば、`payments.x402.getX402AccessToken(planId, agentId, { delegationConfig })` でアクセストークンを取り、Nevermined が指定する `payment-signature` ヘッダ（x402 v2）に付けて再送します。プランの購入は範囲外です（nevermined.app で事前に購入しておく前提）。

`exact` と `nvm:erc4337` の両方が提示されたときの優先順は `SCHEME_PRIORITY`（既定 `exact,nvm:erc4337`）。

> Nevermined はクレジット課金で USD 価格が 402 に載らないため、USD 上限（perCall / perSession）は適用できません。上限は delegation の spending limit で効かせてください。`allowedHosts` は適用されます。

## 支払い上限（`~/.x402-wallet-mcp/config.json`）

初回起動時に既定値で作成されます。`make_x402_request` が毎回読み直すので、編集は再起動なしで反映されます。

```json
{
  "perCallMaxUsd": "0.10",
  "perSessionMaxUsd": "1.00",
  "allowedHosts": [],
  "network": "testnet"
}
```

- `perCallMaxUsd`: 1 回の支払いの上限。超える場合は署名せずにエラーを返す
- `perSessionMaxUsd`: プロセス起動からの累計上限（メモリ上で保持）。seller が支払いを拒否した（再送後も 402）場合は累計に含めない
- `allowedHosts`: 空なら全ホスト許可。空でなければ完全一致したホストだけ払う
- `network`: `testnet` か `mainnet`。違う側の chain は払わない
- 価格を USD に換算できない資産（既知の USDC 以外）は払わない

支払いは `~/.x402-wallet-mcp/payments.jsonl` に記録されます（URL・金額・tx ハッシュ・エクスプローラ URL）。

## MCP クライアントの設定

例は CDP。他の provider は `env` を差し替えてください。

### Claude Desktop

`claude_desktop_config.json`（macOS: `~/Library/Application Support/Claude/`、Windows: `%APPDATA%\Claude\`）:

```json
{
  "mcpServers": {
    "x402-wallet": {
      "command": "npx",
      "args": ["-y", "x402-wallet-mcp"],
      "env": {
        "WALLET_PROVIDER": "cdp",
        "CDP_API_KEY_ID": "...",
        "CDP_API_KEY_SECRET": "...",
        "CDP_WALLET_SECRET": "..."
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add x402-wallet -e WALLET_PROVIDER=cdp -e CDP_API_KEY_ID=... -e CDP_API_KEY_SECRET=... -e CDP_WALLET_SECRET=... -- npx -y x402-wallet-mcp
```

または `.mcp.json`:

```json
{
  "mcpServers": {
    "x402-wallet": {
      "command": "npx",
      "args": ["-y", "x402-wallet-mcp"],
      "env": { "WALLET_PROVIDER": "cdp", "CDP_API_KEY_ID": "...", "CDP_API_KEY_SECRET": "...", "CDP_WALLET_SECRET": "..." }
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.x402-wallet]
command = "npx"
args = ["-y", "x402-wallet-mcp"]

[mcp_servers.x402-wallet.env]
WALLET_PROVIDER = "cdp"
CDP_API_KEY_ID = "..."
CDP_API_KEY_SECRET = "..."
CDP_WALLET_SECRET = "..."
```

### Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "x402-wallet": {
      "command": "npx",
      "args": ["-y", "x402-wallet-mcp"],
      "env": { "WALLET_PROVIDER": "cdp", "CDP_API_KEY_ID": "...", "CDP_API_KEY_SECRET": "...", "CDP_WALLET_SECRET": "..." }
    }
  }
}
```

## CLI（人間用）

MCP ツールとしては公開しない補助コマンドです。

```bash
npx -y x402-wallet-mcp status                       # provider の準備状況
npx -y x402-wallet-mcp check <url> [method] [json]  # 402 の中身を見る（払わない）
npx -y x402-wallet-mcp pay <url> [method] [json]    # 上限内で 1 回払う
npx -y x402-wallet-mcp privy-create-wallet [ethereum|solana]
npx -y x402-wallet-mcp crossmint-gen-secret
npx -y x402-wallet-mcp crossmint-create-wallet [alias]
npx -y x402-wallet-mcp crossmint-staging-fund [amount]
```

## 開発

```bash
npm install
npm run build
npm test                 # 単体テスト（402 パース、accepts 選択、上限チェック、支払いフロー）
WALLET_PROVIDER=cdp ... npm run test:integration -- [url]   # testnet で実払い 1 件
```

結合テストの既定 URL は Bazaar 上の Base Sepolia $0.001 エンドポイントです。`config.json` が `testnet` でないと実行しません。テスト USDC は [Circle faucet](https://faucet.circle.com/)（Base Sepolia / Solana Devnet）で入金します。

## ライセンス

MIT
