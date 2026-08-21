/**
 * Contract test: this package's version must be mirrored VERBATIM in every
 * version field of the agent-plugins plugin that wraps it. The two ship in
 * lockstep by convention, and the plugin carries FOUR version-bearing spots:
 *
 *   - plugins/bluepages/.claude-plugin/plugin.json  `version`
 *   - .claude-plugin/marketplace.json               `metadata.version`
 *   - .claude-plugin/marketplace.json               `plugins[*].version`
 *   - plugins/bluepages/skills/bluepages/SKILL.md   frontmatter `metadata.version`
 *
 * The SKILL.md frontmatter one is the classic miss — it is plain YAML text,
 * invisible to any JSON-aware sweep, and a bump that updates the three JSON
 * fields but not the frontmatter ships a plugin that self-reports two
 * different versions. This test exists because exactly that almost happened.
 *
 * Same auto-skip-outside-workspace + CONTRACT_REQUIRED pattern as
 * contract.test.js / chain-validator-contract.test.js, aimed at the
 * agent-plugins sibling instead of bluepages-fyi.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OWN_PACKAGE_JSON = path.resolve(HERE, "../../package.json");
const PLUGIN_ROOT = path.resolve(HERE, "../../../agent-plugins");
const PLUGIN_JSON = path.join(
  PLUGIN_ROOT,
  "plugins/bluepages/.claude-plugin/plugin.json",
);
const MARKETPLACE_JSON = path.join(
  PLUGIN_ROOT,
  ".claude-plugin/marketplace.json",
);
const SKILL_MD = path.join(
  PLUGIN_ROOT,
  "plugins/bluepages/skills/bluepages/SKILL.md",
);

const pluginAvailable = existsSync(PLUGIN_JSON);
const required = !!process.env.CONTRACT_REQUIRED;

if (!pluginAvailable && required) {
  describe("Version lockstep vs agent-plugins", () => {
    it("agent-plugins is available", () => {
      assert.fail(
        `CONTRACT_REQUIRED is set but ${PLUGIN_JSON} does not exist — ` +
          "check out agent-plugins as a sibling of this repo before signing off. A signoff must " +
          "attest that the lockstep check ran.",
      );
    });
  });
}

const skip = pluginAvailable
  ? false
  : required
    ? "reported as a failure above"
    : "agent-plugins repo not available — lockstep check runs only in the workspace";

describe("Version lockstep vs agent-plugins", { skip }, () => {
  const ownVersion = JSON.parse(readFileSync(OWN_PACKAGE_JSON, "utf8")).version;

  it("plugin.json version matches this package's version", () => {
    const plugin = JSON.parse(readFileSync(PLUGIN_JSON, "utf8"));
    assert.equal(
      plugin.version,
      ownVersion,
      "agent-plugins plugin.json must be bumped in lockstep with bluepages-mcp",
    );
  });

  it("marketplace.json carries this package's version in metadata AND every plugin entry", () => {
    const marketplace = JSON.parse(readFileSync(MARKETPLACE_JSON, "utf8"));
    assert.equal(
      marketplace.metadata?.version,
      ownVersion,
      "marketplace.json metadata.version must be bumped in lockstep with bluepages-mcp",
    );
    assert.ok(
      Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0,
    );
    for (const entry of marketplace.plugins) {
      assert.equal(
        entry.version,
        ownVersion,
        `marketplace.json plugins[] entry "${entry.name}" must be bumped in lockstep with bluepages-mcp`,
      );
    }
  });

  it("SKILL.md frontmatter version matches this package's version (the classic miss)", () => {
    const skill = readFileSync(SKILL_MD, "utf8");
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(frontmatter, "SKILL.md must start with a YAML frontmatter block");
    const versionLine = frontmatter[1].match(/^\s*version:\s*"([^"]+)"\s*$/m);
    assert.ok(
      versionLine,
      'SKILL.md frontmatter must carry a quoted `version: "x.y.z"` line',
    );
    assert.equal(
      versionLine[1],
      ownVersion,
      "SKILL.md frontmatter metadata.version must be bumped in lockstep with bluepages-mcp — " +
        "it is plain YAML text and every JSON-focused version sweep misses it",
    );
  });
});
