# R2 UI handoff

## Scope

- UI branch based on `9da25f7c86618e6db0298170001d6921c03879f9` (public snapshot `e5a8b70`).
- Unified Explore lists Devnet markets and 15 sample histories together, with row-level source labels and no global mode switch.
- Sample `demo:` routes keep the fixture read path and never mount wallet action or trading controls. Devnet routes retain existing execution logic and identity checks.
- Public chip terminology and orange action styling are applied to the UI files in this commit. The existing API and on-chain identifiers remain intact.
- Desktop and mobile navigation now expose Docs. `/docs` is a temporary placeholder in this branch because the Docs module is owned by the separate docs worker.

## Integration steps

1. Merge this commit, the presets/media commit, and Docs commit `1727b30` from `ante-up-r2-docs` into the integration branch.
2. In `apps/web/src/App.tsx`, import `DocsPage` from `./docs` and replace the `segment[0] === 'docs'` placeholder branch with `<DocsPage slug={segment[1] ? decodeRouteId(segment[1]) ?? undefined : undefined} />`.
3. Audit the separately owned `apps/web/src/charts/ConsumerChart.tsx` and `apps/web/src/social/Social.tsx` for remaining consumer-facing “call” terminology. These modules were intentionally left to their owners.
4. Run the web build and tests after merging. Check Explore, sample details, Docs, and mobile navigation once more with the final media assets.

## Verification

- `VITE_API_BASE_URL=/api npm --prefix apps/web run build`: passed on final UI files.
- `npm --prefix apps/web test`: 41 passed, 1 existing HTTP integration skip, 0 failed.
- Browser smoke test against a mocked Devnet market: 16 combined rows; with API failure, all 15 samples remain; no mode switch; sample detail has no execution tabs; Docs navigation reaches `/docs`; 390 px mobile viewport has no horizontal overflow; no page errors.
- No wallet signing, network transaction, public deployment, or push was performed.

## Notes

- The clone had many pre-existing unrelated modified files. Only explicit UI files and this handoff should be staged. Generated chain files, README, and other changes should remain unstaged.
- The sample dataset still has fictional titles in this branch. The presets/media worker owns its replacement.

## Follow-up: consumer copy and evidence disclosure

- Failed cover URLs are tracked by URL, so a changed cover can render after the previous one failed. The new regression test failed on the prior boolean behavior and passes after the fix.
- Formula/query data, record slot/index values, and proof identifiers are available in native, keyboard-accessible `details` sections. The default view presents the subject, chip action, and attention result first.
- Remaining legacy call phrases were removed from owned consumer UI copy. The brand slogan and internal `CALL_OPEN`/`CALL_CLOSE` IDs remain unchanged. A copy guard now checks the owned UI sources.
- Final follow-up checks: `VITE_API_BASE_URL=/api npm --prefix apps/web run build` passed; `npm --prefix apps/web test` passed with 43 pass, 1 existing skip, 0 fail.
- A local Playwright browser rerun could not start Chromium in this session (`exitCode=3221225506`), so the integration owner should recheck rendered disclosure behavior, selected note display, and media recovery on the final merged build. The earlier browser smoke test for the initial UI commit passed.
- Docs placeholder wiring and `SocialProfile` media/avatar wiring remain with the integration owner as assigned.
