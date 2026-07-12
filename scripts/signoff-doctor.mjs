#!/usr/bin/env node
/**
 * Signoff preflight: check every prerequisite of `pnpm run signoff` up
 * front and report ALL failures in one pass, each with its fix command,
 * instead of letting the strict test run and `gh signoff` fail one
 * error at a time.
 *
 * Checks:
 *   1. Node >= 21                    (node --test glob support)
 *   2. bluepages-fyi sibling checkout (contract tests import its schemas)
 *   3. schemas importable             (fyi's node_modules present — zod)
 *   4. gh CLI installed + authenticated
 *   5. gh-signoff extension installed
 *
 * `--fix` auto-installs bluepages-fyi's runtime deps when the sibling
 * exists but its schemas don't import (the only self-healable check).
 *
 * This script is diagnosis only. The enforcement lives in
 * src/__tests__/contract.test.js via CONTRACT_REQUIRED=1: even if this
 * preflight is bypassed or wrong, a signoff run without the contract
 * tests still fails there.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const FYI_DIR = path.resolve(REPO_ROOT, "../bluepages-fyi");
const SCHEMAS_PATH = path.join(FYI_DIR, "src", "response-schemas.js");
const APPLY_FIXES = process.argv.includes("--fix");

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const green = (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s);

const results = [];
const pass = (label, note) => results.push({ ok: true, label, note });
const fail = (label, note, fixes = []) =>
  results.push({ ok: false, label, note, fixes });

// 1. Node version — node --test with a glob needs >= 21
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 21) {
  pass(`node ${process.versions.node}`);
} else {
  fail(`node ${process.versions.node} is too old for the test runner`, null, [
    "install Node 21+ (node --test needs glob support)",
  ]);
}

// 2 + 3. bluepages-fyi sibling checkout, schemas importable
if (!existsSync(SCHEMAS_PATH)) {
  fail("bluepages-fyi sibling checkout", `${SCHEMAS_PATH} not found`, [
    `check out the private bluepages-fyi repo next to this one: ${FYI_DIR}`,
  ]);
} else {
  pass("bluepages-fyi sibling checkout");
  let importError = await tryImport(pathToFileURL(SCHEMAS_PATH).href);
  if (importError && APPLY_FIXES) {
    process.stdout.write("installing bluepages-fyi runtime deps…\n");
    const install = spawnSync(
      "pnpm",
      ["install", "--prod", "--ignore-scripts"],
      { cwd: FYI_DIR, stdio: "inherit" },
    );
    if (install.status === 0) {
      // new URL: a failed import may be cached for the old one
      importError = await tryImport(
        pathToFileURL(SCHEMAS_PATH).href + "?post-fix",
      );
    }
  }
  if (!importError) {
    pass("bluepages-fyi schemas importable");
  } else {
    fail("bluepages-fyi schemas importable", importError.message, [
      "pnpm run signoff:doctor --fix",
      "(equivalent: cd ../bluepages-fyi && pnpm install --prod --ignore-scripts)",
    ]);
  }
}

// 4. gh CLI installed + authenticated
const ghVersion = spawnSync("gh", ["--version"], { encoding: "utf8" });
if (ghVersion.error || ghVersion.status !== 0) {
  fail("gh CLI installed", null, ["install gh: https://cli.github.com"]);
} else {
  pass("gh CLI installed");
  const auth = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
  if (auth.status === 0) {
    pass("gh authenticated");
  } else {
    fail("gh authenticated", null, ["gh auth login"]);
  }

  // 5. gh-signoff extension. `gh extension list` only reads local disk but
  // still demands auth config — a dummy GH_TOKEN satisfies it either way.
  const ext = spawnSync("gh", ["extension", "list"], {
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: process.env.GH_TOKEN || "signoff-doctor" },
  });
  if (/\bsignoff\b/.test(ext.stdout ?? "")) {
    pass("gh-signoff extension installed");
  } else {
    fail("gh-signoff extension installed", null, [
      "gh extension install basecamp/gh-signoff",
    ]);
  }
}

async function tryImport(url) {
  try {
    await import(url);
    return null;
  } catch (err) {
    return err;
  }
}

// Report
process.stdout.write("signoff preflight:\n\n");
for (const r of results) {
  const mark = r.ok ? green("✔") : red("✖");
  process.stdout.write(`  ${mark} ${r.label}\n`);
  if (!r.ok && r.note) process.stdout.write(`      ${r.note}\n`);
  for (const f of r.fixes ?? []) {
    process.stdout.write(`      fix: ${f}\n`);
  }
}

const failed = results.filter((r) => !r.ok).length;
if (failed > 0) {
  process.stdout.write(
    `\n${failed} of ${results.length} checks failed — fix the above, then re-run: pnpm run signoff\n`,
  );
  process.exit(1);
}
process.stdout.write("\nall checks passed\n");
