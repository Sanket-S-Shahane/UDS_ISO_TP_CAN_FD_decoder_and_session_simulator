# Progress

Updated at the end of every phase. Keep it honest: say what is finished, what is partly done and what is not started.

| Phase | State | Notes |
|---|---|---|
| 0 Setup | done | `scripts/build.mjs`, folders, test script (see DECISIONS D1) |
| 1 Core decoder | done | `src/core.js`, `test/core.test.js`; all vectors in TEST_VECTORS sections 1 to 4 pass |
| 2 ECU simulator | done | `src/sim.js`, `test/sim.test.js`; all flows in TEST_VECTORS section 5 pass |
| 3 Interface and build | done | `src/ui.js`, `src/style.css`, `src/index.template.html`, `dist/index.html` (209.8 KB); browser-checked |
| 4 Polish and hand-over | done | Accessibility and contrast pass, performance check, examples, README, VERIFY; pull request opened |

| 5 Cross-check against independent libraries | done | `tools/crosscheck/`, `docs/CROSSCHECK.md`; 3 bugs fixed with regression tests; VERIFY statuses updated |
| 6 Full-bus captures (Task A) | done | `stats.otherIds` / `otherIdsDecoded` in the core; info line with req/rsp buttons in Decode; new ID hint (DECISIONS D32-D34) |

## Last test run

`npm test` on Node 22.22.0: 101 tests, 101 pass, 0 fail (93 at the end of phase 4, 4 regression tests from the cross-check, 4 tests for the other-ID statistics). Includes the segment → reassemble property test (lengths 1..200,
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

## Polish checks (Phase 4)

- **Accessibility.** Tabs use `role="tablist"/"tab"/"tabpanel"`, roving tabindex, arrow/Home/End keys. Focus is visible
  everywhere (`:focus-visible` amber ring); a skip link is the first Tab stop. Byte chips are focusable and carry an
  `aria-label` with the hex value, field name and role; every field is also listed with its role name in the field
  table; directions, negative responses, errors, pending and partial messages carry text badges, so nothing depends on
  colour alone. Progress bars have `role="progressbar"` and a text value.
- **Contrast.** Every text token on bg, surface and raised surface: at least 4.82:1 (dark) and 4.60:1 (light); accent
  ink on accent 9.06:1 (dark) and 5.02:1 (light). See DECISIONS D28.
- **Performance.** `npm test` decodes 10,000 frames in well under 1 s (Node). In headless Chromium a 10,000-frame log
  decodes in 173 ms; the first chunk is on screen after about 200 ms and the 4,000 message rows plus the first 1,000
  timeline rows finish rendering in chunks (about 3.3 s) without blocking the page.
- **Size.** `dist/index.html` is 209.8 KB (budget 300 KB).
- **Repository scan.** No personal names, employer names or e-mail addresses in any file. Note for the owner: the two
  commits that were already on `main` before this work carry a personal author name and e-mail in their git metadata;
  we did not rewrite that history.

## Cross-check (phase 5)

Oracles: python-OBD 0.7.3, can-isotp 2.0.7, udsoncan 1.26.1, python-can 4.6.1 (all installed and imported; Python
3.13.17). Results per area are in `docs/CROSSCHECK.md`. Bugs found and fixed:

1. `reassemble()` accepted CAN FD frames whose length no DLC can express without any warning (now warns).
2. `reassemble()` gave no warning for a CAN FD Consecutive Frame shorter than the First Frame before the end of the
   message (classic CAN already had this warning; now both do).
3. ReadDTCInformation sub-functions 0x0F..0x13 had no names.

VERIFY table (`docs/VERIFY.md`): 11 rows confirmed by an oracle (markers removed), 9 rows where an oracle disagrees
(markers kept or added), 12 rows with no independent evidence. `dist/index.html` is 211.4 KB.

## Full-bus captures check (phase 6)

Headless Chromium (Playwright) on `dist/index.html` at 1280 × 820 and 400 × 860: the info line is hidden for the
bundled example; with a log of only non-standard IDs it lists 123 (3), 18FEF100 (2), 321 (1) with six buttons and the
summary keeps its 4 problems; with a mixed log it says the frames were skipped and the summary keeps 0 problems.
Pressing Enter on "req" for 123 and Space on "rsp" for 321 filled the boxes, re-decoded, hid the line and moved focus
to the filled box. No horizontal scroll at either width, no console errors or warnings.

## Push status

Write access was granted after phase 4; all work is pushed. The cross-check is on `claude/crosscheck-oracles`.
