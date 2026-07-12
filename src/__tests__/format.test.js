import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeSanction,
  formatBatchCheckResult,
  formatBatchDataResult,
  formatResult,
  formatStreamingCheckSummary,
  formatStreamingDataSummary,
  formatTweetResults,
} from "../lib.js";

// Fixtures follow the live V2 API contract:
// { address, identities[], labels[], sanctions[], cluster }
const SANCTION_ACTIVE = {
  source: "ofac",
  entity: "Lazarus Group",
  programs: ["DPRK3"],
  addedAt: "2022-04-14",
  removedAt: null,
  active: true,
};

const SANCTION_REMOVED = {
  source: "ofac",
  entity: "Tornado Cash",
  programs: [],
  addedAt: "2022-08-08",
  removedAt: "2025-03-21",
  active: false,
};

describe("describeSanction", () => {
  it("formats an active sanction with programs", () => {
    assert.equal(
      describeSanction(SANCTION_ACTIVE),
      "ofac: Lazarus Group [DPRK3] — active (added 2022-04-14)",
    );
  });

  it("formats a removed sanction without programs", () => {
    assert.equal(
      describeSanction(SANCTION_REMOVED),
      "ofac: Tornado Cash — removed 2025-03-21 (added 2022-08-08)",
    );
  });

  it("omits the program bracket when programs is missing", () => {
    const s = { ...SANCTION_ACTIVE };
    delete s.programs;
    assert.equal(
      describeSanction(s),
      "ofac: Lazarus Group — active (added 2022-04-14)",
    );
  });

  it("joins multiple programs with a comma", () => {
    const s = { ...SANCTION_ACTIVE, programs: ["DPRK3", "CYBER2"] };
    assert.match(describeSanction(s), /\[DPRK3, CYBER2\]/);
  });
});

describe("formatResult", () => {
  it("reports not-found results", () => {
    assert.equal(
      formatResult({ found: false }, "0xdead"),
      "No data found for 0xdead",
    );
  });

  it("falls back to JSON for an empty result", () => {
    assert.equal(formatResult({}, "q"), "{}");
  });

  describe("single address lookup", () => {
    const result = {
      address: "0xabc",
      identities: [
        { type: "twitter", value: "vitalik", source: "ens_text_record" },
        { type: "github", value: "vbuterin", source: "farcaster" },
      ],
      labels: [
        {
          type: "cex",
          name: "Binance",
          detail: "hot wallet",
          source: "hildobby",
        },
        { type: "fund", name: "a16z", source: "arkham" },
      ],
      sanctions: [SANCTION_ACTIVE],
      cluster: {
        id: "cl_1",
        source: "identity-graph",
        transitive: true,
        totalAddresses: 8,
        addresses: ["0x1", "0x2", "0x3", "0x4", "0x5", "0x6"],
        truncated: true,
      },
      twitterSearch: { available: true },
    };

    it("renders every section of a full payload", () => {
      const text = formatResult(result, "0xabc");
      assert.match(text, /^Address: 0xabc$/m);
      assert.match(text, /^twitter: vitalik \(ens_text_record\)$/m);
      assert.match(text, /^github: vbuterin \(farcaster\)$/m);
      assert.match(text, /^ {2}cex: Binance \(hot wallet\) \[hildobby\]$/m);
      assert.match(text, /^ {2}fund: a16z \[arkham\]$/m);
      assert.match(text, /^⚠ Sanctions:$/m);
      assert.match(text, /Lazarus Group \[DPRK3\] — active/);
      assert.match(text, /^Cluster: cl_1$/m);
      assert.match(text, /^ {2}Source: identity-graph$/m);
      assert.match(text, /^ {2}Addresses: 8 \(truncated\)$/m);
      assert.match(text, /^ {2}Transitive: yes$/m);
      assert.match(text, /search_tweets/);
    });

    it("slices cluster members to 5 with an ellipsis", () => {
      const text = formatResult(result, "0xabc");
      assert.match(text, /^ {2}Members: 0x1, 0x2, 0x3, 0x4, 0x5\.\.\.$/m);
    });

    it("shows all members without ellipsis when 5 or fewer", () => {
      const small = {
        ...result,
        cluster: { ...result.cluster, addresses: ["0x1", "0x2"] },
      };
      const text = formatResult(small, "0xabc");
      assert.match(text, /^ {2}Members: 0x1, 0x2$/m);
    });

    it("omits Members line for an empty cluster address list", () => {
      const empty = {
        ...result,
        cluster: { ...result.cluster, addresses: [] },
      };
      assert.doesNotMatch(formatResult(empty, "0xabc"), /Members:/);
    });

    it("omits sanctions, cluster, and tip when absent", () => {
      const text = formatResult(
        {
          address: "0xabc",
          identities: [{ type: "twitter", value: "a", source: "s" }],
          labels: [],
          sanctions: [],
          cluster: null,
        },
        "0xabc",
      );
      assert.doesNotMatch(text, /Sanctions/);
      assert.doesNotMatch(text, /Cluster/);
      assert.doesNotMatch(text, /Labels/);
      assert.doesNotMatch(text, /search_tweets/);
    });
  });

  describe("identity search", () => {
    const result = {
      found: true,
      totalMatches: 2,
      results: [
        {
          address: "0x1",
          matchType: "twitter",
          matchedValue: "alice",
          identities: [{ type: "twitter", value: "alice", source: "ens" }],
          labels: [{ type: "cex", name: "Kraken", source: "hildobby" }],
          sanctions: [SANCTION_REMOVED],
          cluster: { id: "cl_9", totalAddresses: 3 },
        },
        {
          address: "0x2",
          matchType: "twitter",
          matchedValue: "alice",
          identities: [],
          labels: [],
          sanctions: [],
          cluster: null,
        },
      ],
    };

    it("renders a block per match", () => {
      const text = formatResult(result, "alice");
      assert.match(text, /^Found 2 match\(es\) for "alice":$/m);
      assert.match(text, /^Address: 0x1$/m);
      assert.match(text, /^ {2}Match: twitter = alice$/m);
      assert.match(text, /^Address: 0x2$/m);
    });

    it("renders per-match sanctions and cluster", () => {
      const text = formatResult(result, "alice");
      assert.match(text, /^ {2}⚠ Sanctions:$/m);
      assert.match(text, /Tornado Cash — removed 2025-03-21/);
      assert.match(text, /^ {2}Cluster: cl_9 \(3 addresses\)$/m);
    });
  });
});

describe("formatTweetResults", () => {
  it("reports when no tweets are found", () => {
    assert.equal(
      formatTweetResults({ tweets: { count: 0, results: [] } }, "0xabc"),
      "No tweets found mentioning 0xabc",
    );
    assert.equal(
      formatTweetResults({}, "0xabc"),
      "No tweets found mentioning 0xabc",
    );
  });

  it("renders a full tweet with stats and url", () => {
    const result = {
      tweets: {
        count: 1,
        results: [
          {
            username: "zachxbt",
            created_at: "2025-03-15T12:00:00Z",
            text: "line one\nline two",
            reply_count: 3,
            retweet_count: 0,
            like_count: 42,
            view_count: 1000,
            url: "https://x.com/zachxbt/status/1",
          },
        ],
      },
    };
    const text = formatTweetResults(result, "0xabc");
    assert.match(text, /^Found 1 tweet\(s\) mentioning 0xabc:$/m);
    assert.match(text, /^@zachxbt \(Mar 15, 2025\)$/m);
    assert.match(text, /^ {2}line one$/m);
    assert.match(text, /^ {2}line two$/m); // continuation lines are indented
    assert.match(text, /^ {2}\[3 replies, 42 likes, 1000 views\]$/m); // zero counts omitted
    assert.match(text, /^ {2}https:\/\/x\.com\/zachxbt\/status\/1$/m);
  });

  it("handles missing username, date, and stats", () => {
    const result = {
      tweets: { count: 1, results: [{ text: "hi" }] },
    };
    const text = formatTweetResults(result, "0xabc");
    assert.match(text, /^@unknown \(unknown date\)$/m);
    assert.doesNotMatch(text, /\[/);
  });
});

describe("formatBatchCheckResult", () => {
  const result = {
    results: {
      addresses: {
        "0x1": { exists: true, types: ["twitter", "github"] },
        "0x2": { exists: false },
        "0x3": { error: "Invalid address format" },
      },
      identities: {
        alice: { exists: true, types: [] },
      },
    },
  };

  it("counts found items against the requested total", () => {
    const text = formatBatchCheckResult(result, 4);
    assert.match(text, /^Batch check complete: 2\/4 items found in database$/m);
  });

  it("describes each entry, including errors and empty types", () => {
    const text = formatBatchCheckResult(result, 4);
    assert.match(text, /^0x1: ✓ found \(twitter, github\)$/m);
    assert.match(text, /^0x2: ✗ not found$/m);
    assert.match(text, /^0x3: ⚠ Invalid address format$/m);
    assert.match(text, /^alice: ✓ found \(no types\)$/m);
  });

  it("handles an empty results object", () => {
    assert.equal(
      formatBatchCheckResult({}, 0),
      "Batch check complete: 0/0 items found in database\n\n",
    );
  });
});

describe("formatBatchDataResult", () => {
  const result = {
    results: {
      addresses: {
        "0x1": {
          found: true,
          identities: [{ type: "twitter", value: "bob", source: "ens" }],
          labels: [
            { type: "cex", name: "Coinbase", detail: "1", source: "hildobby" },
          ],
          sanctions: [SANCTION_ACTIVE],
          cluster: { id: "cl_2", totalAddresses: 4 },
        },
        "0x2": { found: false },
        "0x3": { error: "Invalid address format" },
      },
      identities: {
        carol: {
          found: true,
          totalMatches: 2,
          results: [
            {
              address: "0xa",
              matchType: "twitter",
              matchedValue: "carol",
              sanctions: [SANCTION_ACTIVE],
            },
            {
              address: "0xb",
              matchType: "twitter",
              matchedValue: "carol",
              sanctions: [SANCTION_REMOVED],
            },
          ],
        },
        dave: { found: false },
      },
    },
  };

  it("renders found addresses with all sections", () => {
    const text = formatBatchDataResult(result);
    assert.match(text, /^0x1$/m);
    assert.match(text, /^ {2}twitter: bob \(ens\)$/m);
    assert.match(text, /^ {4}cex: Coinbase \(1\) \[hildobby\]$/m);
    assert.match(text, /^ {2}⚠ Sanctions:$/m);
    assert.match(text, /^ {2}Cluster: cl_2 \(4 addresses\)$/m);
  });

  it("skips not-found entries and surfaces error entries", () => {
    const text = formatBatchDataResult(result);
    assert.doesNotMatch(text, /^0x2$/m);
    assert.doesNotMatch(text, /^dave/m);
    assert.match(text, /^0x3: ⚠ Invalid address format$/m);
  });

  it("flags identity matches with active sanctions only", () => {
    const text = formatBatchDataResult(result);
    assert.match(text, /^carol: 2 match\(es\)$/m);
    assert.match(text, /^ {2}0xa \(twitter = carol\) ⚠ SANCTIONED$/m);
    assert.match(text, /^ {2}0xb \(twitter = carol\)$/m); // removed sanction: no flag
  });
});

describe("formatStreamingCheckSummary", () => {
  it("summarizes found and not-found counts", () => {
    const text = formatStreamingCheckSummary([
      { address: "0x1", found: true },
      { address: "0x2", found: false },
      { address: "0x3", found: true },
    ]);
    assert.match(text, /Found: 2\nNot found: 1/);
    assert.match(text, /^ {2}✓ 0x1$/m);
    assert.match(text, /^ {2}✓ 0x3$/m);
    assert.doesNotMatch(text, /✓ 0x2/);
  });

  it("prints (none) when nothing was found", () => {
    const text = formatStreamingCheckSummary([
      { address: "0x1", found: false },
    ]);
    assert.match(text, /Found addresses:\n {2}\(none\)$/);
  });

  it("falls back to the identity key for identity items", () => {
    const text = formatStreamingCheckSummary([
      { identity: "alice", found: true },
    ]);
    assert.match(text, /^ {2}✓ alice$/m);
  });
});

describe("formatStreamingDataSummary", () => {
  it("omits the Results section when nothing was found", () => {
    const text = formatStreamingDataSummary([], 10);
    assert.match(text, /Found: 0\/10/);
    assert.doesNotMatch(text, /Results:/);
  });

  it("renders each found item with all sections", () => {
    const text = formatStreamingDataSummary(
      [
        {
          address: "0x1",
          identities: [{ type: "twitter", value: "bob", source: "ens" }],
          labels: [{ type: "cex", name: "OKX", source: "hildobby" }],
          sanctions: [SANCTION_REMOVED],
          cluster: { id: "cl_3", totalAddresses: 2 },
        },
      ],
      5,
    );
    assert.match(text, /Found: 1\/5/);
    assert.match(text, /^0x1$/m);
    assert.match(text, /^ {2}twitter: bob \(ens\)$/m);
    assert.match(text, /^ {4}cex: OKX \[hildobby\]$/m);
    assert.match(text, /Tornado Cash — removed/);
    assert.match(text, /^ {2}Cluster: cl_3 \(2 addresses\)$/m);
  });

  it("falls back to the identity key for identity items", () => {
    const text = formatStreamingDataSummary([{ identity: "alice" }], 1);
    assert.match(text, /^alice$/m);
  });
});
