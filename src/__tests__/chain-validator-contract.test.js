/**
 * Contract test: the chain families the mcp server ADVERTISES
 * (SUPPORTED_CHAINS in ../lib.js) must line up with the families the REAL
 * bluepages-fyi validator (src/input-validator.js) accepts.
 *
 * Two directions, both bugs:
 *   - Over-advertising: the mcp server tells a client it supports a family
 *     the real server rejects. The client wastes a call; server 400s
 *     harmlessly.
 *   - Under-advertising: the mcp server's descriptions omit a family the
 *     real server would happily accept, so a client declines to pass it —
 *     the exact bug this whole change-set exists to fix.
 *
 * Same auto-skip-outside-workspace + CONTRACT_REQUIRED pattern as
 * contract.test.js: hermetic (skipped) by default, hard-required under
 * `pnpm run signoff`. Unlike contract.test.js's response-schemas.js (which
 * imports zod), input-validator.js has zero imports, so this import can't
 * fail on missing sibling node_modules — only on the sibling repo itself
 * being absent.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const VALIDATOR_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../bluepages-fyi/src/input-validator.js",
);

let validatorModule = null;
try {
  validatorModule = await import(pathToFileURL(VALIDATOR_PATH).href);
} catch {
  // bluepages-fyi not checked out next to this repo — contract validation
  // only runs inside the workspace. See contract.test.js for the same
  // pattern applied to the response schemas.
}

const required = !!process.env.CONTRACT_REQUIRED;

if (!validatorModule && required) {
  describe("Chain advertisement vs bluepages-fyi input-validator", () => {
    it("bluepages-fyi input-validator.js is available", () => {
      assert.fail(
        `CONTRACT_REQUIRED is set but input-validator.js could not be imported from ${VALIDATOR_PATH} — ` +
          "check out bluepages-fyi as a sibling of this repo before signing off. A signoff must attest " +
          "that the contract tests ran.",
      );
    });
  });
}

const skip = validatorModule
  ? false
  : required
    ? "reported as a failure above"
    : "bluepages-fyi repo not available — contract check runs only in the workspace";

// One example address per advertised family, in SUPPORTED_CHAINS order.
// input-validator.js is regex-only (no checksums), so these are constructed
// to satisfy each RE_ pattern's shape/length/charset — not real addresses.
// Verified against the live validateAddress() before being hardcoded here.
const EXAMPLE_ADDRESSES = {
  ETH: "0x1234567890abcdef1234567890abcdef12345678",
  BTC: "bc1qqpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9", // bech32 variant
  LTC: "ltc1qqpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9", // bech32 variant
  BCH: "qqpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8g", // cashaddr, no prefix
  SOL: "11111111111111111111111111111111",
  TRON: "TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  DASH: "XAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  DOGE: "DAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  XMR: "4" + "A".repeat(94), // standard variant
  ZEC: "t1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", // transparent variant
  ADA: "addr1qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn5", // Shelley variant
  XLM: "G" + "A".repeat(55),
  ALGO: "A".repeat(58),
  BNB: "bnb1qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9",
  LSK: "12345L",
  SC: "a".repeat(76),
  TON: "EQ" + "A".repeat(46),
  Celestia: "celestia1qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9",
  XRP: "r" + "A".repeat(24), // classic variant
};

// The RE_ const names bluepages-fyi's input-validator.js declares as of this
// writing — 24 patterns covering the 19 families above (BTC, LTC, ADA, XMR,
// and ZEC each have 2 address-shape variants; XMR also has a standalone
// payment-id variant). If this set ever changes, bluepages-fyi added or
// removed a supported address family and the advertisement needs revisiting:
// update SUPPORTED_CHAINS in ../lib.js, every mcp-server.js description that
// uses it, EXAMPLE_ADDRESSES above, and finally this list to the new
// baseline.
const EXPECTED_RE_NAMES = [
  "RE_ADA_BYRON",
  "RE_ADA_SHELLEY",
  "RE_ALGO",
  "RE_BCH_CASHADDR",
  "RE_BNB",
  "RE_BTC_BASE58",
  "RE_BTC_BECH32",
  "RE_CELESTIA",
  "RE_DASH",
  "RE_DOGE",
  "RE_ETH",
  "RE_LSK",
  "RE_LTC_BASE58",
  "RE_LTC_BECH32",
  "RE_SC",
  "RE_SOL",
  "RE_TON",
  "RE_TRON",
  "RE_XLM",
  "RE_XMR",
  "RE_XMR_PAYMENT_ID",
  "RE_XRP",
  "RE_ZEC_TRANSPARENT",
  "RE_ZEC_UNIFIED",
].sort();

describe(
  "Chain advertisement vs bluepages-fyi input-validator",
  { skip },
  () => {
    it("one example address per advertised family is accepted by the real validator (no over-advertising)", () => {
      for (const [family, address] of Object.entries(EXAMPLE_ADDRESSES)) {
        const result = validatorModule.validateAddress(address);
        assert.equal(
          result.valid,
          true,
          `${family} example ${JSON.stringify(address)} was rejected by the real validator: ${result.error}`,
        );
      }
    });

    it("the real validator's RE_ families exactly match what we advertise (no under-advertising)", () => {
      const source = readFileSync(VALIDATOR_PATH, "utf8");
      const actualNames = [...source.matchAll(/^const (RE_[A-Z0-9_]+) =/gm)]
        .map((m) => m[1])
        .sort();

      assert.deepEqual(
        actualNames,
        EXPECTED_RE_NAMES,
        "bluepages-fyi/src/input-validator.js declared a different set of RE_ address " +
          "patterns than this test expects. If a family was ADDED, the mcp server is now " +
          "under-advertising again (the exact bug this test suite exists to catch) — add " +
          "it to SUPPORTED_CHAINS in src/lib.js, update every description that uses it, " +
          "add an example address to EXAMPLE_ADDRESSES above, then update " +
          "EXPECTED_RE_NAMES here to the new baseline. If a family was REMOVED, do the " +
          "reverse (and consider whether over-advertising now applies).",
      );
    });
  },
);
