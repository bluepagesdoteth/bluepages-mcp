# Bluepages MCP Server

[MCP](https://modelcontextprotocol.io) server for [Bluepages](https://bluepages.fyi) — crypto address ↔ identity and label lookups.

6M+ addresses linked to 4M+ social accounts and 4,800+ labeled wallets across 30+ sources. Identities span 10+ platforms (Twitter/X, Farcaster, GitHub, Discord, Telegram, email, and more). Lookups also return address labels (CEX wallets, exchanges), sanctions screening (OFAC and other lists), and cluster detection. Supports ETH, BTC, SOL, TRON, XMR, TON, Celestia, and XRP addresses.

## Quick start

```bash
npx -y github:bluepagesdoteth/bluepages-mcp
```

Requires either:

- `BLUEPAGES_API_KEY` — get one at [bluepages.fyi/api-keys](https://bluepages.fyi/api-keys.html) (recommended, 20% cheaper)
- `PRIVATE_KEY` — Ethereum private key for x402 pay-per-request (USDC on Base)

## Setup

Add to your MCP client's config (see [MCP clients](https://modelcontextprotocol.io/clients) for where each client stores this):

```json
{
  "mcpServers": {
    "bluepages": {
      "command": "npx",
      "args": ["-y", "github:bluepagesdoteth/bluepages-mcp"],
      "env": {
        "BLUEPAGES_API_KEY": "your_key_here",
        "PRIVATE_KEY": "your_eth_private_key_here"
      }
    }
  }
}
```

**Claude Code** users: [install the plugin](https://github.com/bluepagesdoteth/agent-plugins) instead — no manual config needed.

## Tools

| Tool                       | Cost                   | Description                                            |
| -------------------------- | ---------------------- | ------------------------------------------------------ |
| `check_address`            | 1 credit ($0.001)      | Check if address has data                              |
| `check_identity`           | 1 credit ($0.001)      | Check if identity (Twitter, email, GitHub, …) has data |
| `get_data_for_address`     | 50 credits ($0.05)     | Full data for address (free if not found)              |
| `get_data_for_identity`    | 50 credits ($0.05)     | Full data for identity (free if not found)             |
| `batch_check`              | 40 credits ($0.04)     | Check up to 50 addresses/identities                    |
| `batch_get_data`           | 40 credits/found item  | Data for up to 50 items (x402: $2.00 flat/batch)       |
| `batch_check_streaming`    | same as batch_check    | For large lists (100+), shows progress                 |
| `batch_get_data_streaming` | same as batch_get_data | For large lists (100+), shows progress                 |
| `search_tweets`            | 50 credits ($0.05)     | Tweets mentioning an address (charged even if none)    |
| `check_credits`            | free                   | Check remaining credits (API key only)                 |
| `set_credit_alert`         | free                   | Set low-credit warning threshold (API key only)        |
| `get_api_key`              | free                   | Get/create API key by signing message (PRIVATE_KEY)    |
| `purchase_credits`         | $5-$600 USDC           | Buy credits via x402 (PRIVATE_KEY only)                |

## Development

```bash
pnpm install
pnpm test            # unit + stdio integration tests (node:test, no network)
pnpm format          # prettier
```

Formatting logic lives in `src/lib.js`; `src/mcp-server.js` wires it to the MCP transport and the live API.

When the private `bluepages-fyi` repo is checked out as a sibling directory, `contract.test.js` additionally validates the test fixtures against its Zod response schemas (drift tripwire); elsewhere it auto-skips.

### CI and signoff

CI (`.github/workflows/test.yml`) runs the hermetic suite on GitHub-hosted runners, where the contract tests self-skip (no `bluepages-fyi` there). The contract tests are enforced **locally** via [gh-signoff](https://github.com/basecamp/gh-signoff) — run the suite on a dev machine and post the green check yourself:

```bash
gh extension install basecamp/gh-signoff   # once
pnpm run signoff                           # preflight → strict suite → gh signoff
```

`pnpm run signoff` starts with a preflight (`pnpm run signoff:doctor`) that checks every prerequisite in one pass — Node ≥ 21, the `bluepages-fyi` sibling checkout, its installed deps (the contract schemas import zod), gh auth, the gh-signoff extension — and lists all missing pieces with their fix commands, instead of failing serially. `pnpm run signoff:doctor --fix` additionally self-heals the deps step (`pnpm install --prod --ignore-scripts` in the sibling; skips the native better-sqlite3 build).

The suite then runs with `CONTRACT_REQUIRED=1`: if `bluepages-fyi` is not checked out as a sibling (schemas unavailable), the run **fails** instead of skipping the contract tests — a signoff always attests a full run, whatever the preflight said. Plain `pnpm test` keeps the graceful skip for consumers outside the workspace.

Make `signoff` a required status check on `main` (repo settings → Branches, one-time) so merges require a local run. A husky pre-push hook also runs `pnpm test` as a safety net.

## License

MIT
