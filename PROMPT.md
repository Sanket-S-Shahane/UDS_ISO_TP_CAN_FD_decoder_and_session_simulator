# Build prompt for the cloud coding session

Paste the short prompt from the first section into the session. Everything detailed lives in the repository.

## Short prompt (paste this)

```
You are building UDS Bench in this repository. Read CLAUDE.md first, then docs/SPEC.md, docs/TEST_VECTORS.md and
PROMPT.md, and carry out the phases in PROMPT.md in order. Follow the hard rules in CLAUDE.md exactly.
After each phase: run the tests, update PROGRESS.md, commit, push. Do not skip tests. Do not stop after Phase 1.
Our cloud credit expires on 5 Nov 2026 13:29 IST, so finish Phases 1 to 3 first, polish second. If you reach a decision
the spec does not cover, record it in docs/DECISIONS.md and continue. Finish by opening a pull request into main and
summarising: what works, what is marked VERIFY, and what you would do next.
```

## Phases

### Phase 0: setup (small)
- Create `package.json` scripts if missing (`test`: `node --test test/`, `build`: `node scripts/build.mjs`), `PROGRESS.md`,
  `docs/DECISIONS.md`, `docs/VERIFY.md`, and the folders in the spec.
- Write `scripts/build.mjs`: reads `src/index.template.html`, inlines `src/style.css`, `src/core.js`, `src/sim.js`,
  `src/ui.js` into one file, writes `dist/index.html`. It must fail loudly if an input is missing.

### Phase 1: core decoder
Implement `src/core.js` exactly as the spec's sections 3 to 7 describe, with `test/core.test.js`.
Done when: every vector in `docs/TEST_VECTORS.md` sections 1 to 4 passes; segmentation → reassembly round-trips for all
combinations listed in the spec; garbage input never throws; `npm test` is green. Commit: "Add core decoder".

### Phase 2: ECU simulator
Implement `src/sim.js` as spec section 8 describes, with `test/sim.test.js`.
Done when: every vector in `docs/TEST_VECTORS.md` section 5 passes, including the full programming flow, the lockout, the
S3 timeout and functional addressing; the exchange driver's frames decode back to the same messages with the core.
Commit: "Add virtual ECU simulator".

### Phase 3: interface and build
Implement `src/ui.js`, `src/style.css`, `src/index.template.html` as spec sections 9 and 10 describe.
Done when: `npm run build` produces `dist/index.html`; the page loads with the example log already decoded; all three tabs
work; there are no console errors; the layout works at 400 px width with no horizontal page scroll; a screenshot or
automated browser check at desktop and phone width is described in `PROGRESS.md` (use whatever headless browser the
environment offers; if none, say so). Commit: "Add interface and build script".

### Phase 4: polish and hand-over
- Accessibility pass: keyboard focus visible, tabs are real tabs with ARIA roles, colour contrast checked in both themes,
  chips never rely on colour alone (each field also has its text label).
- Performance: decoding a 10,000-frame log takes under one second; large logs render in chunks.
- Fill `docs/VERIFY.md` honestly. Update `README.md` status. Add `examples/` with three small logs (basic session,
  CAN FD multi-frame, error cases) and make the UI's example picker use the same content.
- Open a pull request into `main`.
Commit: "Polish, examples and docs".

## If you run low on credit
Stop adding features. Make sure the tests pass, the build works, `PROGRESS.md` says exactly what is finished and what is
not, push, and open the pull request.
