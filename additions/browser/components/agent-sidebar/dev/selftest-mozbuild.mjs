/* Verify the strict case-insensitive ordering required by Mozilla moz.build. */
import fs from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mozBuildPath = fileURLToPath(new URL("../moz.build", import.meta.url));
const modulesPath = fileURLToPath(new URL("../modules/", import.meta.url));
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const localePrefsPath = fileURLToPath(new URL("../preferences/frx-locale.js", import.meta.url));
const localeMozBuildPath = fileURLToPath(new URL("../preferences/moz.build", import.meta.url));
const fingerprintPatchPath = fileURLToPath(new URL("../../../../../scripts/apply-fingerprint-config.py", import.meta.url));
const agentUiPatchPath = fileURLToPath(new URL("../../../../../patches/agent-ui/0001-register-agent-sidebar.patch", import.meta.url));
const releaseWorkflowPath = fileURLToPath(new URL("../../../../../.github/workflows/release.yml", import.meta.url));
const bootstrapPath = fileURLToPath(new URL("../../../../../scripts/bootstrap.sh", import.meta.url));
const buildRelinkPath = fileURLToPath(new URL("../../../../../scripts/force-build-id-relink.sh", import.meta.url));
const source = fs.readFileSync(mozBuildPath, "utf8");
const localeMozBuild = fs.readFileSync(localeMozBuildPath, "utf8");
const packageVersion = JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
const blocks = [...source.matchAll(/EXTRA_JS_MODULES\.agentsidebar((?:\.\w+)*)\s*\+=\s*\[([\s\S]*?)\n\]/g)];
assert.ok(blocks.length, "moz.build must register Agent modules");
const compare = (left, right) => {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
};
const entries = [];
const installed = new Map();
const resourceRoot = "resource:///modules/agentsidebar/";
for (const [, suffix, body] of blocks) {
  const groupEntries = [...body.matchAll(/"([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(groupEntries, [...groupEntries].sort(compare), "moz.build group must be sorted");
  const destination = suffix.slice(1).replaceAll(".", "/");
  for (const entry of groupEntries) {
    const url = resourceRoot + (destination ? destination + "/" : "") + path.posix.basename(entry);
    assert.equal(installed.has(url), false, "duplicate installed URL: " + url);
    const expectedDir = "modules/" + (destination || "compat");
    assert.equal(path.posix.dirname(entry), expectedDir, "source and packaged directory disagree");
    installed.set(url, entry);
    entries.push(entry);
  }
}
function moduleFiles(directory, prefix = "modules") {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix + "/" + entry.name;
    if (entry.isDirectory()) return moduleFiles(path.join(directory, entry.name), relative);
    return entry.name.endsWith(".sys.mjs") ? [relative] : [];
  });
}
const sourceModules = moduleFiles(modulesPath).sort();
const registeredModules = [...entries].sort();
if (JSON.stringify(sourceModules) !== JSON.stringify(registeredModules)) {
  const missing = sourceModules.filter(name => !registeredModules.includes(name));
  const stale = registeredModules.filter(name => !sourceModules.includes(name));
  console.error("FAIL: moz.build does not exactly match modules/**/*.sys.mjs");
  if (missing.length) console.error("unregistered:", missing.join(", "));
  if (stale.length) console.error("missing source:", stale.join(", "));
  process.exit(1);
}

// Resolve imports against the *installed* URL graph. Merely checking source
// imports would miss moz.build accidentally flattening a nested directory.
const sidebarPath = path.dirname(modulesPath);
for (const [url, entry] of installed) {
  const moduleSource = fs.readFileSync(path.join(sidebarPath, entry), "utf8");
  const references = [...moduleSource.matchAll(/["']((?:\.{1,2}\/|resource:\/\/\/modules\/agentsidebar\/)[^"'\s]+\.sys\.mjs)["']/g)];
  for (const [, specifier] of references) {
    const resolved = new URL(specifier, url).href;
    assert.ok(installed.has(resolved), url + " imports missing " + resolved);
  }
  if (entry.startsWith("modules/compat/")) {
    const forward = moduleSource.match(/^export \* from "(resource:\/\/\/modules\/agentsidebar\/[^"]+)";$/m);
    assert.ok(forward, "compatibility entry must re-export the implementation: " + entry);
    assert.ok(installed.has(forward[1]), "missing compatibility target: " + entry);
    assert.ok(!installed.get(forward[1]).startsWith("modules/compat/"), "compatibility entry must target an implementation");
    assert.equal(path.posix.basename(forward[1]), path.posix.basename(entry));
  }
}
// These URLs existed before the directory migration. New modules do not need
// flat aliases unless they are deliberately exposed as legacy entry points.
const legacyNames = [
  "AddonBackend.sys.mjs",
  "AgentEvalChild.sys.mjs",
  "AgentLoop.sys.mjs",
  "AgentRuntime.sys.mjs",
  "AgentRuntimeCore.sys.mjs",
  "AgentRuntimePorts.sys.mjs",
  "AgentSession.sys.mjs",
  "AgentSupervisor.sys.mjs",
  "AgentTurnOrchestrator.sys.mjs",
  "Backends.sys.mjs",
  "CodeBackend.sys.mjs",
  "ConfigStore.sys.mjs",
  "ContextProjection.sys.mjs",
  "ConversationStore.sys.mjs",
  "EnvironmentBackend.sys.mjs",
  "EnvironmentBackendCurrent.sys.mjs",
  "FirefoxAgentRuntimeHost.sys.mjs",
  "JsvmpBackend.sys.mjs",
  "LedgerBackend.sys.mjs",
  "LlmClient.sys.mjs",
  "LlmProtocol.sys.mjs",
  "LlmRequestExecutor.sys.mjs",
  "LlmStreamParser.sys.mjs",
  "LlmTransport.sys.mjs",
  "NetworkBackend.sys.mjs",
  "NotesBackend.sys.mjs",
  "PageBackend.sys.mjs",
  "ReasoningEffort.sys.mjs",
  "ScriptsBackend.sys.mjs",
  "SkillBackend.sys.mjs",
  "ToolRouter.sys.mjs",
  "Tools.sys.mjs",
  "Usage.sys.mjs",
  "WebApiBackend.sys.mjs",
  "WorkspaceBackend.sys.mjs",
  "providers.sys.mjs",
];
for (const name of legacyNames) {
  assert.equal(installed.get(resourceRoot + name), "modules/compat/" + name, "missing legacy URL: " + name);
}
for (const name of ["index.jsx", "AgentPanel.jsx", "EnvironmentPane.jsx"]) {
  const uiSource = fs.readFileSync(path.join(sidebarPath, "content", name), "utf8");
  for (const [url] of uiSource.matchAll(/resource:\/\/\/modules\/agentsidebar\/[A-Za-z/]+\.sys\.mjs/g)) {
    assert.ok(installed.has(url), name + " imports missing " + url);
  }
}

if (!source.includes('DIRS += ["preferences"]')) {
  console.error("FAIL: preferences subdirectory is not registered in moz.build");
  process.exit(1);
}

if (!localeMozBuild.includes('FINAL_TARGET = "dist/bin"')) {
  console.error("FAIL: locale preference target is not the application root");
  process.exit(1);
}

if (!localeMozBuild.includes('DIST_SUBDIR = ""')) {
  console.error("FAIL: locale preference inherits the browser dist subdirectory");
  process.exit(1);
}

if (!localeMozBuild.includes("FINAL_TARGET_FILES.defaults.pref")) {
  console.error("FAIL: zh-CN preference file is not packaged in defaults/pref");
  process.exit(1);
}

const localePrefs = fs.readFileSync(localePrefsPath, "utf8");
for (const expected of [
  `pref("extensions.firefox-reverse.version", "${packageVersion}")`,
  'pref("intl.locale.requested", "zh-CN")',
  'pref("intl.accept_languages", "zh-CN, zh, en-US, en")',
]) {
  if (!localePrefs.includes(expected)) {
    console.error(`FAIL: missing locale default: ${expected}`);
    process.exit(1);
  }
}

const fingerprintPatch = fs.readFileSync(fingerprintPatchPath, "utf8");
for (const expected of [
  "aCallerType == CallerType::NonSystem",
  "ShouldApplyFrxScreenFingerprint(GetOwnerWindow())",
  "!doc->NodePrincipal()->IsSystemPrincipal()",
]) {
  if (!fingerprintPatch.includes(expected)) {
    console.error(`FAIL: fingerprint override leaks into browser chrome: ${expected}`);
    process.exit(1);
  }
}

const agentUiPatch = fs.readFileSync(agentUiPatchPath, "utf8");
for (const expected of [
  'diff --git a/browser/components/moz.build b/browser/components/moz.build',
  '+    "agent-sidebar",',
  '+        "viewAgentSidebar",',
  '+          url: "chrome://browser/content/agent-sidebar/panel.html",',
  '+sidebar-menu-agent-label =',
]) {
  if (!agentUiPatch.includes(expected)) {
    console.error(`FAIL: baseline Agent sidebar registration patch is incomplete: ${expected}`);
    process.exit(1);
  }
}

const releaseWorkflow = fs.readFileSync(releaseWorkflowPath, "utf8");
for (const expected of [
  "FIREFOX_REV: cebc55aab4d2661d1f6c2d1526362947ec4016c1",
  'GECKO_REMOTE: "https://github.com/mozilla-firefox/firefox.git"',
  'MOZ_SOURCE_CHANGESET: ${{ github.sha }}',
  'git -C upstream fetch --depth 1 origin "$FIREFOX_REV"',
  "./mach configure",
  'scripts/force-build-id-relink.sh" "$UPSTREAM/${{ matrix.objdir }}"',
  'grep -F "SourceStamp=$MOZ_SOURCE_CHANGESET"',
  "python firefox-reverse/scripts/apply-fingerprint-config.py upstream",
]) {
  if (!releaseWorkflow.includes(expected)) {
    console.error(`FAIL: release workflow is not pinned/reproducible: ${expected}`);
    process.exit(1);
  }
}
if (releaseWorkflow.includes("apply-patches.sh ) || true")) {
  console.error("FAIL: release workflow silently ignores patch failures");
  process.exit(1);
}

const bootstrap = fs.readFileSync(bootstrapPath, "utf8");
for (const expected of [
  "UPSTREAM_REF:-cebc55aab4d2661d1f6c2d1526362947ec4016c1",
  'git -C "$UPSTREAM_DIR" fetch --depth 1 origin "$UPSTREAM_REF"',
  'git -C "$UPSTREAM_DIR" checkout --detach FETCH_HEAD',
]) {
  if (!bootstrap.includes(expected)) {
    console.error(`FAIL: bootstrap does not pin/fetch the Firefox baseline: ${expected}`);
    process.exit(1);
  }
}

const buildRelink = fs.readFileSync(buildRelinkPath, "utf8");
for (const expected of [
  '"$objdir/buildid.h"',
  '"$objdir/source-repo.h"',
  '"$objdir/.deps/source-repo.h.stub"',
  '"$objdir/.deps/source-repo.h.pp"',
  'grep -aFq "$MOZ_SOURCE_CHANGESET" "$objdir/config.status"',
  "run ./mach configure with the release metadata",
]) {
  if (!buildRelink.includes(expected)) {
    console.error(`FAIL: build metadata relink misses generated input: ${expected}`);
    process.exit(1);
  }
}

console.log(`moz.build order, parent registration, pinned release baseline, locale defaults, and fingerprint isolation: OK (${entries.length} files)`);
