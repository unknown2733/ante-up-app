# R2 social handoff

## Scope and commit

- Clone: `ante-up-r2-social`; baseline `e5a8b70` plus contract `9da25f7`.
- Owned changes: `apps/web/src/social/Social.tsx`, `social.css`, `Social.test.mjs`.
- Public noreply author configured as `GsumLee <58336942+GsumLee@users.noreply.github.com>`.
- No App, contract, catalog, chart, proof, financial, vault, or other worker files were edited.

## UI delivered

- Leaderboard uses the current chip terms, avatar fallback, source and update time, 7 day/all time context, and a clear fictional example label. Return stays a percentage of valid closed chips; active and N/A chips are excluded.
- Public profile shows avatar, summary stats including Active chips, UTC day groups, actor/action/time, subject title and art fallback, action result including negative/N/A, a two-line note preview, expandable detail, chart link, and live record/proof link.
- Existing props and exports remain compatible. Optional `marketMedia` supplies subject title, subtitle, art URL, and alt text when the App integration has catalog metadata; `marketLabel` still works. Optional `avatarByActorId` supplies leaderboard avatars. Missing or failed media use generated initials and never imply a real person.
- The profile filters actions to its source mode. Live activity still admits only public chip open/close actions. Notes retain server timestamp, later/edited wording, and the SAS coverage caveat.
- The App currently passes `marketLabel`, so subject titles appear immediately. Artwork needs a later App integration to pass `marketMedia`; this clone did not modify App under its ownership boundary.

## Reference research

- [Fomo social features](https://fomo.family/blog/learn/leveraging-fomos-social-features) publicly describes an activity feed, profiles, and time-based leaderboards. I used the scannable feed/profile pattern, not its trading or money P&L claims.
- [Fomo web announcement](https://fomo.family/blog/announcing-fomo-web) describes contextual thesis, actor, and time on profile/coin pages.
- [Toss Securities official service page](https://toss.im/service/securities) confirms a community surface. [Toss Securities UX session](https://toss.im/tmc-25/sessions/design/ui-design-20) supports concise information hierarchy. Neither page exposes a current authenticated activity feed or exact mobile layout, so no precise Toss screen was copied.

## Verification and limits

- `npm --prefix apps/web run build`: passed; Vite transformed 327 modules.
- `node --test apps/web/src/social/Social.test.mjs`: 2 passed. Covers source separation, chip copy, negative/N/A results, synthetic attribution, and leaderboard disclosure.
- `git diff --check -- apps/web/src/social`: passed.
- Build dependencies were absent in this clone. Offline `npm ci` could not create the local package link and then lacked a cached package. Existing QA clone dependency files were copied into ignored `node_modules` inside this clone for build verification; no tracked dependency or lockfile was changed.
- The local preview server started at `http://127.0.0.1:5188/`. The Codex environment exposed no controllable browser tab, so 390px and desktop visual screenshots remain unverified. CSS has a mobile breakpoint at 620px, minimum 44px detail/chart/link targets, a 72px subject target, and wrapping for narrow text.

## Follow-up correction

- A `CALL_OPEN` row is a past placement event, not evidence of current active state. The row now shows `Placement`; its detail states that this event does not determine current status or final return. The aggregate `Active chips` stat still comes from `profile.openCallCount`. The regression fixture has Ava's open and close actions sharing a record with `openCallCount: 0`.
- The local avatar fallback generates a fixed geometric SVG from the wallet ID. Incoming `data:` URLs are not trusted or rendered; HTTPS and same-origin image URLs are allowed. The generated SVG remains visible as an image when a sample profile supplies its own generated data URL. `renderAvatar` and `renderSubjectImage` can be passed from App to use the presets-owned `WalletAvatar` and `SubjectImage` components after integration. Their prop shapes match those components; this branch has no import or cherry-pick from the presets branch.
- Live copy now says `Public Devnet chips` and removes `free call` and `Devnet calls` from social display text. The newer test renders both live and sample variants.
- Before the correction, the added tests failed on the active badge and legacy live copy; the failing SSR output also showed no avatar `img` for a generated data URL. After correction, `node --test apps/web/src/social/Social.test.mjs` passes all 5 tests, and `npm --prefix apps/web run build` passes.
