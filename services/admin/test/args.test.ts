import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/args.ts";

test("CF-067: `pnpm admin -- <cmd>` keeps the command word", () => {
  // What pnpm hands the CLI for `pnpm admin -- table keeper CFG KEY --dry-run`.
  const a = parseArgs(["--", "table", "keeper", "CFG", "KEY", "--dry-run"]);
  assert.deepEqual(a.pos, ["table", "keeper", "CFG", "KEY"]);
  assert.equal(a.flag("dry-run"), true);
  // Same without pnpm.
  assert.deepEqual(parseArgs(["table", "keeper", "CFG", "KEY"]).pos, ["table", "keeper", "CFG", "KEY"]);
});

test("options with values don't leak into positionals; boolean flags don't swallow words", () => {
  const a = parseArgs(["--", "table", "create", "--boot", "25000", "--rake-bps", "250"]);
  assert.deepEqual(a.pos, ["table", "create"]);
  assert.equal(a.opt("boot"), "25000");
  assert.equal(a.opt("seats", "6"), "6");
  const b = parseArgs(["table", "check", "--strict", "CFG"]);
  assert.deepEqual(b.pos, ["table", "check", "CFG"]);
  assert.equal(b.flag("strict"), true);
  const c = parseArgs(["watch", "--once", "--keeper-url", "http://h:1/health"]);
  assert.deepEqual(c.pos, ["watch"]);
  assert.equal(c.opt("keeper-url"), "http://h:1/health");
});
