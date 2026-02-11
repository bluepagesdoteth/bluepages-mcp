#!/usr/bin/env node
/**
 * MCP Server for Bluepages API
 *
 * This implements the Model Context Protocol (MCP) specification
 * to expose bluepages functionality to AI assistants.
 *
 * Features:
 * - Tools for address/Twitter lookups
 * - Resources for API info and pricing
 * - Prompts for common workflows
 * - Streaming for batch operations
 * - Notifications for credit warnings
 *
 * Supports two authentication modes:
 * 1. API Key: Set BLUEPAGES_API_KEY env var (no wallet needed)
 * 2. x402 Payments: Set PRIVATE_KEY env var for automatic payments
 *
 * Configure in Claude Desktop:
 * {
 *   "mcpServers": {
 *     "bluepages": {
 *       "command": "node",
 *       "args": ["/path/to/mcp-server.js"],
 *       "env": {
 *         "BLUEPAGES_API_KEY": "your-api-key-here"
 *       }
 *     }
 *   }
 * }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ethers } from "ethers";
import fetch from "node-fetch";

// Configuration
const API_URL = process.env.BLUEPAGES_API_URL || "https://bluepages.fyi";
const API_KEY = process.env.BLUEPAGES_API_KEY;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = "https://mainnet.base.org";

// Credit warning threshold
const LOW_CREDIT_WARNING = 1000;
const CRITICAL_CREDIT_WARNING = 100;

// Authentication mode
const AUTH_MODE = API_KEY ? "api-key" : PRIVATE_KEY ? "x402" : "none";

let wallet;
if (PRIVATE_KEY && !API_KEY) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  wallet = new ethers.Wallet(PRIVATE_KEY, provider);
}

// Track last known credits for notifications
let lastKnownCredits = null;
let serverInstance = null;

/**
 * Create x402 payment header for USDC authorization
 */
async function createPaymentHeader(paymentRequest) {
  if (!wallet) {
    throw new Error(
      "PRIVATE_KEY environment variable required for x402 payments",
    );
  }

  const accept = paymentRequest.accepts[0];
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const validAfter = Math.floor(Date.now() / 1000) - 600;
  const validBefore = Math.floor(Date.now() / 1000) + accept.maxTimeoutSeconds;

  const authorization = {
    from: wallet.address,
    to: accept.payTo,
    value: accept.maxAmountRequired,
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce,
  };

  const domain = {
    name: "USD Coin",
    version: "2",
    chainId: 8453,
    verifyingContract: accept.asset,
  };

  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };

  const signature = await wallet.signTypedData(domain, types, authorization);

  const payment = {
    x402Version: paymentRequest.x402Version,
    scheme: accept.scheme,
    network: accept.network,
    payload: { signature, authorization },
  };

  return Buffer.from(JSON.stringify(payment)).toString("base64");
}

/**
 * Build headers based on authentication mode
 */
function buildHeaders(contentType = null) {
  const headers = {};
  if (API_KEY) {
    headers["X-API-KEY"] = API_KEY;
  }
  if (contentType) {
    headers["Content-Type"] = contentType;
  }
  return headers;
}

/**
 * Send a notification to the client
 */
async function sendNotification(level, message, data = {}) {
  if (serverInstance) {
    try {
      await serverInstance.notification({
        method: "notifications/message",
        params: {
          level, // "info", "warning", "error"
          logger: "bluepages",
          message,
          data,
        },
      });
    } catch (e) {
      // Notifications are best-effort
      console.error("Failed to send notification:", e.message);
    }
  }
}

/**
 * Check credits and send warning notifications if low
 */
async function checkCreditsAndNotify(credits) {
  if (!API_KEY || credits === null || credits === undefined) return;

  // Only notify if credits dropped below threshold
  if (lastKnownCredits !== null) {
    if (
      credits <= CRITICAL_CREDIT_WARNING &&
      lastKnownCredits > CRITICAL_CREDIT_WARNING
    ) {
      await sendNotification(
        "error",
        `⚠️ CRITICAL: Only ${credits} Bluepages credits remaining! Purchase more at bluepages.fyi/api-keys.html`,
        { credits, threshold: CRITICAL_CREDIT_WARNING },
      );
    } else if (
      credits <= LOW_CREDIT_WARNING &&
      lastKnownCredits > LOW_CREDIT_WARNING
    ) {
      await sendNotification(
        "warning",
        `⚠️ Low credits: ${credits} remaining. Consider purchasing more.`,
        { credits, threshold: LOW_CREDIT_WARNING },
      );
    }
  }

  lastKnownCredits = credits;
}

/**
 * Fetch with automatic authentication (API key or x402 payment)
 */
async function fetchWithAuth(url, options = {}) {
  const headers = buildHeaders(options.contentType);

  // If using API key, just make the request
  if (API_KEY) {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: { ...headers, ...options.headers },
      body: options.body,
    });

    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ error: response.statusText }));
      throw new Error(error.error || `Request failed: ${response.status}`);
    }

    const result = await response.json();

    // Check for credit info in response headers or body
    const creditsHeader = response.headers.get("X-Credits-Remaining");
    if (creditsHeader) {
      await checkCreditsAndNotify(parseInt(creditsHeader, 10));
    }

    return result;
  }

  // x402 payment flow
  const response1 = await fetch(url, {
    method: options.method || "GET",
    headers: { ...headers, ...options.headers },
    body: options.body,
  });

  if (response1.status !== 402) {
    if (!response1.ok) {
      const error = await response1
        .json()
        .catch(() => ({ error: response1.statusText }));
      throw new Error(error.error || `Request failed: ${response1.status}`);
    }
    return response1.json();
  }

  // Handle 402 payment required
  if (!wallet) {
    throw new Error(
      "Payment required but no PRIVATE_KEY or BLUEPAGES_API_KEY configured",
    );
  }

  const paymentRequest = await response1.json();
  const paymentHeader = await createPaymentHeader(paymentRequest);

  const response2 = await fetch(url, {
    method: options.method || "GET",
    headers: {
      ...headers,
      ...options.headers,
      "X-PAYMENT": paymentHeader,
    },
    body: options.body,
  });

  if (!response2.ok) {
    const error = await response2
      .json()
      .catch(() => ({ error: response2.statusText }));
    throw new Error(error.error || `Request failed: ${response2.status}`);
  }

  return response2.json();
}

/**
 * GET request with authentication
 */
async function getWithAuth(url) {
  return fetchWithAuth(url);
}

/**
 * POST request with authentication
 */
async function postWithAuth(url, body) {
  return fetchWithAuth(url, {
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/**
 * Format a result for human-readable output
 */
function formatResult(result, query) {
  if (result.found === false) {
    return `No data found for ${query}`;
  }

  let output = [];

  // Handle identity search (multiple results)
  if (result.results && Array.isArray(result.results)) {
    output.push(`Found ${result.totalMatches} match(es) for "${query}":\n`);

    for (const match of result.results) {
      output.push(`Address: ${match.address}`);
      output.push(`  Match: ${match.matchType} = ${match.matchedValue}`);

      if (match.identities && match.identities.length > 0) {
        for (const identity of match.identities) {
          output.push(
            `  ${identity.type}: ${identity.value} (${identity.source})`,
          );
        }
      }

      if (match.cluster) {
        output.push(
          `  Cluster: ${match.cluster.id} (${match.cluster.totalAddresses} addresses)`,
        );
      }
      output.push("");
    }

    return output.join("\n");
  }

  // Handle single address lookup
  if (result.address) {
    output.push(`Address: ${result.address}`);
  }

  // New format: identities array
  if (result.identities && result.identities.length > 0) {
    const twitter = result.identities.find((i) => i.type === "twitter");
    const farcaster = result.identities.find((i) => i.type === "farcaster");
    const email = result.identities.find((i) => i.type === "email");

    if (twitter) output.push(`Twitter: ${twitter.value} (${twitter.source})`);
    if (farcaster)
      output.push(`Farcaster: ${farcaster.value} (${farcaster.source})`);
    if (email) output.push(`Email: ${email.value} (${email.source})`);

    // Show all identities if there are more
    const otherIdentities = result.identities.filter(
      (i) => !["twitter", "farcaster", "email"].includes(i.type),
    );
    for (const identity of otherIdentities) {
      output.push(`${identity.type}: ${identity.value} (${identity.source})`);
    }
  }

  // Cluster info
  if (result.cluster) {
    output.push("");
    output.push(`Cluster: ${result.cluster.id}`);
    output.push(`  Source: ${result.cluster.source}`);
    output.push(
      `  Addresses: ${result.cluster.totalAddresses}${result.cluster.truncated ? " (truncated)" : ""}`,
    );
    if (result.cluster.transitive) output.push(`  Transitive: yes`);
    if (result.cluster.addresses && result.cluster.addresses.length > 0) {
      output.push(
        `  Members: ${result.cluster.addresses.slice(0, 5).join(", ")}${result.cluster.addresses.length > 5 ? "..." : ""}`,
      );
    }
  }

  // Sources summary
  if (result.sources && result.sources.length > 0) {
    output.push(`\nSources: ${result.sources.join(", ")}`);
  }

  return output.join("\n") || JSON.stringify(result, null, 2);
}

/**
 * Process batch items with streaming progress updates
 * Handles both /batch/check (exists, twitter bool) and /batch/data (found, primary obj) formats
 */
async function processBatchWithStreaming(
  items,
  type,
  endpoint,
  progressCallback,
) {
  const results = [];
  const batchSize = 50;
  const isDataEndpoint = endpoint.includes("/data");

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, Math.min(i + batchSize, items.length));
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(items.length / batchSize);

    // Send progress notification
    await progressCallback({
      type: "progress",
      message: `Processing batch ${batchNum}/${totalBatches} (${batch.length} ${type}s)...`,
      current: i + batch.length,
      total: items.length,
      percentage: Math.round(((i + batch.length) / items.length) * 100),
    });

    // Make the API call
    const body =
      type === "address" ? { addresses: batch } : { twitters: batch };
    const result = await postWithAuth(`${API_URL}${endpoint}`, body);

    // Extract results - response is an object keyed by address/twitter
    const key = type === "address" ? "addresses" : "twitters";
    if (result.results?.[key]) {
      // Convert object format to array format
      for (const [itemKey, info] of Object.entries(result.results[key])) {
        let itemResult;

        if (isDataEndpoint) {
          // /batch/data returns: { found, primary: { twitter, metadata }, alternates }
          itemResult = {
            [type === "address" ? "address" : "twitter"]: itemKey,
            found: info.found,
            twitter: info.primary?.twitter || null,
            displayName: info.primary?.metadata?.displayName || null,
            source: info.primary?.metadata?.source || null,
            alternates: info.alternates?.length || 0,
          };
        } else {
          // /batch/check returns: { exists, twitter: bool, farcaster: bool }
          itemResult = {
            [type === "address" ? "address" : "twitter"]: itemKey,
            found: info.exists,
            twitter: info.twitter,
            farcaster: info.farcaster,
          };
        }

        results.push(itemResult);

        // Send individual results as they come in
        const isFound = isDataEndpoint ? info.found : info.exists;
        if (isFound) {
          const message = isDataEndpoint
            ? `✓ Found: ${itemKey} → ${info.primary?.twitter || "no twitter"}`
            : `✓ Found: ${itemKey} (twitter: ${info.twitter}, farcaster: ${info.farcaster})`;

          await progressCallback({
            type: "result",
            message,
            item: itemResult,
          });
        }
      }
    }
  }

  return results;
}

// Create MCP server with full capabilities
const server = new Server(
  {
    name: "bluepages",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
      logging: {},
    },
  },
);

// Store server instance for notifications
serverInstance = server;

// ==================== TOOLS ====================

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [
    {
      name: "check_address",
      description:
        "Check if an Ethereum address exists in the Bluepages database. Returns whether data is available. Fast and cheap - use this first before fetching full data. Cost: 1 credit ($0.001 USD).",
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "Ethereum address to check (0x format, 42 characters)",
            pattern: "^0x[a-fA-F0-9]{40}$",
          },
        },
        required: ["address"],
      },
    },
    {
      name: "check_twitter",
      description:
        "Check if a Twitter/X handle exists in the Bluepages database. Returns whether data is available. Cost: 1 credit ($0.001 USD).",
      inputSchema: {
        type: "object",
        properties: {
          twitter: {
            type: "string",
            description: "Twitter/X handle (with or without @)",
          },
        },
        required: ["twitter"],
      },
    },
    {
      name: "get_data_for_address",
      description:
        "Get Twitter/Farcaster for a SINGLE address. For MULTIPLE addresses, use batch_get_data instead (faster and cheaper). Cost: 50 credits when data found, free if not found.",
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "Ethereum address (0x format, 42 characters)",
            pattern: "^0x[a-fA-F0-9]{40}$",
          },
        },
        required: ["address"],
      },
    },
    {
      name: "get_data_for_twitter",
      description:
        "Get Ethereum addresses for a SINGLE Twitter handle. For MULTIPLE handles, use batch_get_data instead (faster and cheaper). Cost: 50 credits when data found, free if not found.",
      inputSchema: {
        type: "object",
        properties: {
          twitter: {
            type: "string",
            description: "Twitter/X handle (with or without @)",
          },
        },
        required: ["twitter"],
      },
    },
    {
      name: "batch_check",
      description:
        "Check multiple addresses and/or Twitter handles at once (up to 50 total). More efficient than individual checks. Cost: 40 credits ($0.04 USD) per batch.",
      inputSchema: {
        type: "object",
        properties: {
          addresses: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of Ethereum addresses to check (max 50 total with twitters)",
          },
          twitters: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of Twitter handles to check (max 50 total with addresses)",
          },
        },
      },
    },
    {
      name: "batch_get_data",
      description:
        "RECOMMENDED for multiple addresses. Get full data for up to 50 addresses/Twitter handles at once. Much cheaper than individual get_data calls. First use batch_check to find which have data, then call this. Cost: API key users pay 40 credits per item found; x402 users pay $2.00 flat per batch.",
      inputSchema: {
        type: "object",
        properties: {
          addresses: {
            type: "array",
            items: { type: "string" },
            description: "Array of Ethereum addresses to get data for",
          },
          twitters: {
            type: "array",
            items: { type: "string" },
            description: "Array of Twitter handles to get data for",
          },
        },
      },
    },
    {
      name: "batch_check_streaming",
      description:
        "Check a large list of addresses with streaming progress updates. Use this for lists larger than 50 items. Sends progress notifications as batches complete. Cost: 40 credits per batch of 50.",
      inputSchema: {
        type: "object",
        properties: {
          addresses: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of Ethereum addresses to check (any size, processed in batches of 50)",
          },
        },
        required: ["addresses"],
      },
    },
    {
      name: "batch_get_data_streaming",
      description:
        "Get data for a large list of addresses with streaming progress updates. Use this for lists larger than 50 items. Sends notifications as results are found. Cost: API key users pay 40 credits per item found; x402 users pay $2.00 per batch of 50.",
      inputSchema: {
        type: "object",
        properties: {
          addresses: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of Ethereum addresses to get data for (any size, processed in batches of 50)",
          },
        },
        required: ["addresses"],
      },
    },
  ];

  // Add credit check tool only if using API key
  if (API_KEY) {
    tools.push({
      name: "check_credits",
      description:
        "Check your remaining API credits and points. Only available when using API key authentication.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    });

    tools.push({
      name: "set_credit_alert",
      description:
        "Set a custom threshold for low credit warnings. You'll receive a notification when credits drop below this level.",
      inputSchema: {
        type: "object",
        properties: {
          threshold: {
            type: "number",
            description: "Credit threshold for warnings (default: 1000)",
            minimum: 0,
          },
        },
        required: ["threshold"],
      },
    });
  }

  // Add wallet-based tools only if using x402 (has wallet)
  if (wallet) {
    tools.push({
      name: "get_api_key",
      description:
        "Get your API key by signing a message with your wallet. Creates an account if you don't have one. Use this after purchase_credits to get your API key, or to retrieve an existing key.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    });

    tools.push({
      name: "purchase_credits",
      description:
        "Purchase API credits using x402 payment (USDC on Base). Packages: starter (5,000 credits, $5), pro (50,000 credits, $45), enterprise (1,000,000 credits, $600). Returns an API key if you don't have one.",
      inputSchema: {
        type: "object",
        properties: {
          package: {
            type: "string",
            enum: ["starter", "pro", "enterprise"],
            description: "Credit package to purchase",
          },
        },
        required: ["package"],
      },
    });
  }

  return { tools };
});

// Custom alert threshold
let customAlertThreshold = LOW_CREDIT_WARNING;

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Block all tool calls when no credentials are configured
  if (AUTH_MODE === "none") {
    return {
      content: [
        {
          type: "text",
          text:
            `Bluepages is not configured. Set one of these environment variables and restart:\n\n` +
            `Option 1 (recommended): BLUEPAGES_API_KEY\n` +
            `  Get a key at https://bluepages.fyi/api-keys.html\n` +
            `  20% cheaper, 2x rate limits\n\n` +
            `Option 2: PRIVATE_KEY\n` +
            `  Ethereum private key for x402 payments (USDC on Base)\n` +
            `  No API key needed, pay per request`,
        },
      ],
      isError: true,
    };
  }

  try {
    switch (name) {
      case "check_address": {
        const result = await getWithAuth(
          `${API_URL}/check?address=${encodeURIComponent(args.address)}`,
        );
        return {
          content: [
            {
              type: "text",
              text: result.exists
                ? `✓ Address ${args.address} found in database (types: ${result.types?.join(", ") || "unknown"})`
                : `✗ Address ${args.address} not found in database`,
            },
          ],
        };
      }

      case "check_twitter": {
        const twitter = args.twitter.startsWith("@")
          ? args.twitter
          : `@${args.twitter}`;
        const result = await getWithAuth(
          `${API_URL}/check?identity=${encodeURIComponent(twitter)}`,
        );
        return {
          content: [
            {
              type: "text",
              text: result.exists
                ? `✓ ${twitter} found in database (types: ${result.types?.join(", ") || "unknown"})`
                : `✗ ${twitter} not found in database`,
            },
          ],
        };
      }

      case "get_data_for_address": {
        const result = await getWithAuth(
          `${API_URL}/data?address=${encodeURIComponent(args.address)}`,
        );
        return {
          content: [
            {
              type: "text",
              text: formatResult(result, args.address),
            },
          ],
        };
      }

      case "get_data_for_twitter": {
        const twitter = args.twitter.startsWith("@")
          ? args.twitter
          : `@${args.twitter}`;
        const result = await getWithAuth(
          `${API_URL}/data?identity=${encodeURIComponent(twitter)}`,
        );
        return {
          content: [
            {
              type: "text",
              text: formatResult(result, twitter),
            },
          ],
        };
      }

      case "batch_check": {
        const body = {};
        if (args.addresses && args.addresses.length > 0) {
          body.addresses = args.addresses;
        }
        if (args.twitters && args.twitters.length > 0) {
          body.twitters = args.twitters.map((t) =>
            t.startsWith("@") ? t : `@${t}`,
          );
        }

        if (!body.addresses && !body.twitters) {
          throw new Error("At least one address or twitter handle required");
        }

        const result = await postWithAuth(`${API_URL}/batch/check`, body);

        // Format summary - results are objects keyed by address/twitter
        let foundAddresses = 0;
        let foundTwitters = 0;

        if (result.results?.addresses) {
          foundAddresses = Object.values(result.results.addresses).filter(
            (a) => a.exists,
          ).length;
        }
        if (result.results?.twitters) {
          foundTwitters = Object.values(result.results.twitters).filter(
            (t) => t.exists,
          ).length;
        }

        const total =
          (args.addresses?.length || 0) + (args.twitters?.length || 0);
        const found = foundAddresses + foundTwitters;

        // Format detailed output
        let details = [];
        if (result.results?.addresses) {
          for (const [addr, info] of Object.entries(result.results.addresses)) {
            const status = info.exists
              ? `✓ found (twitter: ${info.twitter}, farcaster: ${info.farcaster})`
              : "✗ not found";
            details.push(`${addr}: ${status}`);
          }
        }
        if (result.results?.twitters) {
          for (const [handle, info] of Object.entries(
            result.results.twitters,
          )) {
            const status = info.exists
              ? `✓ found (twitter: ${info.twitter}, farcaster: ${info.farcaster})`
              : "✗ not found";
            details.push(`${handle}: ${status}`);
          }
        }

        return {
          content: [
            {
              type: "text",
              text: `Batch check complete: ${found}/${total} items found in database\n\n${details.join("\n")}`,
            },
          ],
        };
      }

      case "batch_get_data": {
        const body = {};
        if (args.addresses && args.addresses.length > 0) {
          body.addresses = args.addresses;
        }
        if (args.twitters && args.twitters.length > 0) {
          body.twitters = args.twitters.map((t) =>
            t.startsWith("@") ? t : `@${t}`,
          );
        }

        if (!body.addresses && !body.twitters) {
          throw new Error("At least one address or twitter handle required");
        }

        const result = await postWithAuth(`${API_URL}/batch/data`, body);

        // Format summary - /batch/data returns primary.twitter format
        let lines = ["Batch data retrieval complete:\n"];

        if (result.results?.addresses) {
          for (const [addr, info] of Object.entries(result.results.addresses)) {
            if (info.found && info.primary) {
              lines.push(`${addr}`);
              if (info.primary.twitter) {
                const source = info.primary.metadata?.source || "unknown";
                lines.push(`  Twitter: ${info.primary.twitter} (${source})`);
              }
              if (info.primary.metadata?.displayName) {
                lines.push(
                  `  Display Name: ${info.primary.metadata.displayName}`,
                );
              }
              if (info.alternates && info.alternates.length > 0) {
                lines.push(
                  `  Alternates: ${info.alternates.length} other sources`,
                );
              }
              lines.push("");
            }
          }
        }

        if (result.results?.twitters) {
          for (const [handle, info] of Object.entries(
            result.results.twitters,
          )) {
            if (info.found && info.primary) {
              lines.push(`${handle} → ${info.primary.address}`);
              if (info.primary.metadata?.displayName) {
                lines.push(
                  `  Display Name: ${info.primary.metadata.displayName}`,
                );
              }
              lines.push("");
            }
          }
        }

        return {
          content: [
            {
              type: "text",
              text: lines.join("\n"),
            },
          ],
        };
      }

      case "batch_check_streaming": {
        if (!args.addresses || args.addresses.length === 0) {
          throw new Error("At least one address required");
        }

        await sendNotification(
          "info",
          `Starting batch check of ${args.addresses.length} addresses...`,
          { total: args.addresses.length },
        );

        const results = await processBatchWithStreaming(
          args.addresses,
          "address",
          "/batch/check",
          async (progress) => {
            await sendNotification(
              progress.type === "progress" ? "info" : "info",
              progress.message,
              progress,
            );
          },
        );

        const found = results.filter((r) => r.found).length;
        const notFound = results.filter((r) => !r.found).length;

        await sendNotification(
          "info",
          `✓ Batch check complete: ${found} found, ${notFound} not found`,
          { found, notFound, total: results.length },
        );

        return {
          content: [
            {
              type: "text",
              text: `Batch check complete!\n\nFound: ${found}\nNot found: ${notFound}\n\nFound addresses:\n${
                results
                  .filter((r) => r.found)
                  .map((r) => `  ✓ ${r.address}`)
                  .join("\n") || "  (none)"
              }`,
            },
          ],
        };
      }

      case "batch_get_data_streaming": {
        if (!args.addresses || args.addresses.length === 0) {
          throw new Error("At least one address required");
        }

        await sendNotification(
          "info",
          `Starting data retrieval for ${args.addresses.length} addresses...`,
          { total: args.addresses.length },
        );

        const foundItems = [];
        const results = await processBatchWithStreaming(
          args.addresses,
          "address",
          "/batch/data",
          async (progress) => {
            if (progress.type === "result" && progress.item?.found) {
              foundItems.push(progress.item);
            }
            await sendNotification("info", progress.message, progress);
          },
        );

        await sendNotification(
          "info",
          `✓ Data retrieval complete: found data for ${foundItems.length} addresses`,
          { found: foundItems.length, total: args.addresses.length },
        );

        // Format output - items come from processBatchWithStreaming with parsed fields
        let output = `Data retrieval complete!\n\nFound: ${foundItems.length}/${args.addresses.length}\n\n`;

        if (foundItems.length > 0) {
          output += "Results:\n";
          for (const item of foundItems) {
            output += `\n${item.address}\n`;

            // processBatchWithStreaming now extracts twitter, displayName, source directly
            if (item.twitter) {
              output += `  Twitter: ${item.twitter}`;
              if (item.source) output += ` (${item.source})`;
              output += "\n";
            }
            if (item.displayName) {
              output += `  Display Name: ${item.displayName}\n`;
            }
            if (item.alternates > 0) {
              output += `  Alternates: ${item.alternates} other sources\n`;
            }
          }
        }

        return {
          content: [
            {
              type: "text",
              text: output,
            },
          ],
        };
      }

      case "check_credits": {
        if (!API_KEY) {
          throw new Error(
            "check_credits only available with API key authentication",
          );
        }

        const result = await getWithAuth(`${API_URL}/api/me`);
        const credits = result.credits || 0;

        // Update tracked credits
        await checkCreditsAndNotify(credits);

        let status = "";
        if (credits <= CRITICAL_CREDIT_WARNING) {
          status = " ⚠️ CRITICAL - purchase more credits!";
        } else if (credits <= customAlertThreshold) {
          status = " ⚠️ Running low";
        }

        return {
          content: [
            {
              type: "text",
              text: `Credits remaining: ${credits.toLocaleString()}${status}\nPoints earned: ${(result.points || 0).toLocaleString()}\n\nAlert threshold: ${customAlertThreshold.toLocaleString()} credits`,
            },
          ],
        };
      }

      case "set_credit_alert": {
        if (!API_KEY) {
          throw new Error(
            "set_credit_alert only available with API key authentication",
          );
        }

        customAlertThreshold = args.threshold;

        await sendNotification(
          "info",
          `Credit alert threshold set to ${customAlertThreshold.toLocaleString()} credits`,
          { threshold: customAlertThreshold },
        );

        return {
          content: [
            {
              type: "text",
              text: `✓ Credit alert threshold set to ${customAlertThreshold.toLocaleString()} credits.\nYou'll receive a warning when your balance drops below this level.`,
            },
          ],
        };
      }

      case "get_api_key": {
        if (!wallet) {
          throw new Error(
            "get_api_key requires PRIVATE_KEY to sign the authentication message",
          );
        }

        // Create and sign authentication message
        const message = `Authenticate with Bluepages API\n\nAddress: ${wallet.address}\nTimestamp: ${Date.now()}`;
        const signature = await wallet.signMessage(message);

        // Call auth endpoint
        const response = await fetch(`${API_URL}/api/auth`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            address: wallet.address,
            message,
            signature,
          }),
        });

        if (!response.ok) {
          const error = await response
            .json()
            .catch(() => ({ error: response.statusText }));
          throw new Error(error.error || `Auth failed: ${response.status}`);
        }

        const result = await response.json();
        const user = result.user;

        return {
          content: [
            {
              type: "text",
              text:
                `✓ ${result.isNew ? "Account created!" : "Retrieved API key"}\n\n` +
                `API Key: ${user.apiKey}\n` +
                `Address: ${user.address}\n` +
                `Credits: ${user.credits?.toLocaleString() || 0}\n\n` +
                `To use the API key, set:\nexport BLUEPAGES_API_KEY="${user.apiKey}"`,
            },
          ],
        };
      }

      case "purchase_credits": {
        if (!wallet) {
          throw new Error(
            "purchase_credits requires PRIVATE_KEY for x402 payments",
          );
        }

        const packageName = args.package;
        const packages = {
          starter: { credits: 5000, priceUsd: 5, priceUsdc: "5000000" },
          pro: { credits: 50000, priceUsd: 45, priceUsdc: "45000000" },
          enterprise: {
            credits: 1000000,
            priceUsd: 600,
            priceUsdc: "600000000",
          },
        };

        const pkg = packages[packageName];
        if (!pkg) {
          throw new Error(`Invalid package: ${packageName}`);
        }

        await sendNotification(
          "info",
          `Purchasing ${pkg.credits.toLocaleString()} credits ($${pkg.priceUsd})...`,
          { package: packageName },
        );

        // Make initial request to get payment requirements
        const response1 = await fetch(
          `${API_URL}/api/credits/purchase?package=${packageName}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ address: wallet.address }),
          },
        );

        if (response1.status !== 402) {
          const error = await response1
            .json()
            .catch(() => ({ error: response1.statusText }));
          throw new Error(
            error.error || `Unexpected response: ${response1.status}`,
          );
        }

        const paymentRequest = await response1.json();
        const paymentHeader = await createPaymentHeader(paymentRequest);

        // Make payment
        const response2 = await fetch(
          `${API_URL}/api/credits/purchase?package=${packageName}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-PAYMENT": paymentHeader,
            },
            body: JSON.stringify({ address: wallet.address }),
          },
        );

        if (!response2.ok) {
          const error = await response2
            .json()
            .catch(() => ({ error: response2.statusText }));
          throw new Error(error.error || `Payment failed: ${response2.status}`);
        }

        const result = await response2.json();

        await sendNotification(
          "info",
          `✓ Purchased ${result.creditsAdded?.toLocaleString() || pkg.credits.toLocaleString()} credits!`,
          { credits: result.newCredits, txHash: result.transactionHash },
        );

        return {
          content: [
            {
              type: "text",
              text: `✓ Successfully purchased ${result.creditsAdded?.toLocaleString() || pkg.credits.toLocaleString()} credits!\n\nNew balance: ${result.newCredits?.toLocaleString() || "unknown"} credits\nTransaction: ${result.transactionHash || "confirmed"}\n\nYou can now switch to API key authentication for 20% cheaper requests.\nYour wallet address: ${wallet.address}`,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// ==================== RESOURCES ====================

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "bluepages://info",
        name: "Bluepages API Information",
        description:
          "Information about the Bluepages API, authentication, and pricing",
        mimeType: "text/plain",
      },
      {
        uri: "bluepages://pricing",
        name: "Pricing Information",
        description: "Credit costs for each endpoint",
        mimeType: "text/plain",
      },
      {
        uri: "bluepages://status",
        name: "Current Session Status",
        description: "Your current credits, points, and session information",
        mimeType: "text/plain",
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  switch (uri) {
    case "bluepages://info":
      return {
        contents: [
          {
            uri,
            mimeType: "text/plain",
            text: `${
              AUTH_MODE === "none"
                ? `⚠️  NOT CONFIGURED — All tool calls will fail until credentials are set.

Set one of these environment variables and restart:

  Option 1 (recommended): BLUEPAGES_API_KEY
    Get a key at https://bluepages.fyi/api-keys.html
    20% cheaper, 2x rate limits

  Option 2: PRIVATE_KEY
    Ethereum private key for x402 payments (USDC on Base)
    No API key needed, pay per request

${"─".repeat(60)}
`
                : ""
            }Bluepages API - Crypto Address ↔ Twitter/X Lookup Service

Bluepages maintains a database of over 800,000 verified connections between
Ethereum addresses and Twitter/X handles, along with Farcaster usernames and
display names.

Authentication Mode: ${AUTH_MODE === "api-key" ? "API Key" : AUTH_MODE === "x402" ? "x402 Payments (USDC on Base)" : "Not configured"}
${AUTH_MODE === "api-key" ? "Use check_credits tool to see remaining balance" : ""}
${AUTH_MODE === "x402" ? `Wallet: ${wallet?.address || "Not configured"}` : ""}

Usage Tips:
1. Use check_address or check_twitter first (cheap) to see if data exists
2. Only call get_data_* when check returns found=true
3. Use batch_* endpoints for multiple lookups (more efficient)
4. Use batch_*_streaming for large lists (100+ items) to see progress
5. The /data endpoints don't charge if no data is found

Features:
- Streaming: batch_check_streaming and batch_get_data_streaming for large lists
- Notifications: Low credit warnings when balance drops below threshold
- Credit alerts: Use set_credit_alert to customize warning threshold

API URL: ${API_URL}`,
          },
        ],
      };

    case "bluepages://pricing":
      return {
        contents: [
          {
            uri,
            mimeType: "text/plain",
            text: `Bluepages API Pricing

Payment Methods:
1. API Key (credits) - 1 credit = $0.001 USD
2. x402 (USDC on Base) - Pay per request

Single Operations:
- check_address / check_twitter: 1 credit ($0.001)
- get_data_for_address / get_data_for_twitter: 50 credits ($0.05) - only if found

Batch Operations (up to 50 items per batch):
- batch_check: 40 credits ($0.04) per batch
- batch_get_data:
  * API Key: 40 credits per item with data found
  * x402: $2.00 flat per batch (regardless of items)

Streaming Operations (same pricing, for large lists):
- batch_check_streaming: 40 credits ($0.04) per batch of 50
- batch_get_data_streaming: Same as batch_get_data

Credit Packages:
- 5,000 credits: $5 (Starter)
- 50,000 credits: $45 (Pro - 10% discount)
- 1,000,000 credits: $600 (Enterprise - 40% discount)

Cost Optimization Tips:
1. Use batch_check first to find which addresses have data ($0.04 per 50)
2. Collect all found addresses, then call batch_get_data in full batches
3. This two-phase approach saves 90%+ vs calling batch_get_data per batch

Notes:
- get_data doesn't charge if no data is found
- Credits never expire
- You earn 1 point for every credit spent (shown on leaderboard)`,
          },
        ],
      };

    case "bluepages://status": {
      if (API_KEY) {
        try {
          const result = await getWithAuth(`${API_URL}/api/me`);
          return {
            contents: [
              {
                uri,
                mimeType: "text/plain",
                text: `Current Session Status

Authentication: API Key
Credits: ${(result.credits || 0).toLocaleString()}
Points: ${(result.points || 0).toLocaleString()}
Alert Threshold: ${customAlertThreshold.toLocaleString()} credits

${result.credits <= CRITICAL_CREDIT_WARNING ? "⚠️ CRITICAL: Credits very low!" : result.credits <= customAlertThreshold ? "⚠️ Credits running low" : "✓ Credits OK"}`,
              },
            ],
          };
        } catch (e) {
          return {
            contents: [
              {
                uri,
                mimeType: "text/plain",
                text: `Current Session Status

Authentication: API Key
Status: Error fetching credits - ${e.message}`,
              },
            ],
          };
        }
      } else if (wallet) {
        return {
          contents: [
            {
              uri,
              mimeType: "text/plain",
              text: `Current Session Status

Authentication: x402 Payments
Wallet: ${wallet.address}
Mode: Pay-per-request with USDC on Base

Note: Check your wallet balance for available funds.`,
            },
          ],
        };
      } else {
        return {
          contents: [
            {
              uri,
              mimeType: "text/plain",
              text: `Current Session Status

Authentication: Not configured

Set BLUEPAGES_API_KEY or PRIVATE_KEY environment variable to enable API access.`,
            },
          ],
        };
      }
    }

    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
});

// ==================== PROMPTS ====================

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: "analyze_addresses",
        description:
          "Analyze a list of Ethereum addresses to find their Twitter/social identities",
        arguments: [
          {
            name: "addresses",
            description: "Comma-separated list of Ethereum addresses",
            required: true,
          },
        ],
      },
      {
        name: "find_crypto_twitter",
        description:
          "Find the Ethereum address for a Twitter/X crypto personality",
        arguments: [
          {
            name: "twitter_handle",
            description: "Twitter/X handle to look up",
            required: true,
          },
        ],
      },
      {
        name: "analyze_large_list",
        description:
          "Analyze a large list of addresses (100+) with streaming progress updates",
        arguments: [
          {
            name: "addresses",
            description:
              "Comma-separated list of Ethereum addresses (any size)",
            required: true,
          },
        ],
      },
    ],
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "analyze_addresses":
      return {
        description: "Analyze Ethereum addresses for social identities",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Please analyze these Ethereum addresses and find any associated Twitter/social identities:

${args?.addresses || "No addresses provided"}

For each address:
1. First use batch_check to efficiently check which addresses have data
2. Then use batch_get_data only for addresses that were found
3. Summarize the findings in a clear format`,
            },
          },
        ],
      };

    case "find_crypto_twitter":
      return {
        description: "Find crypto address for Twitter personality",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Please find the Ethereum address associated with the Twitter/X handle: ${args?.twitter_handle || "unknown"}

1. First use check_twitter to verify the handle exists in the database
2. If found, use get_data_for_twitter to get the full details
3. Report any associated addresses, display name, and Farcaster username`,
            },
          },
        ],
      };

    case "analyze_large_list":
      return {
        description: "Analyze large list of addresses with streaming",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Please analyze this large list of Ethereum addresses with streaming progress:

${args?.addresses || "No addresses provided"}

Since this is a large list:
1. Use batch_check_streaming to check all addresses with progress updates
2. Then use batch_get_data_streaming for found addresses
3. Watch for progress notifications as batches complete
4. Summarize all findings when complete`,
            },
          },
        ],
      };

    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
});

// ==================== MAIN ====================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is reserved for MCP protocol)
  console.error(
    "═══════════════════════════════════════════════════════════════",
  );
  console.error("  Bluepages MCP Server v1.0.0");
  console.error(
    "═══════════════════════════════════════════════════════════════",
  );
  console.error(`  API URL: ${API_URL}`);
  console.error(
    `  Auth Mode: ${AUTH_MODE === "api-key" ? "API Key" : AUTH_MODE === "x402" ? "x402 Payments" : "None (configure BLUEPAGES_API_KEY or PRIVATE_KEY)"}`,
  );
  if (AUTH_MODE === "x402" && wallet) {
    console.error(`  Wallet: ${wallet.address}`);
  }
  console.error("");
  console.error("  Features:");
  console.error("    ✓ Tools for address/Twitter lookups");
  console.error("    ✓ Batch operations with streaming progress");
  console.error("    ✓ Low credit notifications");
  console.error("    ✓ Customizable alert thresholds");
  console.error(
    "═══════════════════════════════════════════════════════════════",
  );

  // Send initial notification if using API key
  if (API_KEY) {
    try {
      const result = await getWithAuth(`${API_URL}/api/me`);
      lastKnownCredits = result.credits || 0;
      console.error(`  Credits: ${lastKnownCredits.toLocaleString()}`);

      if (lastKnownCredits <= CRITICAL_CREDIT_WARNING) {
        console.error("  ⚠️ CRITICAL: Credits very low!");
      } else if (lastKnownCredits <= LOW_CREDIT_WARNING) {
        console.error("  ⚠️ Credits running low");
      }
    } catch (e) {
      console.error(`  Warning: Could not fetch credits - ${e.message}`);
    }
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
