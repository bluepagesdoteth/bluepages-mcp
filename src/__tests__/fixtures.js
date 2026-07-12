/**
 * Canonical API response fixtures, shared by the integration tests (served
 * from the fake API) and the contract tests (validated against the real
 * bluepages-fyi Zod schemas when that repo is present).
 *
 * Keep these contract-accurate: contract.test.js exists precisely to fail
 * when these shapes drift from what the live API serves.
 */

export const FOUND_ADDR = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
export const MISSING_ADDR = "0x0000000000000000000000000000000000000001";
export const ERROR_ADDR = "0x00000000000000000000000000000000000error";
export const FOUND_IDENTITY = "vitalik";

const TIMESTAMP = "2026-07-09T12:00:00.000Z";

const query = (type, value) => ({ type, value });

export const IDENTITIES = [
  {
    type: "twitter",
    value: "vitalik",
    source: "ens_text_record",
    priority: 110,
  },
  { type: "github", value: "vbuterin", source: "farcaster", priority: 20 },
];

export const LABELS = [
  {
    type: "cex",
    name: "Binance",
    detail: "hot wallet",
    source: "hildobby",
    priority: 10,
  },
];

export const SANCTIONS = [
  {
    source: "ofac",
    entity: "Lazarus Group",
    programs: ["DPRK3"],
    addedAt: "2022-04-14",
    removedAt: null,
    active: true,
  },
];

export const CLUSTER = {
  id: "cl_42",
  source: "identity-graph",
  transitive: true,
  identified: true,
  totalAddresses: 3,
  addresses: [FOUND_ADDR, "0xaaa", "0xbbb"],
  truncated: false,
  rawData: {},
};

const TWITTER_SEARCH_INFO = {
  available: true,
  endpoint: "/search/tweets",
  price: "$0.05",
};

/** GET /check response for an address or identity. */
export function checkResponse(type, value, exists) {
  return {
    timestamp: TIMESTAMP,
    query: query(type, value),
    exists,
    types: exists ? ["twitter"] : [],
    message: exists ? "Data available for this query" : "No data found",
  };
}

/** GET /data?address= response (found). */
export const DATA_ADDRESS_RESPONSE = {
  timestamp: TIMESTAMP,
  query: query("address", FOUND_ADDR),
  found: true,
  address: FOUND_ADDR,
  identities: IDENTITIES,
  labels: LABELS,
  sanctions: SANCTIONS,
  cluster: CLUSTER,
  twitterSearch: TWITTER_SEARCH_INFO,
};

/** GET /data?identity= response (found, 2 matches). */
export const DATA_IDENTITY_RESPONSE = {
  timestamp: TIMESTAMP,
  query: query("identity", FOUND_IDENTITY),
  found: true,
  totalMatches: 2,
  results: [
    {
      address: "0xaaa",
      matchType: "twitter",
      matchedValue: "vitalik",
      identities: [
        {
          type: "twitter",
          value: "vitalik",
          source: "ens_text_record",
          priority: 110,
        },
      ],
      labels: [],
      sanctions: [],
      cluster: null,
    },
    {
      address: "0xbbb",
      matchType: "twitter",
      matchedValue: "vitalik",
      identities: [],
      labels: [],
      sanctions: [],
      cluster: null,
    },
  ],
};

/** GET /search/tweets response. */
export const SEARCH_TWEETS_RESPONSE = {
  timestamp: TIMESTAMP,
  query: query("address", FOUND_ADDR),
  tweets: {
    count: 1,
    results: [
      {
        username: "zachxbt",
        created_at: "2025-03-15T12:00:00Z",
        text: "scam alert",
        like_count: 5,
        url: "https://x.com/zachxbt/status/1",
      },
    ],
  },
};

/** POST /batch/check response. Both record maps are always present. */
export function batchCheckResponse(addresses = [], identities = []) {
  const entry = (found) =>
    found ? { exists: true, types: ["twitter"] } : { exists: false, types: [] };

  const addressEntries = {};
  for (const a of addresses) {
    addressEntries[a] =
      a === ERROR_ADDR
        ? { error: "Invalid address format" }
        : entry(a === FOUND_ADDR);
  }
  const identityEntries = {};
  for (const i of identities) {
    identityEntries[i] = entry(i === FOUND_IDENTITY);
  }

  return {
    success: true,
    timestamp: TIMESTAMP,
    totalItems: addresses.length + identities.length,
    results: { addresses: addressEntries, identities: identityEntries },
  };
}

/** POST /batch/data response. Both record maps are always present. */
export function batchDataResponse(addresses = [], identities = []) {
  const addressEntries = {};
  for (const a of addresses) {
    if (a === ERROR_ADDR) {
      addressEntries[a] = { error: "Invalid address format" };
    } else if (a === FOUND_ADDR) {
      addressEntries[a] = {
        found: true,
        address: FOUND_ADDR,
        identities: IDENTITIES,
        labels: LABELS,
        sanctions: SANCTIONS,
        cluster: CLUSTER,
      };
    } else {
      addressEntries[a] = { found: false };
    }
  }

  const identityEntries = {};
  for (const i of identities) {
    identityEntries[i] =
      i === FOUND_IDENTITY
        ? {
            found: true,
            totalMatches: DATA_IDENTITY_RESPONSE.totalMatches,
            results: DATA_IDENTITY_RESPONSE.results,
          }
        : { found: false };
  }

  return {
    success: true,
    timestamp: TIMESTAMP,
    totalItems: addresses.length + identities.length,
    results: { addresses: addressEntries, identities: identityEntries },
  };
}
