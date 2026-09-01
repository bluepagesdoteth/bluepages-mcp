import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ethers } from "ethers";
import {
  buildHeaders,
  createPaymentHeader,
  parsePaymentRequired,
} from "../lib.js";

// Well-known hardhat test key #0 — never holds real funds
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x1111111111111111111111111111111111111111";

const RESOURCE = {
  url: "https://bluepages.fyi/data",
  description: "Address/identity data lookup",
  mimeType: "application/json",
};

const ACCEPTED = {
  scheme: "exact",
  network: "eip155:8453",
  payTo: PAY_TO,
  amount: "50000",
  asset: USDC_BASE,
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
};

const PAYMENT_REQUIRED = {
  x402Version: 2,
  error: "PAYMENT-SIGNATURE header is required",
  resource: RESOURCE,
  accepts: [ACCEPTED],
};

const wallet = new ethers.Wallet(TEST_PRIVATE_KEY);

function fakeResponse(paymentRequired) {
  return {
    headers: {
      get: (name) =>
        name.toLowerCase() === "payment-required"
          ? Buffer.from(JSON.stringify(paymentRequired)).toString("base64")
          : null,
    },
  };
}

function decodeHeader(header) {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

describe("buildHeaders", () => {
  it("returns empty headers without api key or content type", () => {
    assert.deepEqual(buildHeaders(null), {});
    assert.deepEqual(buildHeaders(undefined, null), {});
  });

  it("sets X-API-KEY when an api key is given", () => {
    assert.deepEqual(buildHeaders("bp_test"), { "X-API-KEY": "bp_test" });
  });

  it("sets Content-Type when given", () => {
    assert.deepEqual(buildHeaders(null, "application/json"), {
      "Content-Type": "application/json",
    });
  });

  it("sets both together", () => {
    assert.deepEqual(buildHeaders("bp_test", "application/json"), {
      "X-API-KEY": "bp_test",
      "Content-Type": "application/json",
    });
  });
});

describe("createPaymentHeader", () => {
  it("throws without a wallet", async () => {
    await assert.rejects(
      createPaymentHeader(null, PAYMENT_REQUIRED),
      /Wallet required for x402 payments/,
    );
  });

  it("encodes the x402 v2 payment envelope", async () => {
    const payment = decodeHeader(
      await createPaymentHeader(wallet, PAYMENT_REQUIRED),
    );

    assert.equal(payment.x402Version, 2);
    assert.deepEqual(payment.accepted, ACCEPTED);
    assert.deepEqual(payment.resource, RESOURCE);
    assert.ok(payment.payload.signature);
    assert.ok(payment.payload.authorization);
  });

  it("fills the authorization from the accepted offer", async () => {
    const { payload } = decodeHeader(
      await createPaymentHeader(wallet, PAYMENT_REQUIRED),
    );
    const auth = payload.authorization;

    assert.equal(auth.from, TEST_ADDRESS);
    assert.equal(auth.to, PAY_TO);
    assert.equal(auth.value, "50000");
    assert.match(auth.nonce, /^0x[0-9a-f]{64}$/);
  });

  it("sets the validity window around now", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { payload } = decodeHeader(
      await createPaymentHeader(wallet, PAYMENT_REQUIRED),
    );
    const after = Math.floor(Date.now() / 1000);

    const validAfter = Number(payload.authorization.validAfter);
    const validBefore = Number(payload.authorization.validBefore);

    assert.ok(validAfter >= before - 600 && validAfter <= after - 600);
    assert.ok(validBefore >= before + 300 && validBefore <= after + 300);
  });

  it("produces an EIP-712 signature that recovers the wallet address using the derived domain", async () => {
    const { accepted, payload } = decodeHeader(
      await createPaymentHeader(wallet, PAYMENT_REQUIRED),
    );

    const domain = {
      name: accepted.extra.name,
      version: accepted.extra.version,
      chainId: Number(accepted.network.split(":")[1]),
      verifyingContract: accepted.asset,
    };
    assert.deepEqual(domain, {
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: USDC_BASE,
    });
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

    const recovered = ethers.verifyTypedData(
      domain,
      types,
      payload.authorization,
      payload.signature,
    );
    assert.equal(recovered, TEST_ADDRESS);
  });

  it("uses a fresh nonce per header", async () => {
    const a = decodeHeader(await createPaymentHeader(wallet, PAYMENT_REQUIRED));
    const b = decodeHeader(await createPaymentHeader(wallet, PAYMENT_REQUIRED));
    assert.notEqual(
      a.payload.authorization.nonce,
      b.payload.authorization.nonce,
    );
  });

  it("falls back to accepts[0] when no eip155:8453 entry is present", async () => {
    const otherChainRequired = {
      x402Version: 2,
      resource: RESOURCE,
      accepts: [{ ...ACCEPTED, network: "eip155:1" }],
    };
    const { accepted } = decodeHeader(
      await createPaymentHeader(wallet, otherChainRequired),
    );
    assert.equal(accepted.network, "eip155:1");
  });
});

describe("parsePaymentRequired", () => {
  it("decodes the base64 PAYMENT-REQUIRED header", () => {
    const response = fakeResponse(PAYMENT_REQUIRED);
    assert.deepEqual(parsePaymentRequired(response, null), PAYMENT_REQUIRED);
  });

  it("falls back to the JSON body when x402Version === 2 and no header is present", () => {
    const response = { headers: { get: () => null } };
    assert.deepEqual(
      parsePaymentRequired(response, PAYMENT_REQUIRED),
      PAYMENT_REQUIRED,
    );
  });

  it("throws when neither header nor a v2 body is present", () => {
    const response = { headers: { get: () => null } };
    assert.throws(
      () => parsePaymentRequired(response, { x402Version: 1 }),
      /Invalid payment required response/,
    );
    assert.throws(
      () => parsePaymentRequired(response, null),
      /Invalid payment required response/,
    );
  });
});
