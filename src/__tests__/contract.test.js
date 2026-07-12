/**
 * Contract tests: validate the shared fixtures against the REAL response
 * schemas from the bluepages-fyi repo (the API implementation).
 *
 * The MCP test suite is otherwise fully hermetic — it runs against a fake
 * API that speaks the contract as encoded in fixtures.js. That means a
 * backend contract change alone will never fail the hermetic tests. This
 * file is the tripwire: when bluepages-fyi is checked out as a sibling
 * (devcontainer / eMac workspace), the fixtures are validated against its
 * Zod schemas, so any drift fails `pnpm test` with the offending field
 * named. Outside the workspace (public repo consumers), it skips.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ERROR_ADDR,
  FOUND_ADDR,
  FOUND_IDENTITY,
  MISSING_ADDR,
  DATA_ADDRESS_RESPONSE,
  DATA_IDENTITY_RESPONSE,
  SEARCH_TWEETS_RESPONSE,
  batchCheckResponse,
  batchDataResponse,
  checkResponse,
} from "./fixtures.js";

const SCHEMAS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../bluepages-fyi/src/response-schemas.js",
);

let schemas = null;
try {
  schemas = await import(pathToFileURL(SCHEMAS_PATH).href);
} catch {
  // bluepages-fyi not checked out next to this repo (or its deps not
  // installed) — contract validation only runs inside the workspace.
}

const skip = schemas
  ? false
  : "bluepages-fyi repo not available — contract check runs only in the workspace";

function assertValid(schema, data, name) {
  const result = schema.safeParse(data);
  assert.ok(
    result.success,
    `${name} drifted from the live API contract:\n${result.success ? "" : result.error.message}`,
  );
}

describe(
  "API contract: fixtures vs bluepages-fyi response schemas",
  { skip },
  () => {
    it("/check responses match CheckResponseSchema", () => {
      assertValid(
        schemas.CheckResponseSchema,
        checkResponse("address", FOUND_ADDR, true),
        "checkResponse (found)",
      );
      assertValid(
        schemas.CheckResponseSchema,
        checkResponse("identity", "nobody", false),
        "checkResponse (not found)",
      );
    });

    it("/data?address= response matches DataAddressResponseSchema", () => {
      assertValid(
        schemas.DataAddressResponseSchema,
        DATA_ADDRESS_RESPONSE,
        "DATA_ADDRESS_RESPONSE",
      );
    });

    it("/data?identity= response matches DataIdentityResponseSchema", () => {
      assertValid(
        schemas.DataIdentityResponseSchema,
        DATA_IDENTITY_RESPONSE,
        "DATA_IDENTITY_RESPONSE",
      );
    });

    it("/search/tweets response matches SearchTweetsResponseSchema", () => {
      assertValid(
        schemas.SearchTweetsResponseSchema,
        SEARCH_TWEETS_RESPONSE,
        "SEARCH_TWEETS_RESPONSE",
      );
    });

    it("/batch/check response matches BatchCheckResponseSchema", () => {
      assertValid(
        schemas.BatchCheckResponseSchema,
        batchCheckResponse(
          [FOUND_ADDR, MISSING_ADDR, ERROR_ADDR],
          [FOUND_IDENTITY, "nobody"],
        ),
        "batchCheckResponse",
      );
    });

    it("/batch/data response matches BatchDataResponseSchema", () => {
      assertValid(
        schemas.BatchDataResponseSchema,
        batchDataResponse(
          [FOUND_ADDR, MISSING_ADDR, ERROR_ADDR],
          [FOUND_IDENTITY, "nobody"],
        ),
        "batchDataResponse",
      );
    });
  },
);
