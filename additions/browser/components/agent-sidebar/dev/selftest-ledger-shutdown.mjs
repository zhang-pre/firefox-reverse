/* selftest-ledger-shutdown.mjs — LedgerBackend SQLite shutdown lifecycle.
 * Run: node dev/selftest-ledger-shutdown.mjs
 */
import assert from "node:assert/strict";
import { LedgerBackend } from "../modules/backends/LedgerBackend.sys.mjs";

function installSqlite(openConnection) {
  const blockers = new Map();
  const Sqlite = {
    shutdown: {
      addBlocker(name, callback) {
        assert.equal(name, "Agent sidebar: close memory.sqlite");
        assert.equal(blockers.size, 0);
        blockers.set(callback, name);
      },
      removeBlocker(callback) {
        assert.ok(blockers.delete(callback), "registered blocker is removed");
      },
    },
    openConnection,
  };
  globalThis.ChromeUtils = {
    importESModule(uri) {
      assert.equal(uri, "resource://gre/modules/Sqlite.sys.mjs");
      return { Sqlite };
    },
  };
  globalThis.PathUtils = {
    profileDir: "/profile",
    join: (...parts) => parts.join("/"),
  };
  globalThis.IOUtils = {
    async makeDirectory() {},
  };
  return blockers;
}

{
  let opens = 0;
  let closes = 0;
  const conn = {
    async execute() {},
    async close() {
      closes++;
    },
  };
  const blockers = installSqlite(async ({ path }) => {
    assert.equal(path, "/profile/firefox-reverse-agent/memory.sqlite");
    opens++;
    return conn;
  });
  const ledger = new LedgerBackend();
  const [first, second] = await Promise.all([ledger._db(), ledger._db()]);
  assert.equal(first, conn);
  assert.equal(second, conn);
  assert.equal(opens, 1, "concurrent requests share one connection");
  assert.equal(blockers.size, 1);
  const shutdown = [...blockers.keys()][0];
  const closing = shutdown();
  assert.equal(ledger.close(), closing, "close is idempotent");
  await closing;
  assert.equal(closes, 1);
  assert.equal(blockers.size, 0);
  await assert.rejects(ledger._db(), /shutting down/);
  console.log("✓ shutdown closes the shared connection once");
}

{
  let resolveOpen;
  const delayedOpen = new Promise(resolve => {
    resolveOpen = resolve;
  });
  let closes = 0;
  const conn = {
    async execute() {},
    async close() {
      closes++;
    },
  };
  const blockers = installSqlite(async () => delayedOpen);
  const ledger = new LedgerBackend();
  const opening = ledger._db();
  assert.equal(blockers.size, 1);
  const closing = [...blockers.keys()][0]();
  resolveOpen(conn);
  await assert.rejects(opening, /shutting down/);
  await closing;
  assert.equal(closes, 1, "in-flight open is closed");
  assert.equal(blockers.size, 0);
  console.log("✓ shutdown during open leaves no connection behind");
}

{
  const failure = new Error("schema initialization failed");
  let closes = 0;
  const conn = {
    async execute() {
      throw failure;
    },
    async close() {
      closes++;
    },
  };
  const blockers = installSqlite(async () => conn);
  const ledger = new LedgerBackend();
  await assert.rejects(ledger._db(), error => error === failure);
  assert.equal(closes, 1, "failed initialization closes the connection");
  assert.equal(blockers.size, 0, "failed initialization removes its blocker");
  console.log("✓ failed initialization releases its connection");
}
