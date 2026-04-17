# tokmon Cleanup Pass — Post-Review Polish

## Goal

Address the non-blocking reviewer suggestions from the Phase 1 project cost intelligence implementation, then rerun full validation.

## In scope

1. Remove dead code if confirmed unused:
   - `src/web/components/ProjectPie.tsx`
2. Deduplicate the duplicated `formatCompact` helper logic used by:
   - `src/web/App.tsx`
   - `src/web/components/ProjectDetailCard.tsx`
3. Deduplicate repeated E2E process helpers if low-risk and straightforward:
   - `waitForStdout`
   - `waitForExit`
4. Run full validation:
   - `npm run test:unit`
   - `npm run build`
   - `npm run test:e2e`

## Out of scope

- Any product behavior changes
- Refactoring unrelated code
- Reworking test structure beyond the repeated helper extraction
- Styling or copy changes

## Constraints

- Keep cleanup surgical
- Do not change API contracts or dashboard behavior
- If helper extraction for E2E becomes noisy or risky, prefer leaving tests as-is and report why

## Acceptance criteria

- `ProjectPie.tsx` is removed only if confirmed unused
- `formatCompact` exists in only one shared implementation location
- E2E helper duplication is reduced if that can be done cleanly
- All validation commands pass unchanged
