// tests/f-cli-ergonomics.test.mjs — CLI discoverability ergonomics.
//
// Two gaps pinned here:
//   1. An unknown top-level subcommand (typo) printed a generic usage dump
//      with no "did you mean" suggestion. `nearest()` over SUBCOMMANDS now
//      computes the closest known command and cli.mjs surfaces it.
//   2. `lazyclaw help <name>` errored (exit 2) for many real subcommands that
//      lacked a HELP_DETAILS entry (loop/goal/memory/slack/team/task/mcp/...).
//      cli.mjs now resolves a usage hint for ANY known subcommand (exit 0) and
//      a "did you mean" for unknown ones, before delegating to cmdHelp.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { nearest, SUBCOMMANDS } from '../lib/args.mjs';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));

function runCli(args) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ergo-'));
  try {
    return spawnSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, LAZYCLAW_CONFIG_DIR: tmp },
      encoding: 'utf8',
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// (b) Unit: nearest() picks the closest known subcommand.
test('nearest("sesions", SUBCOMMANDS) === "sessions"', () => {
  assert.equal(nearest('sesions', SUBCOMMANDS), 'sessions');
});

test('nearest() returns null when nothing is close', () => {
  assert.equal(nearest('zzzzzzzzz', SUBCOMMANDS), null);
});

test('nearest() resolves a clear prefix even past the edit-distance gate', () => {
  // "provid" is distance 3 from "providers" but an unambiguous prefix.
  assert.equal(nearest('provid', SUBCOMMANDS), 'providers');
});

// (a) Unknown subcommand → non-zero exit + "did you mean ... sessions".
test('typo subcommand exits non-zero with a did-you-mean suggestion', () => {
  const r = runCli(['sesions']);
  assert.notEqual(r.status, 0, 'typo subcommand should exit non-zero');
  assert.match(r.stderr, /did you mean/);
  assert.match(r.stderr, /sessions/);
});

// (c) help <known-subcommand> exits 0 with a usage hint.
test('help sessions exits 0 with a sessions usage hint', () => {
  const r = runCli(['help', 'sessions']);
  assert.equal(r.status, 0, `help sessions should exit 0; stderr=${r.stderr}`);
  assert.match(r.stdout, /sessions/);
});

// Pin the genuine pre-fix gap: `help loop` had no HELP_DETAILS entry and
// errored (exit 2). It must now exit 0 with a hint mentioning the command.
test('help loop exits 0 (pre-fix it errored with exit 2)', () => {
  const r = runCli(['help', 'loop']);
  assert.equal(r.status, 0, `help loop should exit 0; stderr=${r.stderr}`);
  assert.match(r.stdout + r.stderr, /loop/);
});

// help on an unknown name suggests the nearest command.
test('help <typo> suggests the nearest subcommand', () => {
  const r = runCli(['help', 'sesions']);
  assert.match(r.stderr, /did you mean/);
  assert.match(r.stderr, /sessions/);
});
