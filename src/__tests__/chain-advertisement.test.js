/**
 * Advertisement-consistency tests for SUPPORTED_CHAINS (src/lib.js).
 *
 * The mcp server does no client-side address validation by design — an mcp
 * client (the calling LLM) only learns which address families it may pass by
 * reading tool/resource/prompt descriptions. If those descriptions under-
 * advertise (e.g. list only 8 of the 27 families the server actually
 * accepts), the client will decline to pass address formats the server would
 * happily accept — a de-facto client-side rejection bug.
 *
 * These tests pin the single source of truth (SUPPORTED_CHAINS) and its
 * text appearing where it should — with a hardcoded independent copy so the
 * check doesn't move in lockstep with an accidental edit to the const
 * itself. See server.integration.test.js for the live-server checks against
 * the actually-running tools/resources/prompts (spawned via stdio); the raw
 * source-file check here is a second, independent line of defense against a
 * hand-edit that hardcodes a stale enumeration anywhere in the file,
 * live-tested or not.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED_CHAINS } from "../lib.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.join(HERE, "..", "mcp-server.js");
const README_PATH = path.join(HERE, "..", "..", "README.md");

// The old, stale 8-chain enumeration this whole change-set replaces.
// Hardcoded independently of SUPPORTED_CHAINS so a test failure here can
// only mean "the stale string came back", not "the const changed".
const STALE_CHAINS = "ETH, BTC, SOL, TRON, XMR, TON, Celestia, XRP";

describe("SUPPORTED_CHAINS (single source of the advertised chain list)", () => {
  it("equals the canonical 27-family enumeration", () => {
    // Hardcoded independently of src/lib.js's export: every other test in
    // this suite imports/derives from the same const and would move in
    // lockstep with an edit to it. This is the one anchor that wouldn't.
    assert.equal(
      SUPPORTED_CHAINS,
      "ETH, BTC, LTC, BCH, SOL, TRON, DASH, DOGE, XMR, ZEC, ADA, XLM, ALGO, BNB, LSK, SC, TON, Celestia, XRP, APT/SUI, DOT, ATOM, ZIL, EGLD, INJ, NEAR, EOS",
    );
  });

  it("mcp-server.js source contains zero hardcoded copies of the stale enumeration", () => {
    const source = readFileSync(MCP_SERVER_PATH, "utf8");
    assert.ok(
      !source.includes(STALE_CHAINS),
      "mcp-server.js still contains the stale 8-chain enumeration somewhere " +
        "— it should reference SUPPORTED_CHAINS from lib.js instead",
    );
  });

  it("README.md advertises the canonical list and not the stale one", () => {
    const readme = readFileSync(README_PATH, "utf8");
    assert.ok(
      readme.includes(SUPPORTED_CHAINS),
      "README.md does not contain the canonical chain list verbatim",
    );
    assert.ok(
      !readme.includes(STALE_CHAINS),
      "README.md still contains the stale 8-chain enumeration",
    );
  });
});
