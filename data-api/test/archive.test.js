const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
  canonicalJson,
  createCanonicalSha256,
  decryptValue,
  encryptValue,
  sha256Hex,
  validatePayload
} = require("../archive");

function makePayload() {
  const entries = [
    { key: "agentMovement:100:one", value: { operation: "deposit", contactKey: "contact-1" } },
    { key: "bridgeRole", value: "primary" },
    { key: "futureSetting", value: { enabled: true, labels: ["uno", "dos"] } }
  ].map((entry) => ({
    ...entry,
    valueSha256: sha256Hex(Buffer.from(canonicalJson(entry.value), "utf8"))
  }));
  const payloadEntries = entries.map(({ key, value }) => ({ key, value }));
  return {
    format: "bridgewpp-profile-payload",
    formatVersion: 1,
    exportId: "e70e4c55-599a-4bb3-9f91-a441e86d50e3",
    exportedAt: "2026-10-09T00:00:00.000Z",
    source: {
      extensionId: "a".repeat(32),
      storageArea: "chrome.storage.local"
    },
    integrity: {
      keyCount: entries.length,
      movementCount: 1,
      canonicalSha256: createCanonicalSha256(payloadEntries)
    },
    entries
  };
}

test("validates canonical archive hashes while preserving unknown and movement data", () => {
  const payload = makePayload();
  const validated = validatePayload(payload);
  assert.equal(validated.keyCount, 3);
  assert.equal(validated.movementCount, 1);
  assert.deepEqual(validated.entries[0].value, {
    operation: "deposit",
    contactKey: "contact-1"
  });
  assert.equal(validated.entries[2].key, "futureSetting");
});

test("rejects a changed value and unsorted or duplicate keys", () => {
  const changedValue = makePayload();
  changedValue.entries[1].value = "secondary";
  assert.throws(() => validatePayload(changedValue), /hash de una entrada/);

  const unsorted = makePayload();
  unsorted.entries.reverse();
  assert.throws(() => validatePayload(unsorted), /duplicadas o fuera de orden/);

  const duplicate = makePayload();
  duplicate.entries[1].key = duplicate.entries[0].key;
  assert.throws(() => validatePayload(duplicate), /duplicadas o fuera de orden/);
});

test("encrypts and authenticates each staged value independently", () => {
  const key = crypto.randomBytes(32);
  const serialized = canonicalJson({ sensitive: "token-123", untouched: ["a", "b"] });
  const encrypted = encryptValue(serialized, key);
  assert.notEqual(encrypted.toString("utf8"), serialized);
  assert.equal(decryptValue(encrypted, key), serialized);
  encrypted[encrypted.length - 1] ^= 1;
  assert.throws(() => decryptValue(encrypted, key));
});
