// tests/f-cron-launchd-or.test.mjs — launchd buildPlist took the cartesian
// product of day-of-month × day-of-week, so `0 9 13 * 5` fired only when the
// 13th IS a Friday (AND). cron semantics are OR when BOTH are restricted:
// fire on the 13th OR on any Friday. Same spec, divergent behavior vs crontab
// on Linux — silently wrong scheduled runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlist } from '../cron.mjs';

function intervalsOf(xml) {
  const m = xml.match(/<key>StartCalendarInterval<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!m) return [];
  return [...m[1].matchAll(/<dict>([\s\S]*?)<\/dict>/g)].map((d) => {
    const obj = {};
    for (const kv of d[1].matchAll(/<key>(\w+)<\/key>\s*<integer>(\d+)<\/integer>/g)) obj[kv[1]] = Number(kv[2]);
    return obj;
  });
}

test('buildPlist uses OR semantics when both day-of-month and day-of-week are restricted', () => {
  const ivs = intervalsOf(buildPlist('job', '0 9 13 * 5', ['pompos', 'tick']));
  assert.ok(ivs.some((i) => i.Day === 13 && i.Weekday === undefined), 'must fire on the 13th regardless of weekday');
  assert.ok(ivs.some((i) => i.Weekday === 5 && i.Day === undefined), 'must fire on Fridays regardless of date');
  assert.ok(!ivs.some((i) => i.Day !== undefined && i.Weekday !== undefined), 'must NOT AND day-of-month with weekday');
  assert.ok(ivs.every((i) => i.Hour === 9 && i.Minute === 0), 'every entry carries the 09:00 time');
});

test('buildPlist with only weekday restricted is unchanged (every Friday 09:00)', () => {
  const ivs = intervalsOf(buildPlist('j2', '0 9 * * 5', ['x']));
  assert.deepEqual(ivs, [{ Minute: 0, Hour: 9, Weekday: 5 }]);
});

test('buildPlist with only day-of-month restricted is unchanged (the 13th, 09:00)', () => {
  const ivs = intervalsOf(buildPlist('j3', '0 9 13 * *', ['x']));
  assert.deepEqual(ivs, [{ Minute: 0, Hour: 9, Day: 13 }]);
});
