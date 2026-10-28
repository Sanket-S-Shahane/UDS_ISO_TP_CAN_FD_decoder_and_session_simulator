# Progress

Updated at the end of every phase. Keep it honest: say what is finished, what is partly done and what is not started.

| Phase | State | Notes |
|---|---|---|
| 0 Setup | done | `scripts/build.mjs`, folders, test script (see DECISIONS D1) |
| 1 Core decoder | done | `src/core.js`, `test/core.test.js`; all vectors in TEST_VECTORS sections 1 to 4 pass |
| 2 ECU simulator | done | `src/sim.js`, `test/sim.test.js`; all flows in TEST_VECTORS section 5 pass |
| 3 Interface and build | not started | |
| 4 Polish and hand-over | not started | |

## Last test run

`npm test` on Node 22.22.0: 93 tests, 93 pass, 0 fail. Includes the segment → reassemble property test (lengths 1..200,
4095, 4096, 5000 × classic/FD 8/12/64 × normal/extended × padding off/0xAA), fuzz tests (20,000 random payloads,
5,000 random logs and frames) and a 10,000-frame performance test. Simulator tests cover every flow in section 5, decode the exchange driver's
frames back with the core in four framings, and fuzz the ECU with 20,000 random requests.

## Push status

The GitHub integration for this session has read access only: `git push` and the GitHub API both return 403
("Resource not accessible by integration"). Commits are made locally on `claude/uds-bench-implementation-teypud` and
must be pushed once write access is granted.
