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

## License

MIT
