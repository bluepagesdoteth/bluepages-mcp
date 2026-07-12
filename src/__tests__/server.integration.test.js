import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { ethers } from "ethers";
import {
  DATA_ADDRESS_RESPONSE,
  DATA_IDENTITY_RESPONSE,
  ERROR_ADDR,
  FOUND_ADDR,
  FOUND_IDENTITY,
  MISSING_ADDR,
  SEARCH_TWEETS_RESPONSE,
  batchCheckResponse,
  batchDataResponse,
  checkResponse,
} from "./fixtures.js";

const SERVER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "mcp-server.js",
);

// Well-known hardhat test key #0 — never holds real funds
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_WALLET_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x1111111111111111111111111111111111111111";

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
  });
}

/**
 * Minimal fake Bluepages API. With `requirePayment`, /data demands an
 * X-PAYMENT header (402 first, then accepts the signed retry) like the
 * real x402 flow.
 */
async function startFakeApi({ requirePayment = false } = {}) {
  const state = { requests: [], payments: [], credits: 5000 };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    state.requests.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
    });

    const json = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (requirePayment && url.pathname === "/data") {
      const paymentHeader = req.headers["x-payment"];
      if (!paymentHeader) {
        return json(402, {
          x402Version: 1,
          accepts: [
            {
              scheme: "exact",
              network: "base",
              payTo: PAY_TO,
              maxAmountRequired: "50000",
              maxTimeoutSeconds: 300,
              asset: USDC_BASE,
            },
          ],
        });
      }
      state.payments.push(
        JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8")),
      );
    }

    switch (`${req.method} ${url.pathname}`) {
      case "GET /api/me":
        return json(200, { credits: state.credits, points: 123 });

      case "GET /api/nonce":
        return json(200, { nonce: "testnonce123" });

      case "POST /api/auth": {
        const { message, signature } = await readBody(req);
        state.auth = { message, signature };
        return json(200, {
          isNew: true,
          user: {
            apiKey: "bp_test_key",
            address: TEST_WALLET_ADDRESS,
            credits: 0,
          },
        });
      }

      case "GET /check": {
        const addr = url.searchParams.get("address");
        const identity = url.searchParams.get("identity");
        const exists = addr === FOUND_ADDR || identity === FOUND_IDENTITY;
        return json(
          200,
          checkResponse(
            addr ? "address" : "identity",
            addr || identity,
            exists,
          ),
        );
      }

      case "GET /data": {
        const addr = url.searchParams.get("address");
        if (url.searchParams.get("identity") === FOUND_IDENTITY) {
          return json(200, DATA_IDENTITY_RESPONSE);
        }
        if (addr === FOUND_ADDR) return json(200, DATA_ADDRESS_RESPONSE);
        if (addr === ERROR_ADDR)
          return json(500, { error: "database exploded" });
        return json(200, { found: false });
      }

      case "GET /search/tweets":
        return json(200, SEARCH_TWEETS_RESPONSE);

      case "POST /batch/check": {
        const body = await readBody(req);
        return json(
          200,
          batchCheckResponse(body.addresses || [], body.identities || []),
        );
      }

      case "POST /batch/data": {
        const body = await readBody(req);
        return json(
          200,
          batchDataResponse(body.addresses || [], body.identities || []),
        );
      }

      case "POST /api/credits/purchase": {
        await readBody(req);
        const paymentHeader = req.headers["x-payment"];
        if (!paymentHeader) {
          return json(402, {
            x402Version: 1,
            accepts: [
              {
                scheme: "exact",
                network: "base",
                payTo: PAY_TO,
                maxAmountRequired: "5000000",
                maxTimeoutSeconds: 300,
                asset: USDC_BASE,
              },
            ],
          });
        }
        state.payments.push(
          JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8")),
        );
        return json(200, {
          creditsAdded: 5000,
          newCredits: 5000,
          transactionHash: "0xtx123",
        });
      }

      default:
        return json(404, { error: `Unhandled route: ${url.pathname}` });
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise((resolve) => server.close(resolve));
  state.server = server;
  return state;
}

async function startClient(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function textOf(result) {
  return result.content[0].text;
}

async function waitFor(cond, ms = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms)
      throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("mcp server (api-key mode)", () => {
  let api;
  let client;
  const notifications = [];

  before(async () => {
    api = await startFakeApi();
    client = await startClient({
      BLUEPAGES_API_URL: api.url,
      BLUEPAGES_API_KEY: "bp_test_key",
    });
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      notifications.push(n.params);
    });
  });

  beforeEach(() => {
    notifications.length = 0;
  });

  after(async () => {
    await client.close();
    await api.close();
  });

  it("lists 11 tools including credit tools, excluding wallet tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.equal(tools.length, 11);
    assert.ok(names.includes("check_credits"));
    assert.ok(names.includes("set_credit_alert"));
    assert.ok(!names.includes("get_api_key"));
    assert.ok(!names.includes("purchase_credits"));
  });

  it("sends the API key on requests", async () => {
    await client.callTool({
      name: "check_address",
      arguments: { address: FOUND_ADDR },
    });
    const checkReq = api.requests.findLast((r) => r.path === "/check");
    assert.equal(checkReq.headers["x-api-key"], "bp_test_key");
  });

  it("check_address reports found and not-found", async () => {
    const found = await client.callTool({
      name: "check_address",
      arguments: { address: FOUND_ADDR },
    });
    assert.match(textOf(found), /✓ Address .* found in database/);
    assert.match(textOf(found), /types: twitter/);

    const missing = await client.callTool({
      name: "check_address",
      arguments: { address: MISSING_ADDR },
    });
    assert.match(textOf(missing), /✗ Address .* not found/);
  });

  it("get_data_for_address renders identities, labels, sanctions, cluster", async () => {
    const result = await client.callTool({
      name: "get_data_for_address",
      arguments: { address: FOUND_ADDR },
    });
    const text = textOf(result);
    assert.match(text, /twitter: vitalik \(ens_text_record\)/);
    assert.match(text, /cex: Binance \(hot wallet\) \[hildobby\]/);
    assert.match(text, /⚠ Sanctions:/);
    assert.match(text, /Lazarus Group \[DPRK3\] — active \(added 2022-04-14\)/);
    assert.match(text, /Cluster: cl_42/);
    assert.match(text, /Transitive: yes/);
  });

  it("get_data_for_identity renders multi-match results", async () => {
    const result = await client.callTool({
      name: "get_data_for_identity",
      arguments: { identity: "vitalik" },
    });
    const text = textOf(result);
    assert.match(text, /Found 2 match\(es\) for "vitalik"/);
    assert.match(text, /Address: 0xaaa/);
    assert.match(text, /Address: 0xbbb/);
  });

  it("batch_check summarizes mixed results", async () => {
    const result = await client.callTool({
      name: "batch_check",
      arguments: {
        addresses: [FOUND_ADDR, MISSING_ADDR],
        identities: ["nobody"],
      },
    });
    const text = textOf(result);
    assert.match(text, /Batch check complete: 1\/3 items found/);
    assert.match(text, /✓ found \(twitter\)/);
    assert.match(text, /nobody: ✗ not found/);
  });

  it("batch_check works with addresses only", async () => {
    const result = await client.callTool({
      name: "batch_check",
      arguments: { addresses: [FOUND_ADDR, MISSING_ADDR] },
    });
    const text = textOf(result);
    assert.match(text, /Batch check complete: 1\/2 items found/);
    assert.match(text, new RegExp(`${FOUND_ADDR}: ✓ found`));
  });

  it("batch_check works with identities only", async () => {
    const result = await client.callTool({
      name: "batch_check",
      arguments: { identities: ["vitalik", "nobody"] },
    });
    const text = textOf(result);
    assert.match(text, /Batch check complete: 1\/2 items found/);
    assert.match(text, /vitalik: ✓ found \(twitter\)/);
  });

  it("batch_check with no input is an error", async () => {
    const result = await client.callTool({
      name: "batch_check",
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /At least one address or identity required/);
  });

  it("batch_get_data renders found entries only", async () => {
    const result = await client.callTool({
      name: "batch_get_data",
      arguments: { addresses: [FOUND_ADDR, MISSING_ADDR] },
    });
    const text = textOf(result);
    assert.match(text, /twitter: vitalik/);
    assert.doesNotMatch(text, new RegExp(MISSING_ADDR));
  });

  it("batch_get_data renders identity matches", async () => {
    const result = await client.callTool({
      name: "batch_get_data",
      arguments: { identities: ["vitalik", "nobody"] },
    });
    const text = textOf(result);
    assert.match(text, /vitalik: 2 match\(es\)/);
    assert.match(text, /0xaaa \(twitter = vitalik\)/);
    assert.doesNotMatch(text, /nobody/);
    assert.doesNotMatch(text, /SANCTIONED/);
  });

  // NOTE: the server sends its human-readable `message` as a non-spec param
  // on notifications/message; spec-compliant clients (incl. the SDK client)
  // strip it, so only `level`, `logger`, and `data` are observable here. The
  // text survives only where processBatchWithStreaming duplicates it in `data`.
  it("batch_check_streaming sends progress notifications and a summary", async () => {
    const result = await client.callTool({
      name: "batch_check_streaming",
      arguments: { addresses: [FOUND_ADDR, MISSING_ADDR] },
    });

    const text = textOf(result);
    assert.match(text, /Found: 1\nNot found: 1/);
    assert.match(text, new RegExp(`✓ ${FOUND_ADDR}`));

    // start → progress → per-item result → completion
    await waitFor(() => notifications.length >= 4);
    assert.equal(notifications.length, 4);
    assert.deepEqual(notifications[0].data, { total: 2 });
    assert.match(
      notifications[1].data.message,
      /Processing batch 1\/1 \(2 addresses\)/,
    );
    assert.equal(
      notifications[2].data.message,
      `✓ Found: ${FOUND_ADDR} (twitter)`,
    );
    assert.deepEqual(notifications[3].data, {
      found: 1,
      notFound: 1,
      total: 2,
    });
  });

  it("batch_get_data_streaming streams results and renders full data", async () => {
    const result = await client.callTool({
      name: "batch_get_data_streaming",
      arguments: { addresses: [FOUND_ADDR, MISSING_ADDR] },
    });

    const text = textOf(result);
    assert.match(text, /Found: 1\/2/);
    assert.match(text, /twitter: vitalik \(ens_text_record\)/);
    assert.match(text, /⚠ Sanctions:/);
    assert.match(text, /Cluster: cl_42/);

    await waitFor(() => notifications.length >= 4);
    assert.equal(notifications.length, 4);
    assert.match(
      notifications[2].data.message,
      new RegExp(`✓ Found: ${FOUND_ADDR} → twitter:vitalik \\+1 more`),
    );
    // The streamed item carries the parsed payload, sanctions included
    assert.equal(notifications[2].data.item.sanctions.length, 1);
    assert.deepEqual(notifications[3].data, { found: 1, total: 2 });
  });

  it("set_credit_alert updates the warning threshold", async () => {
    const result = await client.callTool({
      name: "set_credit_alert",
      arguments: { threshold: 500 },
    });
    assert.match(textOf(result), /✓ Credit alert threshold set to 500 credits/);
  });

  it("search_tweets formats tweet results", async () => {
    const result = await client.callTool({
      name: "search_tweets",
      arguments: { address: FOUND_ADDR },
    });
    const text = textOf(result);
    assert.match(text, /@zachxbt \(Mar 15, 2025\)/);
    assert.match(text, /scam alert/);
    assert.match(text, /\[5 likes\]/);
  });

  it("check_credits reports the balance", async () => {
    const result = await client.callTool({
      name: "check_credits",
      arguments: {},
    });
    assert.match(textOf(result), /Credits remaining: 5,000/);
    assert.match(textOf(result), /Points earned: 123/);
  });

  it("propagates API errors as isError results", async () => {
    const result = await client.callTool({
      name: "get_data_for_address",
      arguments: { address: ERROR_ADDR },
    });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "Error: database exploded");
  });

  it("rejects unknown tools", async () => {
    const result = await client.callTool({
      name: "does_not_exist",
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Unknown tool/);
  });

  it("lists and reads resources", async () => {
    const { resources } = await client.listResources();
    assert.equal(resources.length, 3);

    const info = await client.readResource({ uri: "bluepages://info" });
    assert.match(info.contents[0].text, /Authentication Mode: API Key/);
    assert.doesNotMatch(info.contents[0].text, /NOT CONFIGURED/);

    const pricing = await client.readResource({ uri: "bluepages://pricing" });
    assert.match(pricing.contents[0].text, /batch_check: 40 credits/);

    const status = await client.readResource({ uri: "bluepages://status" });
    assert.match(status.contents[0].text, /Credits: 5,000/);
  });

  it("lists and renders prompts", async () => {
    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name).sort(), [
      "analyze_addresses",
      "analyze_large_list",
      "find_crypto_identity",
    ]);

    const prompt = await client.getPrompt({
      name: "analyze_addresses",
      arguments: { addresses: "0xaaa, 0xbbb" },
    });
    assert.match(prompt.messages[0].content.text, /0xaaa, 0xbbb/);
    assert.match(prompt.messages[0].content.text, /batch_check/);
  });

  it("streaming tools are address-only by design", async () => {
    const { tools } = await client.listTools();
    for (const name of ["batch_check_streaming", "batch_get_data_streaming"]) {
      const tool = tools.find((t) => t.name === name);
      assert.deepEqual(Object.keys(tool.inputSchema.properties), ["addresses"]);
      assert.deepEqual(tool.inputSchema.required, ["addresses"]);
    }
  });

  // Warnings fire only on downward threshold crossings, tracked against the
  // last known balance (seeded by the startup /api/me fetch).
  it("emits credit warnings on threshold crossings only", async () => {
    // drop below the low threshold (1000) → warning
    api.credits = 800;
    await client.callTool({ name: "check_credits", arguments: {} });
    await waitFor(() => notifications.length >= 1);
    assert.equal(notifications[0].level, "warning");
    assert.deepEqual(notifications[0].data, { credits: 800, threshold: 1000 });

    // a further drop below the same threshold → no repeat warning
    notifications.length = 0;
    api.credits = 700;
    await client.callTool({ name: "check_credits", arguments: {} });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(notifications.length, 0);

    // crossing the critical threshold (100) → error
    api.credits = 50;
    await client.callTool({ name: "check_credits", arguments: {} });
    await waitFor(() => notifications.length >= 1);
    assert.equal(notifications[0].level, "error");
    assert.deepEqual(notifications[0].data, { credits: 50, threshold: 100 });

    // recover, then plunge past BOTH thresholds → critical only, not low
    api.credits = 5000;
    await client.callTool({ name: "check_credits", arguments: {} });
    notifications.length = 0;
    api.credits = 50;
    await client.callTool({ name: "check_credits", arguments: {} });
    await waitFor(() => notifications.length >= 1);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, "error");

    // restore for any later tests
    api.credits = 5000;
    await client.callTool({ name: "check_credits", arguments: {} });
  });
});

describe("mcp server (unconfigured mode)", () => {
  let client;

  before(async () => {
    // Point at a closed port: nothing should ever be fetched in this mode
    client = await startClient({ BLUEPAGES_API_URL: "http://127.0.0.1:9" });
  });

  after(async () => {
    await client.close();
  });

  it("lists only the 9 base tools", async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 9);
    const names = tools.map((t) => t.name);
    assert.ok(!names.includes("check_credits"));
    assert.ok(!names.includes("get_api_key"));
  });

  it("blocks tool calls with a configuration hint", async () => {
    const result = await client.callTool({
      name: "check_address",
      arguments: { address: FOUND_ADDR },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Bluepages is not configured/);
    assert.match(textOf(result), /BLUEPAGES_API_KEY/);
  });

  it("marks the info resource as not configured", async () => {
    const info = await client.readResource({ uri: "bluepages://info" });
    assert.match(info.contents[0].text, /NOT CONFIGURED/);
  });
});

describe("mcp server (x402 mode)", () => {
  let api;
  let client;

  before(async () => {
    api = await startFakeApi({ requirePayment: true });
    client = await startClient({
      BLUEPAGES_API_URL: api.url,
      PRIVATE_KEY: TEST_PRIVATE_KEY,
    });
  });

  after(async () => {
    await client.close();
    await api.close();
  });

  it("lists 11 tools including wallet tools, excluding credit tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.equal(tools.length, 11);
    assert.ok(names.includes("get_api_key"));
    assert.ok(names.includes("purchase_credits"));
    assert.ok(!names.includes("check_credits"));
  });

  it("serves non-payment routes without a 402 round-trip", async () => {
    const paymentsBefore = api.payments.length;
    const result = await client.callTool({
      name: "check_address",
      arguments: { address: FOUND_ADDR },
    });
    assert.match(textOf(result), /✓ Address .* found in database/);

    // First request succeeded directly: no payment signed, no header sent
    assert.equal(api.payments.length, paymentsBefore);
    const checkReq = api.requests.findLast((r) => r.path === "/check");
    assert.equal(checkReq.headers["x-payment"], undefined);
  });

  it("completes the 402 → sign → retry payment flow", async () => {
    const result = await client.callTool({
      name: "get_data_for_address",
      arguments: { address: FOUND_ADDR },
    });
    assert.match(textOf(result), /twitter: vitalik/);

    // The fake API saw exactly one signed payment for this call
    assert.equal(api.payments.length, 1);
    const payment = api.payments[0];
    assert.equal(payment.scheme, "exact");
    assert.equal(payment.payload.authorization.to, PAY_TO);
    assert.equal(payment.payload.authorization.value, "50000");

    // Signature recovers the server's wallet
    const recovered = ethers.verifyTypedData(
      {
        name: "USD Coin",
        version: "2",
        chainId: 8453,
        verifyingContract: USDC_BASE,
      },
      {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      payment.payload.authorization,
      payment.payload.signature,
    );
    assert.equal(recovered, TEST_WALLET_ADDRESS);
  });

  it("purchase_credits completes the 402 purchase flow", async () => {
    const paymentsBefore = api.payments.length;
    const result = await client.callTool({
      name: "purchase_credits",
      arguments: { package: "starter" },
    });

    const text = textOf(result);
    assert.match(text, /Successfully purchased 5,000 credits/);
    assert.match(text, /New balance: 5,000 credits/);
    assert.match(text, /Transaction: 0xtx123/);

    // A signed payment for the starter package price reached the API
    const payment = api.payments[api.payments.length - 1];
    assert.equal(api.payments.length, paymentsBefore + 1);
    assert.equal(payment.payload.authorization.value, "5000000");
    assert.equal(
      ethers.verifyTypedData(
        {
          name: "USD Coin",
          version: "2",
          chainId: 8453,
          verifyingContract: USDC_BASE,
        },
        {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        payment.payload.authorization,
        payment.payload.signature,
      ),
      TEST_WALLET_ADDRESS,
    );
  });

  it("get_api_key signs a SIWE message and returns the key", async () => {
    const result = await client.callTool({
      name: "get_api_key",
      arguments: {},
    });
    const text = textOf(result);
    assert.match(text, /Account created!/);
    assert.match(text, /API Key: bp_test_key/);

    // The signed SIWE message carries the nonce and verifies offline
    assert.match(api.auth.message, /Nonce: testnonce123/);
    assert.match(api.auth.message, new RegExp(TEST_WALLET_ADDRESS));
    const recovered = ethers.verifyMessage(
      api.auth.message,
      api.auth.signature,
    );
    assert.equal(recovered, TEST_WALLET_ADDRESS);
  });
});
