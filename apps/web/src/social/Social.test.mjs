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

test('live social views show wallet identities and records without fictional activity', async () => {
  const server = await createServer({ root: appDir, server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { SocialProfile, SocialLeaderboard } = await server.ssrLoadModule('/src/social/Social.tsx');
    const { WalletAvatar } = await server.ssrLoadModule('/src/media/SubjectImage.tsx');
    const actorId = '7YWHMfk9JZe0LM1gZeS7gH1Z7yx3Kts5GdkYZzHup7Cq';
    const liveSource = { ...source, mode: 'LIVE', label: 'Devnet indexer' };
    const profile = {
      actorId, actorLabel: 'Fictional celebrity', source: liveSource,
      closedCallCount: 1, openCallCount: 0, meanReturnFraction: 0.2,
      actions: [
        { ...action('real-close', 'CALL_CLOSE', Date.UTC(2026, 9, 12), 0.2), actorId, actorLabel: 'Invented trader', source: liveSource },
        action('sample-open', 'CALL_OPEN', Date.UTC(2026, 9, 12)),
        { ...action('other-wallet', 'CALL_OPEN', Date.UTC(2026, 9, 12)), source: liveSource },
        { ...action('unsupported-trade', 'BUY', Date.UTC(2026, 9, 12)), actorId, source: liveSource },
      ],
    };
    const html = renderToStaticMarkup(React.createElement(SocialProfile, { profile, onOpenMarket: () => {}, onOpenAction: () => {} }));
    const board = renderToStaticMarkup(React.createElement(SocialLeaderboard, { board: {
      source: liveSource, period: 'ALL', rows: [{ actorId, actorLabel: 'Fictional celebrity', rank: 1, closedCallCount: 1, meanReturnFraction: 0.2 }],
    }, onOpenProfile: () => {} }));
    assert.match(html, /1 event · newest first/);
    assert.match(html + board, /7YWHMfk…up7Cq/);
    assert.match(html + board, /Devnet records/);
    assert.doesNotMatch(html + board, /Sample history|fictional|Fictional|Invented trader|Placed a chip|Bought/);
    assert.match(html, /Wallet identicon for/);
    const supplied = renderToStaticMarkup(React.createElement(WalletAvatar, { address: actorId, src: 'https://example.com/actual-avatar.png' }));
    assert.match(supplied, /src="https:\/\/example.com\/actual-avatar.png"/);
    const fallback = renderToStaticMarkup(React.createElement(WalletAvatar, { address: actorId, src: 'javascript:alert(1)' }));
    assert.match(fallback, /Wallet identicon for/);
    assert.doesNotMatch(fallback, /javascript:/);
  } finally { await server.close(); }
});

test('reference sources cannot become Devnet rankings, activity, or writable notes', async () => {
  const server = await createServer({ root: appDir, server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { SocialProfile, SocialLeaderboard, SocialNoteEditor } = await server.ssrLoadModule('/src/social/Social.tsx');
    const referenceSource = { ...source, mode: 'REFERENCE' };
    const referenceAction = { ...action('reference-open', 'CALL_OPEN', Date.UTC(2026, 9, 12)), source: referenceSource };
    const html = renderToStaticMarkup(React.createElement(SocialProfile, {
      profile: { actorId: 'sample-actor', actorLabel: 'Sample Actor', source: referenceSource, closedCallCount: 2, openCallCount: 1, meanReturnFraction: 0.5, actions: [referenceAction] },
      onOpenMarket: () => {}, onOpenAction: () => {},
    }));
    const board = renderToStaticMarkup(React.createElement(SocialLeaderboard, {
      board: { source: referenceSource, period: 'ALL', rows: [{ actorId: 'sample-actor', actorLabel: 'Sample Actor', rank: 1, closedCallCount: 2, meanReturnFraction: 0.5 }] }, onOpenProfile: () => {},
    }));
    const editor = renderToStaticMarkup(React.createElement(SocialNoteEditor, { action: referenceAction, wallet: 'sample-actor', writer: { save: async () => { throw new Error('Must not write'); } } }));
    assert.match(html + board, /Reference subjects have no wallet/);
    assert.doesNotMatch(html + board, /Devnet records|Sample Actor|Placed a chip|50\.0%/);
    assert.equal(editor, '');
  } finally { await server.close(); }
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

test('a placed chip remains a past event when its record has closed', async () => {
  const server = await createServer({ root: appDir, server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { SocialProfile, actionDetailMessage } = await server.ssrLoadModule('/src/social/Social.tsx');
    const opened = { ...action('ava-open', 'CALL_OPEN', Date.UTC(2026, 9, 10, 8)), recordId: 'ava-record' };
    const closed = { ...action('ava-close', 'CALL_CLOSE', Date.UTC(2026, 9, 11, 8), 0.2), recordId: 'ava-record' };
    const profile = {
      actorId: 'demo:wallet:ava', actorLabel: 'Ava · sample wallet', source,
      avatarUrl: 'data:image/svg+xml,%3Csvg%3Euntrusted%3C%2Fsvg%3E',
      closedCallCount: 1, openCallCount: 0, meanReturnFraction: 0.2,
      actions: [opened, closed]
    };
    const html = renderToStaticMarkup(React.createElement(SocialProfile, {
      profile, onOpenMarket: () => {}, onOpenAction: () => {}
    }));
    assert.match(html, /Placed a chip/);
    assert.doesNotMatch(html, />Active chip<|This chip is active/);
    assert.match(html, /<dt>Active chips<\/dt><dd>0<\/dd>/);
    assert.match(html, /<img[^>]+src="data:image\/svg\+xml,/);
    assert.doesNotMatch(html, /untrusted/);
    assert.match(actionDetailMessage(opened), /does not determine current chip status or final return/);
    assert.doesNotMatch(actionDetailMessage(opened), /active/i);
  } finally {
    await server.close();
  }
});

test('live and sample leaderboards use chip language', async () => {
  const server = await createServer({ root: appDir, server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { SocialLeaderboard, SocialProfile } = await server.ssrLoadModule('/src/social/Social.tsx');
    const liveSource = { mode: 'LIVE', label: 'Devnet indexer', asOfMs: Date.UTC(2026, 9, 12) };
    const rows = [{ actorId: 'wallet-1', actorLabel: 'Wallet 1', closedCallCount: 1, meanReturnFraction: 0.1, rank: 1 }];
    for (const currentSource of [source, liveSource]) {
      const board = renderToStaticMarkup(React.createElement(SocialLeaderboard, { board: { source: currentSource, period: '7D', rows }, onOpenProfile: () => {} }));
      const profile = renderToStaticMarkup(React.createElement(SocialProfile, {
        profile: { actorId: 'wallet-1', actorLabel: 'Wallet 1', source: currentSource, closedCallCount: 1, openCallCount: 0, meanReturnFraction: 0.1, actions: [{ ...action('open-event', 'CALL_OPEN', Date.UTC(2026, 9, 10)), actorId: 'wallet-1', source: currentSource }] },
        onOpenMarket: () => {}, onOpenAction: () => {}
      }));
      assert.doesNotMatch(board + profile, /free call|Devnet calls/i);
      assert.match(board + profile, /Leaderboard|Active chips/);
      assert.match(profile, /Placed a chip/);
      assert.doesNotMatch(profile, />Active chip</);
    }
  } finally {
    await server.close();
  }
});

test('shared media renderers can be supplied without trusting arbitrary data URLs', async () => {
  const server = await createServer({ root: appDir, server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { SocialProfile } = await server.ssrLoadModule('/src/social/Social.tsx');
    const profile = {
      actorId: 'demo:wallet:ava', actorLabel: 'Ava', source,
      avatarUrl: 'data:image/png;base64,dGVzdA==',
      closedCallCount: 0, openCallCount: 0, meanReturnFraction: null,
      actions: [action('open', 'CALL_OPEN', Date.UTC(2026, 9, 10))]
    };
    const html = renderToStaticMarkup(React.createElement(SocialProfile, {
      profile, onOpenMarket: () => {}, onOpenAction: () => {},
      marketMedia: { 'market-1': { title: 'A subject', thumbnailUrl: '/media/subject.png' } },
      renderAvatar: ({ address, className }) => React.createElement('span', { className, 'data-address': address }, 'shared-avatar'),
      renderSubjectImage: ({ alt, className }) => React.createElement('span', { className, role: 'img', 'aria-label': alt }, 'shared-subject')
    }));
    assert.match(html, /shared-avatar/);
    assert.match(html, /shared-subject/);
    assert.match(html, /data-address="demo:wallet:ava"/);
    assert.doesNotMatch(html, /dGVzdA==/);
  } finally {
    await server.close();
  }
});
