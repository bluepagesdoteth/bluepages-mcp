#!/usr/bin/env node
/**
 * MCP Server for Bluepages API
 *
 * This implements the Model Context Protocol (MCP) specification
 * to expose bluepages functionality to AI assistants.
 *
 * Features:
 * - Tools for address/identity lookups
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
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import fetch from "node-fetch";
import {
  buildHeaders,
  CASE_INSENSITIVE_NOTE,
  createPaymentHeader,
  formatBatchCheckResult,
  formatBatchDataResult,
  formatResult,
  formatStreamingCheckSummary,
  formatStreamingDataSummary,
  formatTweetResults,
  processBatchWithStreaming,
  SUPPORTED_CHAINS,
} from "./lib.js";

const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

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
  const headers = buildHeaders(API_KEY, options.contentType);

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
  const paymentHeader = await createPaymentHeader(wallet, paymentRequest);

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

// Create MCP server with full capabilities
const server = new Server(
  {
    name: "bluepages",
    version: VERSION,
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
      description: `Check if a cryptocurrency address exists in the Bluepages database (${SUPPORTED_CHAINS}). Returns whether data is available. Fast and cheap - use this first before fetching full data. Cost: 1 credit ($0.001 USD). ${CASE_INSENSITIVE_NOTE}`,
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: `Cryptocurrency address to check (${SUPPORTED_CHAINS})`,
          },
        },
        required: ["address"],
      },
    },
    {
      name: "check_identity",
      description:
        "Check if an identity (Twitter handle, email, Farcaster, GitHub, Discord, etc.) exists in the Bluepages database. Returns whether data is available. Cost: 1 credit ($0.001 USD).",
      inputSchema: {
        type: "object",
        properties: {
          identity: {
            type: "string",
            description:
              "Identity to check: Twitter handle, email address, Farcaster username, GitHub username, Discord ID, etc.",
          },
        },
        required: ["identity"],
      },
    },
    {
      name: "get_data_for_address",
      description: `Get identity data for a SINGLE address. For MULTIPLE addresses, use batch_get_data instead (faster and cheaper). Cost: 50 credits when data found, free if not found. ${CASE_INSENSITIVE_NOTE}`,
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: `Cryptocurrency address (${SUPPORTED_CHAINS})`,
          },
        },
        required: ["address"],
      },
    },
    {
      name: "get_data_for_identity",
      description:
        "Get addresses and identity data for a SINGLE identity (Twitter handle, email, Farcaster, GitHub, Discord, etc.). For MULTIPLE identities, use batch_get_data instead (faster and cheaper). Cost: 50 credits when data found, free if not found.",
      inputSchema: {
        type: "object",
        properties: {
          identity: {
            type: "string",
            description:
              "Identity to look up: Twitter handle, email address, Farcaster username, GitHub username, Discord ID, etc.",
          },
        },
        required: ["identity"],
      },
    },
    {
      name: "batch_check",
      description: `Check multiple addresses and/or identities at once (up to 50 total). More efficient than individual checks. Cost: 40 credits ($0.04 USD) per batch. ${CASE_INSENSITIVE_NOTE}`,
      inputSchema: {
        type: "object",
        properties: {
          addresses: {
            type: "array",
            items: { type: "string" },
            description: `Array of cryptocurrency addresses to check (max 50 total with identities). Supports ${SUPPORTED_CHAINS}.`,
          },
          identities: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of identities to check (max 50 total with addresses): Twitter handles, emails, Farcaster/GitHub usernames, Discord IDs, etc.",
          },
        },
      },
    },
    {
      name: "batch_get_data",
      description: `RECOMMENDED for multiple addresses. Get full data for up to 50 addresses/identities at once. Much cheaper than individual get_data calls. First use batch_check to find which have data, then call this. Cost: API key users pay 40 credits per item found; x402 users pay $2.00 flat per batch. ${CASE_INSENSITIVE_NOTE}`,
      inputSchema: {
        type: "object",
        properties: {
          addresses: {
            type: "array",
            items: { type: "string" },
            description: `Array of cryptocurrency addresses to get data for (${SUPPORTED_CHAINS})`,
          },
          identities: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of identities to get data for: Twitter handles, emails, Farcaster/GitHub usernames, Discord IDs, etc.",
          },
        },
      },
    },
    {
      name: "batch_check_streaming",
      description: `Check a large list of addresses with streaming progress updates. Use this for lists larger than 50 items. Sends progress notifications as batches complete. Cost: 40 credits per batch of 50. ${CASE_INSENSITIVE_NOTE}`,
      inputSchema: {
        type: "object",
        properties: {
          addresses: {
            type: "array",
            items: { type: "string" },
            description: `Array of cryptocurrency addresses to check (any size, processed in batches of 50). Supports ${SUPPORTED_CHAINS}.`,
          },
        },
        required: ["addresses"],
      },
    },
    {
      name: "batch_get_data_streaming",
      description: `Get data for a large list of addresses with streaming progress updates. Use this for lists larger than 50 items. Sends notifications as results are found. Cost: API key users pay 40 credits per item found; x402 users pay $2.00 per batch of 50. ${CASE_INSENSITIVE_NOTE}`,
      inputSchema: {
        type: "object",
        properties: {
          addresses: {
            type: "array",
            items: { type: "string" },
            description: `Array of cryptocurrency addresses to get data for (any size, processed in batches of 50). Supports ${SUPPORTED_CHAINS}.`,
          },
        },
        required: ["addresses"],
      },
    },
    {
      name: "search_tweets",
      description: `Search Twitter/X for tweets mentioning a cryptocurrency address. Returns recent tweets that reference the address. Useful for finding on-chain activity discussions, scam reports, or community mentions. Cost: 50 credits ($0.05) — always charged even if no tweets are found. ${CASE_INSENSITIVE_NOTE}`,
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: `Cryptocurrency address to search for on Twitter/X (supports ${SUPPORTED_CHAINS})`,
          },
        },
        required: ["address"],
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
            `  Private key for x402 payments (USDC on Base)\n` +
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

      case "check_identity": {
        const result = await getWithAuth(
          `${API_URL}/check?identity=${encodeURIComponent(args.identity)}`,
        );
        return {
          content: [
            {
              type: "text",
              text: result.exists
                ? `✓ "${args.identity}" found in database (types: ${result.types?.join(", ") || "unknown"})`
                : `✗ "${args.identity}" not found in database`,
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

      case "get_data_for_identity": {
        const result = await getWithAuth(
          `${API_URL}/data?identity=${encodeURIComponent(args.identity)}`,
        );
        return {
          content: [
            {
              type: "text",
              text: formatResult(result, args.identity),
            },
          ],
        };
      }

      case "search_tweets": {
        const result = await getWithAuth(
          `${API_URL}/search/tweets?address=${encodeURIComponent(args.address)}`,
        );
        return {
          content: [
            {
              type: "text",
              text: formatTweetResults(result, args.address),
            },
          ],
        };
      }

      case "batch_check": {
        const body = {};
        if (args.addresses && args.addresses.length > 0) {
          body.addresses = args.addresses;
        }
        if (args.identities && args.identities.length > 0) {
          body.identities = args.identities;
        }

        if (!body.addresses && !body.identities) {
          throw new Error("At least one address or identity required");
        }

        const result = await postWithAuth(`${API_URL}/batch/check`, body);

        const total =
          (args.addresses?.length || 0) + (args.identities?.length || 0);

        return {
          content: [
            {
              type: "text",
              text: formatBatchCheckResult(result, total),
            },
          ],
        };
      }

      case "batch_get_data": {
        const body = {};
        if (args.addresses && args.addresses.length > 0) {
          body.addresses = args.addresses;
        }
        if (args.identities && args.identities.length > 0) {
          body.identities = args.identities;
        }

        if (!body.addresses && !body.identities) {
          throw new Error("At least one address or identity required");
        }

        const result = await postWithAuth(`${API_URL}/batch/data`, body);

        return {
          content: [
            {
              type: "text",
              text: formatBatchDataResult(result),
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
          (endpoint, body) => postWithAuth(`${API_URL}${endpoint}`, body),
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
              text: formatStreamingCheckSummary(results),
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
          (endpoint, body) => postWithAuth(`${API_URL}${endpoint}`, body),
        );

        await sendNotification(
          "info",
          `✓ Data retrieval complete: found data for ${foundItems.length} addresses`,
          { found: foundItems.length, total: args.addresses.length },
        );

        return {
          content: [
            {
              type: "text",
              text: formatStreamingDataSummary(
                foundItems,
                args.addresses.length,
              ),
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

        // Step 1: Fetch a one-time nonce
        const nonceRes = await fetch(`${API_URL}/api/nonce`);
        if (!nonceRes.ok) {
          throw new Error(`Failed to fetch nonce: ${nonceRes.status}`);
        }
        const { nonce } = await nonceRes.json();

        // Step 2: Build EIP-4361 (SIWE) message
        const domain = new URL(API_URL).host;
        const uri = API_URL;
        const now = new Date();
        const expiry = new Date(now.getTime() + 5 * 60 * 1000);
        const message = [
          `${domain} wants you to sign in with your Ethereum account:`,
          wallet.address,
          "",
          "Sign in to your Bluepages API dashboard.",
          "",
          `URI: ${uri}`,
          `Version: 1`,
          `Chain ID: 8453`,
          `Nonce: ${nonce}`,
          `Issued At: ${now.toISOString()}`,
          `Expiration Time: ${expiry.toISOString()}`,
        ].join("\n");
        const signature = await wallet.signMessage(message);

        // Step 3: Authenticate
        const response = await fetch(`${API_URL}/api/auth`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, signature }),
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
        const paymentHeader = await createPaymentHeader(wallet, paymentRequest);

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
    Private key for x402 payments (USDC on Base)
    No API key needed, pay per request

${"─".repeat(60)}
`
                : ""
            }Bluepages API - Crypto Address ↔ Identity Lookup Service

Bluepages maintains a database of over 800,000 connections between
cryptocurrency addresses (${SUPPORTED_CHAINS})
and social identities (Twitter, Farcaster, GitHub, Discord,
email, Telegram, Instagram, Reddit, LinkedIn, and more).

Authentication Mode: ${AUTH_MODE === "api-key" ? "API Key" : AUTH_MODE === "x402" ? "x402 Payments (USDC on Base)" : "Not configured"}
${AUTH_MODE === "api-key" ? "Use check_credits tool to see remaining balance" : ""}
${AUTH_MODE === "x402" ? `Wallet: ${wallet?.address || "Not configured"}` : ""}

Usage Tips:
1. Use check_address or check_identity first (cheap) to see if data exists
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
- check_address / check_identity: 1 credit ($0.001)
- get_data_for_address / get_data_for_identity: 50 credits ($0.05) - only if found
- search_tweets: 50 credits ($0.05) - always charged

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
          "Analyze a list of cryptocurrency addresses to find their social identities",
        arguments: [
          {
            name: "addresses",
            description: `Comma-separated list of cryptocurrency addresses (${SUPPORTED_CHAINS})`,
            required: true,
          },
        ],
      },
      {
        name: "find_crypto_identity",
        description:
          "Find the cryptocurrency address for a social identity (Twitter handle, Farcaster, email, etc.)",
        arguments: [
          {
            name: "identity",
            description:
              "Identity to look up (Twitter handle, email, Farcaster username, etc.)",
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
            description: `Comma-separated list of cryptocurrency addresses (any size, supports ${SUPPORTED_CHAINS})`,
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
        description: "Analyze cryptocurrency addresses for social identities",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Please analyze these cryptocurrency addresses and find any associated social identities:

${args?.addresses || "No addresses provided"}

For each address:
1. First use batch_check to efficiently check which addresses have data
2. Then use batch_get_data only for addresses that were found
3. Summarize the findings in a clear format`,
            },
          },
        ],
      };

    case "find_crypto_identity":
      return {
        description: "Find crypto address for a social identity",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Please find the cryptocurrency address associated with the identity: ${args?.identity || "unknown"}

1. First use check_identity to verify the identity exists in the database
2. If found, use get_data_for_identity to get the full details
3. Report any associated addresses and all linked identities`,
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
              text: `Please analyze this large list of cryptocurrency addresses with streaming progress:

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
  console.error(`  Bluepages MCP Server v${VERSION}`);
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
  console.error("    ✓ Tools for address/identity lookups");
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
