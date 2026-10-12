# R2 presets handoff

## Scope

- Kept all 15 stable `demo:market:<slug>` scenarios and their existing synthetic h/price anchors, call times, return calculations, gap, notes, profiles, and leaderboard behavior.
- Replaced fictional subject identities with 3 each of real public keywords, NASA videos, music tracks, music albums, and GitHub organization accounts. The subject's official destination, creator label, image URL, image alt, and image source URL are returned by `demoConsumerReadApi`.
- All activity remains `source.mode = DEMO`; subtitles, source label, and note prefix identify the histories and calls as fictional samples. Example actor labels and geometric SVG avatars make clear that no real subject owner or public figure made the sample calls.
- Added `SubjectImage({src?,alt,className?})` and `WalletAvatar({address,src?,className?})` in `apps/web/src/media/SubjectImage.tsx`. The former falls back to a neutral icon on missing, unsafe, or failed images; the latter generates a stable avatar when external imagery is absent or fails.
- See `contracts/fixtures/consumer/MEDIA_PROVENANCE.md` for subject and image sources. Images are referenced remotely; no third-party media files are stored in the repo.

## Verification

- `node --test apps/web/src/demo/consumerDemo.test.mjs`: 6/6 pass, including coverage for all 15 metadata mappings, internal consistency, demo-only IDs, notes, and avatars.
- `git -c core.whitespace=cr-at-eol diff --check` on tracked changes: pass.
- Web TypeScript build could not run in this clone: `npm ci --offline --ignore-scripts` failed when Windows denied creation of the `@ante-up/chain-client` local package symlink; joining a sibling dependency folder was likewise denied. No build or runtime claim is made.

## Integration notes

- UI may import both components from `apps/web/src/media/SubjectImage.tsx` and use `market.thumbnailUrl`, `market.imageAlt`, and `market.imageSourceUrl` for media plus attribution. `market.subjectUrl` is the official subject destination. `profile.avatarUrl` and `action.actorAvatarUrl` are locally generated SVG data URLs.
- The three YouTube thumbnail URLs are derived from video IDs on NASA's official pages; the Spotify art URLs and GitHub avatars are remote host assets. Image load depends on their hotlink policies. The fallback remains legible when they fail.
- Do not pass `demo:` IDs to chain or live execution controllers.
