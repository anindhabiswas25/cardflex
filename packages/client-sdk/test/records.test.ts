import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { handRecordFromHandLog } from "../src/records.ts";
import { handLogBytes } from "../src/testing.ts";

const probes = new URL("../../../docs/probes/", import.meta.url);

test("a revealed HandLog becomes exactly the published cf-hand-record/2", () => {
  const files = readdirSync(probes).filter((f) => /-game-hand\d+\.json$/.test(f)).slice(0, 4);
  assert.ok(files.length > 0);
  for (const f of files) {
    const rec = JSON.parse(readFileSync(new URL(f, probes), "utf8"));
    const got = handRecordFromHandLog(handLogBytes(rec), rec.hands);
    assert.deepEqual(got, rec, f);
  }
});
