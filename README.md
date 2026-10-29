# UDS Bench

A free, in-browser workbench for people who work with automotive diagnostics. Paste a CAN or CAN FD log and we decode it
through ISO-TP into UDS and OBD-II messages. Or run a virtual ECU, send it requests, and watch the frames it exchanges.

Built by **Embedded Garage**. Everything runs in your browser: nothing is uploaded.

## What it does

- **Decode.** Reads candump, candump `-L`, Vector ASC, plain `ID bytes` logs and raw UDS payloads. Reassembles ISO-TP
  (single, first, consecutive and flow-control frames, classic CAN and CAN FD) and decodes UDS (ISO 14229-1) and a
  common OBD-II (SAE J1979) subset. Bytes are coloured by role and every field is explained. Sequence errors, orphan
  frames and incomplete transfers are flagged.
- **Simulate.** A virtual ECU with diagnostic sessions, a session timeout, SecurityAccess with lockout, data identifiers,
  DTCs, routines and a download flow. Each exchange shows the ISO-TP frames on the bus and can be sent straight to the
  decoder.
- **Reference.** Service, NRC, ISO-TP and DTC-status tables for quick lookup.

## Status

Version 0.1, feature-complete against `docs/SPEC.md`: decoder, simulator, interface and build all work, and every test
vector passes (`npm test`). Some table rows are not yet checked against the current edition of the standards; they are
marked `// VERIFY` in the code and listed in `docs/VERIFY.md`. Choices the spec left open are in `docs/DECISIONS.md`,
and `PROGRESS.md` records what was checked and how.

## Examples

`examples/` holds three small logs that the Decode tab's example picker also offers: a basic classic-CAN session, a
CAN FD programming flow with multi-frame transfers, and a set of error cases (wrong key, unknown DID, sequence error,
overflow, invalid PCI, truncated and unknown payloads, a malformed line).

## How to use it

See [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) for what the tool is for and a walk-through of each tab.

## Run it

No dependencies. Node 20 or newer for the tests and the build script.

```
npm test          # unit tests (node:test)
npm run build     # writes dist/index.html, a single self-contained file
```

Open `dist/index.html` in a browser, or host the `dist` folder on any static host.

## Accuracy

Tables and behaviour come from the public ISO 14229-1, ISO 15765-2 and SAE J1979 documents. The simulated ECU is a
teaching model with made-up data and a made-up security algorithm; it is not any manufacturer's ECU. Check the current
standard before relying on a detail in a product.

## License

To be decided by the owner. Until then, all rights reserved.
