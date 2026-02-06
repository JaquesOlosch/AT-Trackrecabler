# Track Recabler — Refactoring & Test Plan

This document describes the target state after refactoring, the test strategy (including “complete projects as tests”), and a phased implementation plan.

---

## 1. Goals

- **Maintainability:** Split the ~1,875-line `recable.ts` into focused modules with clear responsibilities.
- **Testability:** Maximize logic that can be unit-tested without the live Nexus SDK; support integration tests with document-like data.
- **Stability:** Introduce a **plan-then-execute** pipeline so we can test “what we would do” separately from “apply to document.”
- **Clarity:** Explicit types for discovery result, recable plan, and revert payload; minimal reliance on SDK internals (e.g. `_resolveField`) where avoidable.

---

## 2. Target Architecture (After Refactoring)

### 2.1 Directory Layout

```
src/
  recable/
    index.ts              # Public API: recableOldCentroidToMixer, revertRecable, types
    types.ts              # RecableResult, RevertPayload, SerializedLocation, RemovedCable, etc.
    discovery.ts          # Find centroid, cables, chain, submixer tree (read-only from entities)
    plan.ts               # Build RecablePlan from discovery result (what to remove/create)
    execute.ts            # Apply plan: phase remove → phase create (uses tx)
    revert.ts             # Revert using RevertPayload (uses tx)
    mapping/
      eq.ts               # centroidEqToMixerEq, EQ constants, getMixerMidEqParamPath
      gain.ts             # centroidPreGainToMixerPreGain, pre-gain constants
      automation.ts       # copyAutomationForChannel, copyAuxAutomationForChannel, copyAutomationBetweenLocations
    tracing.ts            # traceBackToCentroid, traceBackToSubmixer, traceForwardChain*, locationKey, locationMatches
    submixer.ts           # getSubmixerChannels, getSubmixerChannelRefs, getSubmixerAuxLocations, getChildSubmixers, buildSubmixerTreeAndOrder
    cables.ts             # createCableIfSocketsFree, collectAuxCables, wireAuxCables, getLocationFromEntity
    constants.ts           # SUBMIXER_ENTITY_TYPES, CHANNEL_ENTITY_TYPES, CENTROID_TO_MIXER_PARAM_MAP, etc.
  App.ts
  main.ts
  style.css
  ...
```

### 2.2 Data Flow

```
doc.modify(tx) {
  entities = tx.entities
  discoveryResult = runDiscovery(entities)     // pure read from entities
  if (!discoveryResult.ok) return error
  plan = buildPlan(entities, discoveryResult)  // pure: builds RecablePlan (no tx.create/remove)
  applyPlan(tx, entities, plan)                // mutates: tx.remove, tx.create
  return { ok, revertPayload, warnings }
}
```

- **Discovery** returns a single structure describing: last centroid, centroid channels, cables (with channel/submixer classification), chain from centroid to mixer, aux specs, submixer tree and specs. No document writes.
- **Plan** is a serializable (or at least inspectable) description: which cables to remove (with serialized from/to), which channels/groups/auxes/cables to create and how they connect. Optional: store “expected” new entity counts and key relationships for tests.
- **Execute** takes `(tx, entities, plan)` and performs the two phases (remove all listed cables, then create all new entities and cables). All `tx.create`/`tx.remove` live in this layer (and in `revert.ts` for undo).

### 2.3 New / Explicit Types

- **`DiscoveryResult`**  
  - `ok: true` → `{ lastCentroid, centroidChannels, cablesWithChannel, directCables, submixerCableMap, chain, auxSpecByKey, submixerTreeAndSpecs, centroidAuxReturnLocs, ... }`  
  - `ok: false` → `{ error: string }`

- **`RecablePlan`**  
  - `cablesToRemove: NexusEntity<"desktopAudioCable">[]` (or their ids + serialized locations for revert)  
  - `revertPayload: RevertPayload` (filled during planning with `removed*` lists; `created*` lists filled during execute)  
  - Specs for: direct channels to create, master chain, centroid auxes, submixer groups (channels, chain, auxes, aux-chain-end cables).  
  Plan is the single source of truth for “what execute will do.”

- **`RecableResult`** (existing)  
  - Unchanged from current; still returned from `recableOldCentroidToMixer`.  
  - `revertPayload` is completed by execute (all `created*` ids).

Discovery and plan building should use only `EntityQuery` and plain data (locations, entities). Execute and revert use `tx` and `entities`.

---

## 3. Test Strategy

### 3.1 Recommended Mix: Unit + Plan Snapshot + Execution Snapshot

- **Unit tests:** Pure functions and discovery/plan logic against in-memory or mock data (no real `SyncedDocument`).
- **Plan tests (integration-style):** Run discovery + plan on **fixture documents** (see below); assert shape and key contents of `RecablePlan` (and discovery). Optionally snapshot “expected plan” for regression.
- **Execution tests (integration-style):** Run execute with a **recording tx** (mock that records every `create`/`remove`). Compare recorded operations to a **golden list** (e.g. expected entity types and key props). No need for a real backend.
- **Optional E2E:** If the Nexus SDK or Audiotool provides a way to open a test project (e.g. by ID or JSON), one or two “full recable on real project” tests can validate end-to-end; not required for the core refactor.

This gives “complete projects as tests” by treating **fixture = one complete project state (before recable)** and **expected = discovery + plan + execution log (or after state)**.

### 3.2 Fixture Documents (“Complete Projects as Tests”)

- **Location:** `tests/fixtures/` or `src/recable/__tests__/fixtures/`.
- **Format:** JSON files describing a minimal but **complete** old-style project:
  - Entities needed for: one mixer master, one mixer channel (fed by centroid), one centroid, N centroid channels, cables from instruments/devices (or submixers) into centroid channel inputs, optional chain (centroid → device → mixer), optional aux send/return.
  - Stored as **entity list + cable list** (each cable: fromSocket, toSocket, colorIndex), using serializable location form `{ entityId, fieldIndex }`.
- **Purpose:**
  - **Discovery + plan:** Provide a **mock EntityQuery** that answers `getEntity(id)`, `ofTypes(...).get()`, `pointingTo.locations(loc).get()`, etc. from the fixture. Run `runDiscovery(entities)` then `buildPlan(entities, discoveryResult)`. Assert discovery (e.g. last centroid id, number of cables) and plan (e.g. number of cables to remove, number of channels to create).
  - **Execute:** Use a **recording tx** that implements `create(type, props)` (returns fake ids) and `remove(entity)`. Run `applyPlan(recordingTx, entities, plan)`. Assert:
    - Order: all removes before any create.
    - Counts: e.g. N `remove("desktopAudioCable")`, M `create("mixerChannel")`, etc.
    - Key operations: e.g. one cable from instrument to new mixer channel, one cable from centroid output to new “sum” channel, etc.
- **Golden files (optional):** Store “expected plan” or “expected execution log” as JSON next to the fixture; tests diff against it for regression. Update goldens when behavior is intentionally changed.

### 3.3 Unit Tests (What to Test)

- **`mapping/eq.ts`:** `centroidEqToMixerEq` for known inputs (e.g. mid freq in low-mid vs high-mid range, clamping). `getMixerMidEqParamPath` for given centroid channel.
- **`mapping/gain.ts`:** `centroidPreGainToMixerPreGain` (e.g. −8 dB offset, clamping to mixer range).
- **`tracing.ts`:** `locationKey`, `locationMatches`; `traceBackToCentroid` / `traceBackToSubmixer` on a small graph (mock entities + cables).
- **`constants.ts`:** No logic; optionally re-export and smoke-test that param map keys match expected centroid field names.
- **`submixer.ts`:** `buildSubmixerTreeAndOrder` with a small set of “submixers” and child relationships; assert topo order and that every submixer appears.
- **`cables.ts`:** `createCableIfSocketsFree` with a mock `tx` and sets of used sockets; assert id returned or null and warnings when socket already used.

Automation copy functions are harder to unit-test without a rich mock (many entity types); keep them in `execute` and cover them via **execution snapshot** tests that include automation in the fixture and assert creation of automation tracks/regions/events.

### 3.4 Test Runner and Mock EntityQuery

- **Runner:** Use **Vitest** (fits Vite, fast, ESM, good for both unit and integration-style tests). Add `vitest` as devDependency; config in `vitest.config.ts` (or inside `vite.config.ts`).
- **Mock EntityQuery:** Implement a minimal in-memory `EntityQuery`:
  - Store entities in a `Map<string, Entity>` and cables in a list.
  - `getEntity(id)` → map lookup.
  - `ofTypes("mixerChannel").get()` → filter by entityType.
  - `pointingTo.locations(loc).get()` → cables whose `toSocket` matches `loc` (and similarly for `pointingTo.entities(id)`).
  - Build this from fixture JSON so each test loads e.g. `fixtures/minimal-old-project.json` and gets a consistent graph.

### 3.5 Summary Recommendation

- **Unit:** Pure mapping and tracing + small, controlled mocks; no document.
- **Integration-style (plan):** Fixture = full project state (entities + cables). Mock EntityQuery from fixture → run discovery → run plan → assert discovery + plan shape (and optionally golden snapshot).
- **Integration-style (execute):** Same fixture + plan; execute with recording tx → assert removal count, creation counts by type, and key operations (or golden execution log).
- **E2E:** Optional later; not in scope for this refactor.

---

## 4. Implementation Phases

### Phase 1: Test Setup and Fixtures (no refactor yet)

1. Add Vitest: `npm i -D vitest`, configure `vitest.config.ts` (include `src/**/*.ts`, exclude app entry if needed), add script `"test": "vitest"`.
2. Define a **minimal fixture** (one JSON file): one mixer master, one mixer channel, one centroid, two centroid channels, two cables from “instrument” entities into the two centroid channels, one cable from centroid output to mixer channel. Document the schema (entity types, required fields for discovery).
3. Implement **MockEntityQuery** (and optionally a loader from fixture JSON) in `tests/helpers/mockEntityQuery.ts` (or under `src/recable/__tests__/`).
4. Add one **discovery unit test**: load fixture, run current discovery logic (extracted to a function that takes `entities` only) and assert “last centroid” id and “2 cables feeding centroid channels.” This may require temporarily exporting or copying discovery steps into a testable function.

### Phase 2: Extract Types and Constants

1. Create `src/recable/types.ts`: move `RecableResult`, `RevertPayload`, `SerializedLocation`, `RemovedCable` and any other public or shared types.
2. Create `src/recable/constants.ts`: move `SUBMIXER_ENTITY_TYPES`, `CHANNEL_ENTITY_TYPES`, EQ/gain constants, `CENTROID_TO_MIXER_PARAM_MAP`, `SUBMIXER_AUX_KEYS`.
3. Update `recable.ts` to import from these; run existing app and ensure behavior unchanged. No new tests yet beyond “build passes.”

### Phase 3: Extract Pure / Read-Only Logic

1. **`tracing.ts`:** Move `locationKey`, `locationMatches`, `serializedLocation`, `traceBackToSubmixer`, `traceBackToCentroid`, `traceForwardChainFromCentroid`, `traceForwardChainFromSubmixer`, `traceAuxChainExits`. Depend only on `EntityQuery` and types.
2. **`mapping/eq.ts`** and **`mapping/gain.ts`:** Move EQ and pre-gain functions; depend only on entity fields and constants.
3. **`submixer.ts`:** Move `getSubmixerChannels`, `getSubmixerChannelRefs`, `getSubmixerAuxLocations`, `getCentroidAuxLocations`, `getSubmixerOutputLocation`, `getChildSubmixers`, `buildSubmixerTreeAndOrder`, `getCentroidAuxSendGain`, `getSubmixerAuxLocations` (and any other submixer helpers).
4. **`cables.ts`:** Move `createCableIfSocketsFree`, `collectAuxCables`, `wireAuxCables`, `getLocationFromEntity`. Keep `getLocationFromEntity` behind an abstraction if it uses `_resolveField` (so we can replace with a proper API later).
5. Add **unit tests** for: `locationKey` / `locationMatches`, `centroidEqToMixerEq`, `centroidPreGainToMixerPreGain`, and one tracing test with mock entities.

### Phase 4: Discovery Module

1. Define **`DiscoveryResult`** in `types.ts`.
2. Create **`discovery.ts`**: single entry e.g. `runDiscovery(entities: EntityQuery): DiscoveryResult`. Move all “read-only” steps from the current `doc.modify` callback (find mixer channels, trace to centroid, get centroid channels, collect cables, partition direct vs submixer, build submixer tree, collect chain/aux specs) into this function. It must not call `tx.create` or `tx.remove`.
3. From the main recable flow, call `runDiscovery(tx.entities)` and handle `!discoveryResult.ok`. Add a **plan test** that runs `runDiscovery` on the minimal fixture and asserts `ok`, lastCentroid id, and cable counts.

### Phase 5: Plan Module

1. Define **`RecablePlan`** in `types.ts`: cables to remove (and their serialized form for revert), revert payload skeleton (removed* filled; created* empty), and structured specs for direct channels, master chain, auxes, submixer groups.
2. Create **`plan.ts`**: `buildPlan(entities: EntityQuery, discovery: DiscoveryResult): RecablePlan`. Move all logic that currently builds `revertPayload.removed*`, `submixerSpecBySubmixerId`, `masterChainSpec`, `auxSpecByKey`, and the list of cables to remove into this function. Output is a plan only; no `tx` usage.
3. Main recable flow: after discovery, call `buildPlan(entities, discoveryResult)` and pass the plan to execute. Add a test: run discovery + buildPlan on fixture, assert plan has expected number of `removedChannelCables`, and (if applicable) expected structure for one submixer.

### Phase 6: Execute and Revert Modules

1. Create **`execute.ts`**: `applyPlan(tx, entities, plan)` (and possibly `warnings: string[]`). Phase 2: remove every cable in `plan.cablesToRemove`. Phase 3: create all new mixer channels, groups, auxes, cables, automation (using existing helper logic). Push all created ids into `plan.revertPayload.created*`. Move automation helpers into `mapping/automation.ts` and call from execute.
2. Create **`revert.ts`**: move `revertRecable` implementation; it should only remove created entities and recreate cables from `RevertPayload`, using `getLocationFromEntity` for resolve.
3. Main recable flow: inside `doc.modify`, run `runDiscovery` → `buildPlan` → `applyPlan`; return `RecableResult` with the completed `revertPayload` and warnings.
4. Add **execution test**: with fixture + plan, run `applyPlan(recordingTx, entities, plan)` and assert remove-count, create-counts by entity type, and at least one expected cable create (e.g. instrument → new mixer channel).

### Phase 7: Fixture-Based “Full Project” Tests and Goldens

1. Add one or two more fixtures (e.g. with aux send/return, or one submixer) and document the “expected” outcome (number of new channels, number of auxes, etc.).
2. Implement **golden snapshot** (optional): write `plan` or execution log to a file in the test run; first run generates the file, subsequent runs diff. Use Vitest snapshots or a custom “golden file” helper.
3. Document in README or `docs/TESTING.md` how to add a new fixture and update goldens.

### Phase 8: Cleanup and Docs

1. **`recable/index.ts`:** Re-export public API (`recableOldCentroidToMixer`, `revertRecable`, `RecableResult`, `RevertPayload`). Ensure `App.ts` imports from `./recable` only.
2. Remove or slim down the old `recable.ts` (all logic now in modules). Run full test suite and manual smoke test (login, connect, recable, undo).
3. Add a short **Testing** section to README: how to run tests, what unit vs fixture tests cover, and how to add fixtures.
4. Optionally add CI step: run `npm run test` in the deploy workflow (or a separate “test” job).

---

## 5. Definition of Done (After Refactoring)

- **Structure:** Recable logic lives under `src/recable/` in the modules listed in §2.1. No single file &gt; ~400 lines. Public API is `recable/index.ts`.
- **Behavior:** No change in user-observable behavior: same recable and undo results on the same project; same error messages for “no mixer channels,” “no centroid,” “no cables.”
- **Tests:**  
  - Unit tests for EQ mapping, gain mapping, location helpers, and at least one tracing/submixer test with mock data.  
  - At least one fixture-based test: load minimal old-style project → discovery → plan; assert discovery and plan shape.  
  - At least one execution test: plan + recording tx → assert remove/create counts and one key operation.
- **Docs:** This plan lives in `docs/REFACTORING_PLAN.md`; README has a Testing subsection; optional `docs/TESTING.md` for fixture schema and golden updates.
- **CI:** `npm run test` passes; optional: add test job to GitHub Actions.

---

## 6. Risks and Mitigations

- **SDK dependency:** `getLocationFromEntity` uses `_resolveField`. Mitigation: keep it in one place (`cables.ts`); if SDK adds a public resolver, swap implementation; tests use mock that doesn’t rely on it for fixture-based runs.
- **Regressions:** Mitigation: fixture tests lock “before → plan → execution log”; manual smoke test before release.
- **Fixture maintenance:** Fixture JSON may need to follow Nexus document shape. Mitigation: document schema; keep fixtures minimal; use golden only for execution log if plan shape changes often.

---

## 7. File Checklist (Target State)

| File | Purpose |
|------|--------|
| `src/recable/index.ts` | Public API |
| `src/recable/types.ts` | RecableResult, RevertPayload, DiscoveryResult, RecablePlan, SerializedLocation, RemovedCable |
| `src/recable/constants.ts` | Entity type sets, EQ/gain constants, param map |
| `src/recable/discovery.ts` | runDiscovery(entities) → DiscoveryResult |
| `src/recable/plan.ts` | buildPlan(entities, discovery) → RecablePlan |
| `src/recable/execute.ts` | applyPlan(tx, entities, plan) |
| `src/recable/revert.ts` | revertRecable(doc, payload) |
| `src/recable/tracing.ts` | Trace and location helpers |
| `src/recable/submixer.ts` | Submixer channel/aux/tree helpers |
| `src/recable/cables.ts` | Cable create/collect/wire, getLocationFromEntity |
| `src/recable/mapping/eq.ts` | Centroid EQ → mixer EQ |
| `src/recable/mapping/gain.ts` | Pre-gain mapping |
| `src/recable/mapping/automation.ts` | Copy automation (channel, aux, between locations) |
| `tests/` or `src/recable/__tests__/` | Unit + fixture tests |
| `tests/fixtures/*.json` | Minimal old-style project(s) |
| `tests/helpers/mockEntityQuery.ts` | In-memory EntityQuery from fixture |
| `vitest.config.ts` | Test config |
| `docs/REFACTORING_PLAN.md` | This document |
