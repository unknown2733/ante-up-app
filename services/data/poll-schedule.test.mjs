import test from 'node:test';
import assert from 'node:assert/strict';
import {nextRegularPollAt} from './poll-schedule.mjs';
import {latestSettledBucketEnd} from './cli.mjs';

test('paid poll shifts just ahead of the five-minute boundary and then stays five minutes apart', () => {
  const boundary = 1_800_000_000;
  const oldPoll = boundary + 2;
  const shifted = nextRegularPollAt(oldPoll);
  assert.equal(shifted, boundary + 180);
  assert.equal(latestSettledBucketEnd(shifted), boundary);
  assert.equal(nextRegularPollAt(shifted), shifted + 300);
  assert.ok(shifted + 15 - (boundary - 300) < 600);
});

test('invalid poll timestamps are rejected', () => {
  for (const at of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => nextRegularPollAt(at), /INVALID_LAST_POLL_TIME/);
});
