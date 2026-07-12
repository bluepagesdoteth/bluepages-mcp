import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { processBatchWithStreaming } from "../lib.js";

/**
 * Build a fake `post(endpoint, body)` that records calls and answers each
 * item with the entry produced by `makeEntry(item)`.
 */
function fakePost(type, makeEntry) {
  const calls = [];
  const key = type === "address" ? "addresses" : "identities";
  const post = async (endpoint, body) => {
    calls.push({ endpoint, body });
    const entries = {};
    for (const item of body[key]) {
      entries[item] = makeEntry(item);
    }
    return { results: { [key]: entries } };
  };
  return { post, calls };
}

function collector() {
  const events = [];
  return { events, callback: async (e) => events.push(e) };
}

describe("processBatchWithStreaming", () => {
  it("chunks items into batches of 50", async () => {
    const items = Array.from({ length: 120 }, (_, i) => `0x${i}`);
    const { post, calls } = fakePost("address", () => ({
      exists: false,
    }));
    const { callback } = collector();

    const results = await processBatchWithStreaming(
      items,
      "address",
      "/batch/check",
      callback,
      post,
    );

    assert.equal(calls.length, 3);
    assert.equal(calls[0].body.addresses.length, 50);
    assert.equal(calls[1].body.addresses.length, 50);
    assert.equal(calls[2].body.addresses.length, 20);
    assert.ok(calls.every((c) => c.endpoint === "/batch/check"));
    assert.equal(results.length, 120);
  });

  it("emits progress events with correct counts and percentages", async () => {
    const items = Array.from({ length: 120 }, (_, i) => `0x${i}`);
    const { post } = fakePost("address", () => ({ exists: false }));
    const { events, callback } = collector();

    await processBatchWithStreaming(
      items,
      "address",
      "/batch/check",
      callback,
      post,
    );

    const progress = events.filter((e) => e.type === "progress");
    assert.deepEqual(
      progress.map((p) => [p.current, p.total, p.percentage]),
      [
        [50, 120, 42],
        [100, 120, 83],
        [120, 120, 100],
      ],
    );
    assert.equal(progress[0].message, "Processing batch 1/3 (50 addresss)...");
  });

  it("maps /batch/check entries and reports only found items", async () => {
    const entries = {
      "0x1": { exists: true, types: ["twitter"] },
      "0x2": { exists: false },
      "0x3": { exists: true },
    };
    const { post } = fakePost("address", (item) => entries[item]);
    const { events, callback } = collector();

    const results = await processBatchWithStreaming(
      ["0x1", "0x2", "0x3"],
      "address",
      "/batch/check",
      callback,
      post,
    );

    assert.deepEqual(results, [
      { address: "0x1", found: true, types: ["twitter"] },
      { address: "0x2", found: false, types: [] },
      { address: "0x3", found: true, types: [] },
    ]);

    const resultEvents = events.filter((e) => e.type === "result");
    assert.equal(resultEvents.length, 2);
    assert.equal(resultEvents[0].message, "✓ Found: 0x1 (twitter)");
    assert.equal(resultEvents[1].message, "✓ Found: 0x3 (no types)");
  });

  it("maps /batch/data address entries with defaults for missing fields", async () => {
    const entries = {
      "0x1": {
        found: true,
        identities: [
          { type: "twitter", value: "alice", source: "ens" },
          { type: "github", value: "alice-gh", source: "farcaster" },
          { type: "email", value: "a@b.c", source: "ens" },
        ],
        labels: [{ type: "cex", name: "Binance", source: "hildobby" }],
        sanctions: [{ source: "ofac", entity: "X", active: true }],
        cluster: { id: "cl_1", totalAddresses: 2 },
      },
      "0x2": { found: true }, // all optional fields absent
      "0x3": { found: false },
    };
    const { post } = fakePost("address", (item) => entries[item]);
    const { events, callback } = collector();

    const results = await processBatchWithStreaming(
      ["0x1", "0x2", "0x3"],
      "address",
      "/batch/data",
      callback,
      post,
    );

    assert.equal(results[0].found, true);
    assert.equal(results[0].identities.length, 3);
    assert.equal(results[0].cluster.id, "cl_1");
    // Missing fields default to empty arrays / null
    assert.deepEqual(results[1], {
      address: "0x2",
      found: true,
      identities: [],
      labels: [],
      sanctions: [],
      cluster: null,
    });
    assert.equal(results[2].found, false);

    const messages = events
      .filter((e) => e.type === "result")
      .map((e) => e.message);
    assert.deepEqual(messages, [
      "✓ Found: 0x1 → twitter:alice +2 more, 1 label(s), ⚠ 1 sanction(s)",
      "✓ Found: 0x2 → labels only",
    ]);
  });

  it("maps /batch/data identity entries", async () => {
    const entries = {
      alice: {
        found: true,
        totalMatches: 2,
        results: [{ address: "0xa" }, { address: "0xb" }],
      },
      bob: { found: false },
    };
    const { post, calls } = fakePost("identity", (item) => entries[item]);
    const { events, callback } = collector();

    const results = await processBatchWithStreaming(
      ["alice", "bob"],
      "identity",
      "/batch/data",
      callback,
      post,
    );

    assert.deepEqual(calls[0].body, { identities: ["alice", "bob"] });
    assert.deepEqual(results[0], {
      identity: "alice",
      found: true,
      totalMatches: 2,
      matches: [{ address: "0xa" }, { address: "0xb" }],
    });
    assert.deepEqual(results[1], {
      identity: "bob",
      found: false,
      totalMatches: 0,
      matches: [],
    });

    const resultEvents = events.filter((e) => e.type === "result");
    assert.equal(resultEvents.length, 1);
    assert.equal(resultEvents[0].message, "✓ Found: alice → 2 match(es)");
  });

  it("returns an empty array for empty input without calling the API", async () => {
    const { post, calls } = fakePost("address", () => ({ exists: true }));
    const { events, callback } = collector();

    const results = await processBatchWithStreaming(
      [],
      "address",
      "/batch/check",
      callback,
      post,
    );

    assert.deepEqual(results, []);
    assert.equal(calls.length, 0);
    assert.equal(events.length, 0);
  });

  it("propagates API errors", async () => {
    const post = async () => {
      throw new Error("Request failed: 500");
    };
    const { callback } = collector();

    await assert.rejects(
      processBatchWithStreaming(
        ["0x1"],
        "address",
        "/batch/check",
        callback,
        post,
      ),
      /Request failed: 500/,
    );
  });
});
