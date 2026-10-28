# Progress

Updated at the end of every phase. Keep it honest: say what is finished, what is partly done and what is not started.

| Phase | State | Notes |
|---|---|---|
| 0 Setup | done | `scripts/build.mjs`, folders, test script (see DECISIONS D1) |
| 1 Core decoder | done | `src/core.js`, `test/core.test.js`; all vectors in TEST_VECTORS sections 1 to 4 pass |
| 2 ECU simulator | not started | |
| 3 Interface and build | not started | |
| 4 Polish and hand-over | not started | |

## Last test run

`npm test` on Node 22.22.0: 67 tests, 67 pass, 0 fail. Includes the segment → reassemble property test (lengths 1..200,
4095, 4096, 5000 × classic/FD 8/12/64 × normal/extended × padding off/0xAA), fuzz tests (20,000 random payloads,
5,000 random logs and frames) and a 10,000-frame performance test.
