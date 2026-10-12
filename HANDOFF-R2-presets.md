# R2 presets handoff

## Scope

- Kept all 15 stable `demo:market:<slug>` scenarios and their existing synthetic h/price anchors, call times, return calculations, gap, profiles, and leaderboard behavior. Note text now matches the real subject identities and modeled trajectories.
- Replaced fictional subject identities with 3 each of real public keywords, NASA videos, music tracks, music albums, and GitHub organization accounts. The subject's official destination, creator label, image URL, image alt, and image source URL are returned by `demoConsumerReadApi`.
- All activity remains `source.mode = DEMO`; subtitles, source label, and each note's sample/model wording identify the histories and calls as fictional samples. Example actor labels and geometric SVG avatars make clear that no real subject owner or public figure made the sample calls.
- Added `SubjectImage({src?,alt,className?})` and `WalletAvatar({address,src?,className?})` in `apps/web/src/media/SubjectImage.tsx`. The former falls back to a neutral icon on missing, unsafe, or failed images; the latter generates a stable avatar when external imagery is absent or fails.
- See `contracts/fixtures/consumer/MEDIA_PROVENANCE.md` for subject and image sources. Images are referenced remotely; no third-party media files are stored in the repo.

## Verification

- `node --test apps/web/src/demo/consumerDemo.test.mjs`: 9/9 pass, including coverage for all 15 metadata mappings, internal consistency, demo-only IDs, subject-aligned fictional notes, compact display labels, NASA image dimensions, and safe avatar sources.
- The new narrative and NASA image-size regressions failed before correction (old Aurora launch-post note and 6927-pixel image request), then passed after correction. TypeScript's `transpileModule` parsed all four changed TS/TSX source files without syntax errors.
- `git -c core.whitespace=cr-at-eol diff --check` on tracked changes: pass.
- Web TypeScript build could not run in this clone: `npm ci --offline --ignore-scripts` failed when Windows denied creation of the `@ante-up/chain-client` local package symlink; joining a sibling dependency folder was likewise denied. No build or runtime claim is made.

## Integration notes

- UI may import both components from `apps/web/src/media/SubjectImage.tsx` and use `market.thumbnailUrl`, `market.imageAlt`, and `market.imageSourceUrl` for media plus attribution. `market.subjectUrl` is the official subject destination. `profile.avatarUrl` and `action.actorAvatarUrl` are locally generated SVG data URLs.
- The three YouTube thumbnail URLs are derived from video IDs on NASA's official pages; the Spotify art URLs and GitHub avatars are remote host assets. Image load depends on their hotlink policies. The fallback remains legible when they fail.
- Do not pass `demo:` IDs to chain or live execution controllers.

## Follow-up correction

- Rewrote every sample note to refer to its current real subject and modeled trajectory. The previous fictional-subject phrases (builders, clip remixes, playlists, release-week reviews, newsletter issues) are gone. Closed notes now describe the modeled index at their own call exit; no note reports real-world subject activity.
- Display labels are `Attention index`, `Sample price`, and `sample units`. `source.mode = DEMO` and the source label continue to mark every series as fictional generated data.
- `SubjectImage` fallback uses the established off-white, ink, and orange tokens. `WalletAvatar` accepts an actor's exact generated SVG data URL along with HTTPS or same-origin URLs; other data or executable schemes fall back to a generated avatar.
- NASA keyword thumbnails request 720×480 derivatives. The official image pages and NASA dynamic-image query format were checked, but direct derivative response was unavailable because this sandbox could not resolve `assets.science.nasa.gov`.
