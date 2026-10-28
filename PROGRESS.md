# Progress

Updated at the end of every phase. Keep it honest: say what is finished, what is partly done and what is not started.

| Phase | State | Notes |
|---|---|---|
| 0 Setup | done | `scripts/build.mjs`, folders, test script (see DECISIONS D1) |
| 1 Core decoder | done | `src/core.js`, `test/core.test.js`; all vectors in TEST_VECTORS sections 1 to 4 pass |
| 2 ECU simulator | done | `src/sim.js`, `test/sim.test.js`; all flows in TEST_VECTORS section 5 pass |
| 3 Interface and build | done | `src/ui.js`, `src/style.css`, `src/index.template.html`, `dist/index.html` (209.8 KB); browser-checked |
| 4 Polish and hand-over | not started | |

## Last test run

`npm test` on Node 22.22.0: 93 tests, 93 pass, 0 fail. Includes the segment → reassemble property test (lengths 1..200,
4095, 4096, 5000 × classic/FD 8/12/64 × normal/extended × padding off/0xAA), fuzz tests (20,000 random payloads,
5,000 random logs and frames) and a 10,000-frame performance test. Simulator tests cover every flow in section 5, decode the exchange driver's
frames back with the core in four framings, and fuzz the ECU with 20,000 random requests.

## Browser check (Phase 3)

Automated with the pre-installed headless Chromium (Playwright) against `dist/index.html` opened from disk, at
1280 × 900 and 400 × 860, each in the dark and the light colour scheme (4 runs). Google Fonts requests were answered
with an empty stylesheet so the run works offline. Every run checked:

- the page opens with the basic example decoded (29 frames, 19 messages, 0 problems);
- expanding a message shows 20 byte chips; clicking a timeline row opens and scrolls to its message;
- the error example reports 8 problems and 1 ignored line;
- arrow-key tab navigation switches to `#simulate`; the full programming flow (10 02, 27 01, 27 02 + key, 31 01 FF00,
  34, 36 ×2, 37) plus a VIN read and a typed request produce 10 exchange cards and the status panel shows the
  programming session, unlocked, flash programmed;
- "Open in Decode" decodes the simulator's 67 frames into 22 messages with 0 problems;
- the Reference tab renders 7 tables;
- `document.documentElement.scrollWidth − clientWidth` is 0 on every tab, including with a message expanded
  (no horizontal page scroll at 400 px);
- no console errors or warnings, no page errors; the only external host requested is fonts.googleapis.com.

Screenshots were reviewed by eye for the desktop decode view and the phone simulate and decode views.

## Push status

The GitHub integration for this session has read access only: `git push` and the GitHub API both return 403
("Resource not accessible by integration"). Commits are made locally on `claude/uds-bench-implementation-teypud` and
must be pushed once write access is granted.
