# Testing

## Running tests

```bash
npm run test        # watch mode
npm run test -- --run   # single run (e.g. for CI)
```

## What’s covered

- **Unit tests**
  - `src/recable/mapping/eq.test.ts` — `centroidEqToMixerEq`, `getMixerMidEqParamPath` (mid freq → low-mid/high-mid, gain clamping).
  - `src/recable/mapping/gain.test.ts` — `centroidPreGainToMixerPreGain` (−8 dB offset, clamping).
  - `src/recable/tracing.test.ts` — `locationKey`, `locationMatches`, `serializedLocation`.
  - `src/recable/cables.test.ts` — `createCableIfSocketsFree` (success and “socket already used”).
- **Discovery**
  - `src/recable/discovery.test.ts` — `runDiscovery` returns an error when there are no mixer channels.

## Adding tests

- New unit tests: add a `*.test.ts` next to the module (e.g. `submixer.test.ts` in `src/recable/`).
- Discovery/plan tests: use a minimal mock `EntityQuery` (see `discovery.test.ts`) or a fixture-based mock that implements `getEntity`, `ofTypes(...).get()`, `pointingTo.locations(loc).get()`, etc.
- Fixture schema (for future “full project” tests): JSON with `entities` (id, entityType, fields) and `cables` (fromSocket, toSocket, colorIndex). Locations use `{ entityId, fieldIndex }`. See `docs/REFACTORING_PLAN.md` for the plan-then-execute pipeline and golden snapshot ideas.
