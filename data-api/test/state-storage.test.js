const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

test("extension storage adapter routes reads and revisioned writes through the service worker", async () => {
  const messages = [];
  const listeners = [];
  const intervals = [];
  const responses = [
    { ok: true, values: { activeBonusConfig: { enabled: false } }, revision: 7 },
    { ok: true, movements: [{ operation: "withdrawal", amount: 10 }] },
    { ok: true, movements: [{ operation: "deposit", amount: 20 }] },
    { ok: true, stats: { summary: { deposits: "2" }, platforms: [], profiles: [] } },
    { ok: true, stats: { summary: { deposits: "1" }, platforms: [], profiles: [] } },
    { ok: true, recorded: true },
    { ok: true, withdrawals: [{ username: "jeni8777f", durationMs: 240_000 }] },
    { ok: true, revision: 8, changeRevision: 12 },
    { ok: true, revision: 9, changeRevision: 13 }
  ];
  const context = vm.createContext({
    chrome: {
      runtime: {
        onMessage: { addListener(listener) { listeners.push(listener); } },
        sendMessage(message) {
          messages.push(message);
          return Promise.resolve(responses.shift());
        }
      }
    },
    console,
    setInterval(callback, delay) {
      intervals.push({ callback, delay });
      return intervals.length;
    }
  });
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "state-storage.js"), "utf8");
  vm.runInContext(source, context, { filename: "state-storage.js" });
  const changes = [];
  context.stateStorage.onChanged.addListener((delta, area) => changes.push({ delta, area }));

  const initial = await context.stateStorage.get(["activeBonusConfig"]);
  assert.deepEqual(JSON.parse(JSON.stringify(initial)), {
    activeBonusConfig: { enabled: false }
  });
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].delay, 5_000);
  const movements = await context.stateStorage.getMovements({
    contactKey: "contact-1",
    operation: "withdrawal",
    limit: 1,
    ownProfile: true
  });
  assert.deepEqual(JSON.parse(JSON.stringify(movements)), [
    { operation: "withdrawal", amount: 10 }
  ]);
  const accountMovements = await context.stateStorage.getMovements({
    accountIds: ["ganamos:5491112345678", "multipanel:5491112345678"],
    legacyContactKeys: ["legacy-contact-1", "legacy-contact-2"],
    ganamosUsername: "user-a",
    multipanelUsername: "user-b"
  });
  assert.deepEqual(JSON.parse(JSON.stringify(accountMovements)), [
    { operation: "deposit", amount: 20 }
  ]);
  const advertisingStats = await context.stateStorage.getAdvertisingStats({ from: 1000, to: 2000 });
  assert.equal(advertisingStats.summary.deposits, "2");
  const filteredAdvertisingStats = await context.stateStorage.getAdvertisingStats(
    { from: 1000, to: 2000 },
    ["33333333-3333-4333-8333-333333333333"]
  );
  assert.equal(filteredAdvertisingStats.summary.deposits, "1");
  await context.stateStorage.recordWithdrawal({
    withdrawalId: "pending-message-1",
    username: "jeni8777f",
    createdAt: 1000,
    completedAt: 241000
  });
  const withdrawals = await context.stateStorage.getWithdrawals({ from: 1000, to: 2000 });
  assert.equal(withdrawals[0].username, "jeni8777f");
  assert.equal(withdrawals[0].durationMs, 240_000);
  await context.stateStorage.set({ activeBonusConfig: { enabled: true } });
  await context.stateStorage.remove("activeBonusConfig");

  assert.deepEqual(messages.map(({ type }) => type), [
    "STATE_GET", "MOVEMENTS_GET", "MOVEMENTS_GET", "ADVERTISING_STATS_GET", "ADVERTISING_STATS_GET",
    "WITHDRAWAL_RECORD", "WITHDRAWALS_GET",
    "STATE_SET", "STATE_REMOVE"
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(messages[1].filters)), {
    contactKey: "contact-1",
    operation: "withdrawal",
    limit: 1,
    ownProfile: true
  });
  assert.deepEqual(JSON.parse(JSON.stringify(messages[2].filters)), {
    accountIds: ["ganamos:5491112345678", "multipanel:5491112345678"],
    legacyContactKeys: ["legacy-contact-1", "legacy-contact-2"],
    ganamosUsername: "user-a",
    multipanelUsername: "user-b"
  });
  assert.deepEqual(JSON.parse(JSON.stringify(messages[3])), {
    type: "ADVERTISING_STATS_GET",
    from: 1000,
    to: 2000
  });
  assert.deepEqual(JSON.parse(JSON.stringify(messages[4])), {
    type: "ADVERTISING_STATS_GET",
    from: 1000,
    to: 2000,
    excludedProfiles: ["33333333-3333-4333-8333-333333333333"]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(messages[5].withdrawal)), {
    withdrawalId: "pending-message-1",
    username: "jeni8777f",
    createdAt: 1000,
    completedAt: 241000
  });
  assert.deepEqual(JSON.parse(JSON.stringify(messages[6].filters)), {
    from: 1000,
    to: 2000
  });
  assert.equal(messages[7].expectedRevision, 7);
  assert.equal(messages[8].expectedRevision, 8);
  assert.deepEqual(JSON.parse(JSON.stringify(messages[8].removes)), ["activeBonusConfig"]);
  listeners[0]({
    type: "STATE_CHANGED",
    changes: { activeBonusConfig: { oldValue: { enabled: true }, newValue: { enabled: false } } }
  });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].area, "local");
});
