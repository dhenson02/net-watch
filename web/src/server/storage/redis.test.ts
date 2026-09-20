import assert from 'node:assert/strict';
import test from 'node:test';
import { passwordMatches } from '../routes/storage.ts';
import { dayOf } from './redis.ts';

test('dayOf uses the given timezone for the day boundary', () => {
  const ms = Date.parse('2026-09-19T23:30:00Z');
  assert.equal(dayOf(ms, 'UTC'), '2026-09-19');
  assert.equal(dayOf(ms, 'Asia/Tokyo'), '2026-09-20');
});

test('passwordMatches compares whole strings', () => {
  assert.ok(passwordMatches('s3cret', 's3cret'));
  assert.ok(!passwordMatches('s3cret', 's3cre'));
  assert.ok(!passwordMatches('', 's3cret'));
});
