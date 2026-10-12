import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sources = [
  'App.tsx',
  'Financial.tsx',
  'liveFree.ts',
  'consumer-ui/ConsumerShell.tsx',
  'consumer-ui/MarketDiscovery.tsx',
  'consumer-ui/controls.tsx',
  'consumer-ui/copy.ts',
];

test('owned consumer UI copy uses chip language rather than legacy call labels', () => {
  for (const source of sources) {
    const text = readFileSync(new URL(`../src/${source}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /\b(?:free|open|closed|make a|close a)\s+calls?\b|\bcall (?:opened|closed|history|records)\b|\bview actor\b/i, source);
  }
});
