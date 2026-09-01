/**
 * Pure formatting and batch-processing logic for the Bluepages MCP server.
 *
 * Everything here is deterministic and side-effect free: network access and
 * server state are injected by the caller (post, wallet, apiKey), so these
 * functions can be unit-tested without starting the server.
 */

import { ethers } from "ethers";

/**
 * Canonical enumeration of address families the Bluepages API accepts,
 * mirrored from bluepages-fyi's src/input-validator.js (the server's own
 * validation order). Single-sourced here so every tool/resource/prompt
 * description in mcp-server.js advertises the same chains — the mcp server
 * does no client-side address validation, so an MCP client only learns what
 * it can pass by reading these descriptions. Update this list (and the
 * matching reverse-direction fixture in the contract test) whenever
 * bluepages-fyi adds or removes a supported address family.
 */
export const SUPPORTED_CHAINS =
  "ETH, BTC, LTC, BCH, SOL, TRON, DASH, DOGE, XMR, ZEC, ADA, XLM, ALGO, BNB, LSK, SC, TON, Celestia, XRP";

/** Appended to per-tool descriptions that accept addresses. */
export const CASE_INSENSITIVE_NOTE =
  "Lookups are case-insensitive; pass addresses exactly as given.";

/**
 * Create x402 v2 payment header for USDC authorization.
 *
 * `paymentRequired` is the decoded PaymentRequired object (see
 * `parsePaymentRequired`): `{ x402Version: 2, resource, accepts: [...] }`.
 */
export async function createPaymentHeader(wallet, paymentRequired) {
  if (!wallet) {
    throw new Error("Wallet required for x402 payments");
  }

  const accepted =
    paymentRequired.accepts.find((r) => r.network === "eip155:8453") ??
    paymentRequired.accepts[0];
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const validAfter = Math.floor(Date.now() / 1000) - 600;
  const validBefore =
    Math.floor(Date.now() / 1000) + accepted.maxTimeoutSeconds;

  const authorization = {
    from: wallet.address,
    to: accepted.payTo,
    value: accepted.amount,
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce,
  };

  const domain = {
    name: accepted.extra?.name ?? "USD Coin",
    version: accepted.extra?.version ?? "2",
    chainId: Number(accepted.network.split(":")[1]),
    verifyingContract: accepted.asset,
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
    x402Version: 2,
    resource: paymentRequired.resource,
    accepted,
    payload: { signature, authorization },
  };

  return Buffer.from(JSON.stringify(payment)).toString("base64");
}

/**
 * Parse a 402 response into the decoded PaymentRequired object.
 *
 * The authoritative v2 channel is the `PAYMENT-REQUIRED` response header
 * (base64 JSON); `response.headers.get` is case-insensitive per the Fetch
 * spec, so the lowercase name here matches whatever case the server sent.
 * Falls back to the already-parsed JSON body only when it is itself a v2
 * PaymentRequired object (bluepages-fyi mirrors the header into the body).
 */
export function parsePaymentRequired(response, body) {
  const header = response.headers.get("payment-required");
  if (header) {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  }
  if (body?.x402Version === 2) {
    return body;
  }
  throw new Error("Invalid payment required response");
}

/**
 * Build headers based on authentication mode
 */
export function buildHeaders(apiKey, contentType = null) {
  const headers = {};
  if (apiKey) {
    headers["X-API-KEY"] = apiKey;
  }
  if (contentType) {
    headers["Content-Type"] = contentType;
  }
  return headers;
}

/**
 * One-line summary of a sanctions entry: source, entity, programs, status
 */
export function describeSanction(s) {
  const programs = s.programs?.length ? ` [${s.programs.join(", ")}]` : "";
  const status = s.active ? "active" : `removed ${s.removedAt}`;
  return `${s.source}: ${s.entity}${programs} — ${status} (added ${s.addedAt})`;
}

/**
 * Format a result for human-readable output
 */
export function formatResult(result, query) {
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

      if (match.labels && match.labels.length > 0) {
        output.push("  Labels:");
        for (const label of match.labels) {
          let line = `    ${label.type}: ${label.name}`;
          if (label.detail) line += ` (${label.detail})`;
          line += ` [${label.source}]`;
          output.push(line);
        }
      }

      if (match.sanctions && match.sanctions.length > 0) {
        output.push("  ⚠ Sanctions:");
        for (const s of match.sanctions) {
          output.push(`    ${describeSanction(s)}`);
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

  if (result.identities && result.identities.length > 0) {
    for (const identity of result.identities) {
      output.push(`${identity.type}: ${identity.value} (${identity.source})`);
    }
  }

  if (result.labels && result.labels.length > 0) {
    output.push("");
    output.push("Labels:");
    for (const label of result.labels) {
      let line = `  ${label.type}: ${label.name}`;
      if (label.detail) line += ` (${label.detail})`;
      line += ` [${label.source}]`;
      output.push(line);
    }
  }

  if (result.sanctions && result.sanctions.length > 0) {
    output.push("");
    output.push("⚠ Sanctions:");
    for (const s of result.sanctions) {
      output.push(`  ${describeSanction(s)}`);
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

  if (result.twitterSearch?.available) {
    output.push(
      `\nTip: Use search_tweets to find Twitter/X posts mentioning this address ($0.05)`,
    );
  }

  return output.join("\n") || JSON.stringify(result, null, 2);
}

export function formatTweetResults(result, address) {
  const tweets = result.tweets;

  if (!tweets || tweets.count === 0 || !tweets.results?.length) {
    return `No tweets found mentioning ${address}`;
  }

  const output = [`Found ${tweets.count} tweet(s) mentioning ${address}:\n`];

  for (const t of tweets.results) {
    const date = t.created_at
      ? new Date(t.created_at).toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : "unknown date";
    output.push(`@${t.username || "unknown"} (${date})`);
    if (t.text) {
      output.push(`  ${t.text.replace(/\n/g, "\n  ")}`);
    }

    const stats = [];
    if (t.reply_count) stats.push(`${t.reply_count} replies`);
    if (t.retweet_count) stats.push(`${t.retweet_count} reposts`);
    if (t.like_count) stats.push(`${t.like_count} likes`);
    if (t.view_count) stats.push(`${t.view_count} views`);
    if (stats.length > 0) {
      output.push(`  [${stats.join(", ")}]`);
    }
    if (t.url) {
      output.push(`  ${t.url}`);
    }
    output.push("");
  }

  return output.join("\n");
}

/**
 * Format a /batch/check response. `total` is the number of items requested.
 */
export function formatBatchCheckResult(result, total) {
  let foundAddresses = 0;
  let foundIdentities = 0;

  if (result.results?.addresses) {
    foundAddresses = Object.values(result.results.addresses).filter(
      (a) => a.exists,
    ).length;
  }
  if (result.results?.identities) {
    foundIdentities = Object.values(result.results.identities).filter(
      (i) => i.exists,
    ).length;
  }

  const found = foundAddresses + foundIdentities;

  // Entry is { exists, types[] } or { error } for invalid input
  const describeCheckEntry = (info) => {
    if (info.error) return `⚠ ${info.error}`;
    return info.exists
      ? `✓ found (${info.types?.join(", ") || "no types"})`
      : "✗ not found";
  };

  let details = [];
  for (const [addr, info] of Object.entries(result.results?.addresses || {})) {
    details.push(`${addr}: ${describeCheckEntry(info)}`);
  }
  for (const [handle, info] of Object.entries(
    result.results?.identities || {},
  )) {
    details.push(`${handle}: ${describeCheckEntry(info)}`);
  }

  return `Batch check complete: ${found}/${total} items found in database\n\n${details.join("\n")}`;
}

/**
 * Format a /batch/data response (addresses and identity matches).
 */
export function formatBatchDataResult(result) {
  let lines = ["Batch data retrieval complete:\n"];

  if (result.results?.addresses) {
    for (const [addr, info] of Object.entries(result.results.addresses)) {
      if (info.error) {
        lines.push(`${addr}: ⚠ ${info.error}`);
        lines.push("");
        continue;
      }
      if (info.found !== true) continue;
      lines.push(`${addr}`);
      for (const identity of info.identities || []) {
        lines.push(
          `  ${identity.type}: ${identity.value} (${identity.source})`,
        );
      }
      if (info.labels && info.labels.length > 0) {
        lines.push("  Labels:");
        for (const label of info.labels) {
          let line = `    ${label.type}: ${label.name}`;
          if (label.detail) line += ` (${label.detail})`;
          line += ` [${label.source}]`;
          lines.push(line);
        }
      }
      if (info.sanctions && info.sanctions.length > 0) {
        lines.push("  ⚠ Sanctions:");
        for (const s of info.sanctions) {
          lines.push(`    ${describeSanction(s)}`);
        }
      }
      if (info.cluster) {
        lines.push(
          `  Cluster: ${info.cluster.id} (${info.cluster.totalAddresses} addresses)`,
        );
      }
      lines.push("");
    }
  }

  if (result.results?.identities) {
    for (const [handle, info] of Object.entries(result.results.identities)) {
      if (info.found !== true) continue;
      lines.push(`${handle}: ${info.totalMatches} match(es)`);
      for (const match of info.results || []) {
        const flag = match.sanctions?.some((s) => s.active)
          ? " ⚠ SANCTIONED"
          : "";
        lines.push(
          `  ${match.address} (${match.matchType} = ${match.matchedValue})${flag}`,
        );
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * Final summary for batch_check_streaming.
 */
export function formatStreamingCheckSummary(results) {
  const found = results.filter((r) => r.found).length;
  const notFound = results.filter((r) => !r.found).length;

  return `Batch check complete!\n\nFound: ${found}\nNot found: ${notFound}\n\nFound addresses:\n${
    results
      .filter((r) => r.found)
      .map((r) => `  ✓ ${r.address ?? r.identity}`)
      .join("\n") || "  (none)"
  }`;
}

/**
 * Final summary for batch_get_data_streaming. Items come from
 * processBatchWithStreaming with parsed fields.
 */
export function formatStreamingDataSummary(foundItems, total) {
  let output = `Data retrieval complete!\n\nFound: ${foundItems.length}/${total}\n\n`;

  if (foundItems.length > 0) {
    output += "Results:\n";
    for (const item of foundItems) {
      output += `\n${item.address ?? item.identity}\n`;

      for (const identity of item.identities || []) {
        output += `  ${identity.type}: ${identity.value} (${identity.source})\n`;
      }
      if (item.labels && item.labels.length > 0) {
        output += "  Labels:\n";
        for (const label of item.labels) {
          let line = `    ${label.type}: ${label.name}`;
          if (label.detail) line += ` (${label.detail})`;
          line += ` [${label.source}]`;
          output += line + "\n";
        }
      }
      if (item.sanctions && item.sanctions.length > 0) {
        output += "  ⚠ Sanctions:\n";
        for (const s of item.sanctions) {
          output += `    ${describeSanction(s)}\n`;
        }
      }
      if (item.cluster) {
        output += `  Cluster: ${item.cluster.id} (${item.cluster.totalAddresses} addresses)\n`;
      }
    }
  }

  return output;
}

/**
 * Process batch items with streaming progress updates
 * Handles both /batch/check ({ exists, types[] }) and /batch/data ({ found, identities[], labels[], sanctions[], cluster }) formats
 *
 * `post(endpoint, body)` performs the authenticated API call.
 */
export async function processBatchWithStreaming(
  items,
  type,
  endpoint,
  progressCallback,
  post,
) {
  const results = [];
  const batchSize = 50;
  const isDataEndpoint = endpoint.includes("/data");
  const noun = type === "address" ? "addresses" : "identities";

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, Math.min(i + batchSize, items.length));
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(items.length / batchSize);

    // Send progress notification
    await progressCallback({
      type: "progress",
      message: `Processing batch ${batchNum}/${totalBatches} (${batch.length} ${noun})...`,
      current: i + batch.length,
      total: items.length,
      percentage: Math.round(((i + batch.length) / items.length) * 100),
    });

    // Make the API call
    const body =
      type === "address" ? { addresses: batch } : { identities: batch };
    const result = await post(endpoint, body);

    // Extract results - response is an object keyed by address/identity
    const key = type === "address" ? "addresses" : "identities";
    if (result.results?.[key]) {
      // Convert object format to array format
      for (const [itemKey, info] of Object.entries(result.results[key])) {
        let itemResult;

        if (isDataEndpoint && type === "address") {
          // /batch/data address entry: { found, identities[], labels[], sanctions[], cluster }
          itemResult = {
            address: itemKey,
            found: info.found === true,
            identities: info.identities || [],
            labels: info.labels || [],
            sanctions: info.sanctions || [],
            cluster: info.cluster || null,
          };
        } else if (isDataEndpoint) {
          // /batch/data identity entry: { found, totalMatches, results[] }
          itemResult = {
            identity: itemKey,
            found: info.found === true,
            totalMatches: info.totalMatches || 0,
            matches: info.results || [],
          };
        } else {
          // /batch/check entry: { exists, types[] } or { error }
          itemResult = {
            [type === "address" ? "address" : "identity"]: itemKey,
            found: info.exists === true,
            types: info.types || [],
          };
        }

        results.push(itemResult);

        // Send individual results as they come in
        if (itemResult.found) {
          let message;
          if (isDataEndpoint) {
            const parts = [];
            const ids = info.identities || [];
            if (ids.length) {
              const more = ids.length > 1 ? ` +${ids.length - 1} more` : "";
              parts.push(`${ids[0].type}:${ids[0].value}${more}`);
            } else if (info.totalMatches) {
              parts.push(`${info.totalMatches} match(es)`);
            }
            if (info.labels?.length)
              parts.push(`${info.labels.length} label(s)`);
            if (info.sanctions?.length)
              parts.push(`⚠ ${info.sanctions.length} sanction(s)`);
            message = `✓ Found: ${itemKey} → ${parts.join(", ") || "data available"}`;
          } else {
            message = `✓ Found: ${itemKey} (${(info.types || []).join(", ") || "no types"})`;
          }

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
