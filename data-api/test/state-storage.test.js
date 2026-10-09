const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

test("extension storage adapter routes reads and revisioned writes through the service worker", async () => {
  const messages = [];
  const listeners = [];
  const responses = [
    { ok: true, values: { activeBonusConfig: { enabled: false } }, revision: 7 },
    { ok: true, movements: [{ operation: "withdrawal", amount: 10 }] },
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
    setInterval() { return 1; }
  });
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "state-storage.js"), "utf8");
  vm.runInContext(source, context, { filename: "state-storage.js" });
  const changes = [];
  context.stateStorage.onChanged.addListener((delta, area) => changes.push({ delta, area }));

  const initial = await context.stateStorage.get(["activeBonusConfig"]);
  assert.deepEqual(JSON.parse(JSON.stringify(initial)), {
    activeBonusConfig: { enabled: false }
  });
  const movements = await context.stateStorage.getMovements({
    contactKey: "contact-1",
    operation: "withdrawal",
    limit: 1
  });
  assert.deepEqual(JSON.parse(JSON.stringify(movements)), [
    { operation: "withdrawal", amount: 10 }
  ]);
  await context.stateStorage.set({ activeBonusConfig: { enabled: true } });
  await context.stateStorage.remove("activeBonusConfig");

  assert.deepEqual(messages.map(({ type }) => type), [
    "STATE_GET", "MOVEMENTS_GET", "STATE_SET", "STATE_REMOVE"
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(messages[1].filters)), {
    contactKey: "contact-1",
    operation: "withdrawal",
    limit: 1
  });
  assert.equal(messages[2].expectedRevision, 7);
  assert.equal(messages[3].expectedRevision, 8);
  assert.deepEqual(JSON.parse(JSON.stringify(messages[3].removes)), ["activeBonusConfig"]);
  listeners[0]({
    type: "STATE_CHANGED",
    changes: { activeBonusConfig: { oldValue: { enabled: true }, newValue: { enabled: false } } }
  });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].area, "local");
});
