# Cross-checks against independent libraries (dev-only)

These scripts compare UDS Bench's `src/core.js` and `src/sim.js` with independent open-source implementations.
The libraries are used as oracles only: none of their code, docstrings or tables is copied into this repository.
`src/` never imports anything from here, and `npm test` / `npm run build` need nothing but Node.

Results and how each disagreement was resolved are in `docs/CROSSCHECK.md`.

## Setup

```
python3 -m venv .venv-crosscheck
.venv-crosscheck/bin/pip install -r tools/crosscheck/requirements.txt
```

Node 20 or newer must be on the `PATH` (the scripts call the core through `bridge.js`).

## Run

```
.venv-crosscheck/bin/python tools/crosscheck/check_obd.py     # 1. OBD-II PIDs, masks, DTC text (python-OBD)
.venv-crosscheck/bin/python tools/crosscheck/check_isotp.py   # 2. ISO-TP both ways (can-isotp); takes several minutes
.venv-crosscheck/bin/python tools/crosscheck/check_isotp_fuzz.py  # 2D. mutated frame sequences, both receivers
.venv-crosscheck/bin/python tools/crosscheck/check_uds.py     # 3. UDS encodings and names (udsoncan)
.venv-crosscheck/bin/python tools/crosscheck/check_logs.py    # 4. candump -L and Vector ASC parsing (python-can)
.venv-crosscheck/bin/python tools/crosscheck/check_sim.py     # 5. the virtual ECU driven by udsoncan's client
```

Each script prints the oracle versions, the number of cases and every mismatch, and exits non-zero when anything
disagrees. Inputs are generated with fixed random seeds; no vehicle data is used.

## Files

- `bridge.js`: runs a JSON batch of calls against the core in one Node process.
- `jsbridge.py`: Python side of the bridge, plus the oracle version report.
- `sim_server.js`: keeps one virtual ECU alive and answers one JSON request per line (used by `check_sim.py`).
- `tools_segment.py`: segments several payloads with our core in one call (used by the fuzz).
- `check_*.py`: one script per area.
