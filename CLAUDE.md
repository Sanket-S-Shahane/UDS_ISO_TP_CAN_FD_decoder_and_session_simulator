# Project rules for UDS Bench

Read this file first in every session. Then read `docs/SPEC.md`, `docs/TEST_VECTORS.md` and `PROMPT.md`.

## What we are building

A single-file, dependency-free browser tool: CAN/CAN FD log decoder (ISO-TP, UDS, OBD-II) plus a virtual ECU simulator.
It is a public tool of the Embedded Garage brand and also a portfolio piece, so quality and correctness matter more than
feature count.

## Hard rules

1. **Clean room.** Use only knowledge of the public standards (ISO 14229-1, ISO 15765-2, ISO 15031-5 / SAE J1979) and
   general engineering knowledge. Do not use, reproduce or imitate code, data dictionaries, DID lists, seed/key algorithms,
   message formats or naming from any employer, customer or OEM project. The simulator's security algorithm and data are
   made up (see the spec).
2. **Anonymous brand voice.** All public text (UI, README, docs, comments, commit messages) speaks as "we" / "Embedded
   Garage". No personal names, employer names, e-mail addresses or locations anywhere in the repository.
3. **Zero runtime dependencies.** Plain JavaScript (ES2020), plain CSS, no frameworks, no bundler, no npm packages. Tests
   use `node:test`. The build script is a small Node script with no dependencies. Fonts come from Google Fonts with
   system fallbacks; no other network requests.
4. **User text is untrusted.** Logs are pasted by users. Never put user-derived text into `innerHTML`; use `textContent`
   or DOM construction. The decoder must never throw on bad input: it reports problems instead.
5. **Comment style.** Comment every line of code with what it does and why (the owner's standing preference). Keep the
   comments short and accurate. Doc comments on every function. Do not leave dead code or TODO stubs.
6. **Accuracy over breadth.** If you are not sure of a table value, a bit position or a rule in the standard, mark the
   line with `// VERIFY` and list it in `docs/VERIFY.md` (item, what you assumed, why you are unsure). Do not invent values
   and do not claim compliance or certification anywhere.
7. **Never hide failures.** Run the tests before every commit. Do not delete or weaken a test to make it pass. If a test
   vector in `docs/TEST_VECTORS.md` looks wrong, say so in `docs/VERIFY.md` and explain; do not silently change it.

## Working rules

- Work in the phases defined in `PROMPT.md`. Commit and push at the end of every phase and keep `PROGRESS.md` current,
  because the cloud credit for these sessions expires and unpushed work is lost.
- When a requirement is ambiguous: if the owner is present, ask one short question; if the session is unattended, choose
  the most reasonable reading, record it in `docs/DECISIONS.md` (decision, alternatives, reason) and mention it in the
  final summary. Never guess silently.
- Keep files focused: `src/core.js`, `src/sim.js`, `src/ui.js`, `src/style.css`, `src/index.template.html`,
  `scripts/build.mjs`, `test/*.test.js`.
- Core and simulator must run under Node and in the browser unchanged: plain scripts that attach one global
  (`EGUDS`, `EGSIM`) and also `module.exports` it when `module` exists.
- Commit messages: imperative, one line summary, short body when useful.
