import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const socialDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(socialDir, '../..');

const source = { mode: 'DEMO', label: 'Sample', asOfMs: Date.UTC(2026, 9, 12) };
const action = (id, kind, atMs, returnFraction = null, note = null) => ({
  id, marketId: 'market-1', actorId: 'sample-actor', actorLabel: 'Sample Actor',
  kind, atMs, seriesId: null, value: null, returnFraction, note, source
});

test('profile keeps synthetic activity separate and preserves unavailable returns and note timing', async () => {
  const server = await createServer({ root: appDir, server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { SocialProfile, SocialNote } = await server.ssrLoadModule('/src/social/Social.tsx');
    const sampleNote = {
      id: 'note-1', actionId: 'close-1', authorId: 'sample-actor', body: 'Sample rationale',
      createdAtMs: Date.UTC(2026, 9, 12, 10), updatedAtMs: Date.UTC(2026, 9, 12, 10),
      version: 2, timing: 'ADDED_LATER', proofCoverage: 'NONE'
    };
    const profile = {
      actorId: 'sample-actor', actorLabel: 'Sample Actor', source,
      closedCallCount: 2, openCallCount: 1, meanReturnFraction: -0.125,
      actions: [
        action('open-1', 'CALL_OPEN', Date.UTC(2026, 9, 12, 11)),
        action('close-1', 'CALL_CLOSE', Date.UTC(2026, 9, 12, 10), -0.25, sampleNote),
        action('close-na', 'CALL_CLOSE', Date.UTC(2026, 9, 11, 10)),
        { ...action('live-leak', 'CALL_OPEN', Date.UTC(2026, 9, 12, 12)), source: { ...source, mode: 'LIVE' } }
      ]
    };
    const html = renderToStaticMarkup(React.createElement(SocialProfile, {
      profile, marketLabel: () => 'Subject title', onOpenMarket: () => {}, onOpenAction: () => {}
    }));
    assert.match(html, /Placed a chip/);
    assert.match(html, /Took back a chip/);
    assert.match(html, /Active chips/);
    assert.match(html, /Subject title/);
    assert.match(html, /Sample rationale/);
    assert.match(html, /-25\.0%/);
    assert.match(html, /N\/A/);
    assert.match(html, /Fictional sample activity/);
    assert.doesNotMatch(html, /live-leak|Free call leaderboard|Record and proof/);
    assert.equal((html.match(/class="au-social-day"/g) ?? []).length, 2);
    const noteHtml = renderToStaticMarkup(React.createElement(SocialNote, { note: sampleNote }));
    assert.match(noteHtml, /Added later/);
    assert.match(noteHtml, /Edited · v2/);
    assert.match(noteHtml, /Not covered by SAS proof/);
  } finally {
    await server.close();
  }
});

test('leaderboard declares sample status and excludes money P&L framing', async () => {
  const server = await createServer({ root: appDir, server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { SocialLeaderboard } = await server.ssrLoadModule('/src/social/Social.tsx');
    const board = { source, period: '7D', rows: [{
      actorId: 'sample-actor', actorLabel: 'Sample Actor', closedCallCount: 2,
      meanReturnFraction: -0.1, rank: 1
    }] };
    const html = renderToStaticMarkup(React.createElement(SocialLeaderboard, { board, onOpenProfile: () => {} }));
    assert.match(html, /Leaderboard/);
    assert.match(html, /Synthetic examples/);
    assert.match(html, /Example wallets and results are fictional/);
    assert.match(html, /-10\.0%/);
    assert.match(html, /not money P&amp;L/);
  } finally {
    await server.close();
  }
});
