import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ethers } from "ethers";
import { buildHeaders, createPaymentHeader } from "../lib.js";

// Well-known hardhat test key #0 — never holds real funds
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x1111111111111111111111111111111111111111";

const PAYMENT_REQUEST = {
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
};

const wallet = new ethers.Wallet(TEST_PRIVATE_KEY);

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
      createPaymentHeader(null, PAYMENT_REQUEST),
      /PRIVATE_KEY environment variable required/,
    );
  });

  it("encodes the x402 payment envelope", async () => {
    const payment = decodeHeader(
      await createPaymentHeader(wallet, PAYMENT_REQUEST),
    );

    assert.equal(payment.x402Version, 1);
    assert.equal(payment.scheme, "exact");
    assert.equal(payment.network, "base");
    assert.ok(payment.payload.signature);
    assert.ok(payment.payload.authorization);
  });

  it("fills the authorization from the accepted offer", async () => {
    const { payload } = decodeHeader(
      await createPaymentHeader(wallet, PAYMENT_REQUEST),
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
      await createPaymentHeader(wallet, PAYMENT_REQUEST),
    );
    const after = Math.floor(Date.now() / 1000);

    const validAfter = Number(payload.authorization.validAfter);
    const validBefore = Number(payload.authorization.validBefore);

    assert.ok(validAfter >= before - 600 && validAfter <= after - 600);
    assert.ok(validBefore >= before + 300 && validBefore <= after + 300);
  });

  it("produces an EIP-712 signature that recovers the wallet address", async () => {
    const { payload } = decodeHeader(
      await createPaymentHeader(wallet, PAYMENT_REQUEST),
    );

    const domain = {
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: USDC_BASE,
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

    const recovered = ethers.verifyTypedData(
      domain,
      types,
      payload.authorization,
      payload.signature,
    );
    assert.equal(recovered, TEST_ADDRESS);
  });

  it("uses a fresh nonce per header", async () => {
    const a = decodeHeader(await createPaymentHeader(wallet, PAYMENT_REQUEST));
    const b = decodeHeader(await createPaymentHeader(wallet, PAYMENT_REQUEST));
    assert.notEqual(
      a.payload.authorization.nonce,
      b.payload.authorization.nonce,
    );
  });
});
