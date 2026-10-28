# Cross-check against independent implementations

We compared UDS Bench with independent open-source libraries, used as oracles. A library agreeing with us is evidence,
not the standard: two implementations can share the same misreading. Nothing here is a claim of compliance.

Scripts: `tools/crosscheck/` (see its README). Inputs are generated with fixed seeds; no real vehicle data.

## Oracle versions

| Package | Import | Version | Status |
|---|---|---|---|
| can-isotp | `isotp` | 2.0.7 | installed, imported |
| udsoncan | `udsoncan` | 1.26.1 | installed, imported |
| python-can | `can` | 4.6.1 | installed, imported |
| obd (python-OBD) | `obd` | 0.7.3 | installed, imported |

Python 3.13.17, Node 22.22.0.

## 1. OBD-II (python-OBD 0.7.3) — `check_obd.py`

How: each SPEC section 7 PID was decoded by `decodeUds([0x41, pid, ...])` and by the python-OBD command's own decoder
function (`obd.commands[1][pid].decode`), called directly with stand-in message objects (no adapter or ECU).

| Area | Cases | Mismatches |
|---|---|---|
| PID formulas 04 05 0C 0D 0F 10 11 1F 2F 42 46 5C (1-byte PIDs exhaustive; 2-byte PIDs 36 edge pairs + 20,000 random) | 82,192 | 0 |
| Supported-PID masks 00 / 20 / 40 / 60 (5 edge masks + 5,000 random each) | 20,020 | 0 |
| 2-byte DTC text, all 65,536 byte pairs | 65,536 | 0 |
| Mode 03 responses (count byte + 0..6 DTCs, 3,000 random) | 3,000 | 0 |

Notes:
- **Rounding.** Our text keeps 1 decimal for percentages, 2 for rpm and MAF, 3 for volts. The comparison allows exactly
  that display rounding (half a unit of the last kept decimal); everything else had to match exactly.
- **Masks.** python-OBD 0.7.3 has no Mode 01 command for PID 60, so for all four masks we called its `pid` mask decoder
  (the one its PID 00/20/40 commands use) and mapped bit *i* to PID `base + i + 1`, as its connection code does.
- **DTC `00 00`.** python-OBD drops this pair as padding; we print `P0000`. Classified as a **behaviour difference,
  not a bug**: on CAN, Mode 03/07/0A responses carry a count byte, so a `00 00` pair inside the counted list is data.
  Not changed.
- **Case.** python-OBD prints the hex digits of a DTC in lower case (`p0a1b`); we print upper case, as SAE J2012 codes
  are written. Compared case-insensitively.

Result: **no bugs found**.

## 2. ISO-TP (can-isotp 2.0.7) — `check_isotp.py`, `check_isotp_fuzz.py`

How: can-isotp's `TransportLayerLogic` (the non-threaded core that `isotp.TransportLayer` wraps; no sockets) was wired
to in-memory queues. Payload lengths: every length 1..300, 300 random lengths up to 4093, then 4094, 4095 and the
escaped 32-bit lengths 4096, 5000 and 20000 (the library supports the escape). Frame sizes: classic CAN, and CAN FD with
8, 12, 16, 20, 24, 32, 48 and 64 bytes. Normal and extended addressing (address byte `F1`); padding off and `0xAA`.
That is 605 lengths × 9 frame sizes × 2 addressing modes × 2 paddings = **21,780 combinations**, each checked three ways.

| Direction | Cases | Result |
|---|---|---|
| A. our `segment()` vs its sender (it was answered with a Flow Control, BS 0, STmin 0) | 21,780 | 19,472 byte-identical; 2,308 differ only in padding policy (below); 0 other |
| B. its receiver on our frames | 21,780 | 21,780 complete with the identical payload, no errors |
| C. our `reassemble()` on its frames | 21,780 | 21,780 complete with the identical payload, no events |
| D. differential receive fuzz: 3,000 mutated sequences (drop, duplicate, swap, bad SN, truncate, wrong PCI type, stray SF, stray FF, two messages interleaved; classic and CAN FD 64; padding on/off) | 3,000 | 76 different outcomes, all in the groups F1–F4 below; 0 unexplained |

### Differences and how each was resolved

| # | Difference | Verdict | Action |
|---|---|---|---|
| P1 | CAN FD with frames above 8 bytes and padding set: we pad frames of 8 bytes or fewer (short SF, last CF) to 8; can-isotp leaves them at their natural length (any length 0..8 is a legal DLC). | **Ambiguous / padding policy.** Both outputs are legal frames and both receivers accept both. SPEC section 5 only says classic frames are padded to 8. | Kept; recorded as DECISIONS D30. |
| F1 | A 4-bit SF_DL in a CAN FD frame longer than 8 bytes: we decode it with a warning (TEST_VECTORS 2.4 requires that); can-isotp drops the frame (its error text cites the CAN_DL > 8 escape rule). | **Spec choice**, possibly stricter in the standard. | Kept (vector 2.4); spec question S3 in VERIFY.md. |
| F2 | A First Frame whose FF_DL fits inside the frame itself: we emit the message with a warning (DECISIONS D8); can-isotp waits for Consecutive Frames that never come. | **Policy difference.** Neither output is wrong for a malformed sender. | Kept. |
| F3 | A CAN FD frame whose length no DLC can express (for example 62 or 11 bytes): can-isotp drops a First Frame of that size; **we accepted it silently.** | **Our bug** (a malformed frame was not reported). | **Fixed**: `reassemble()` now warns "frame length N is not a legal CAN FD frame size" and still decodes the data. Regression test added. |
| F4 | A CAN FD Consecutive Frame shorter than the First Frame while more data is expected: can-isotp ignores the frame; **we appended it without any warning** (we already warned for the classic case). | **Our bug** (missing check). | **Fixed**: the existing "short Consecutive Frame" warning now covers CAN FD (compared with the FF's frame size). We still keep the bytes, so the message stays visible (DECISIONS D29). Regression tests added. |
| F5 | (classifier only, not observed) An escape-form SF (SF_DL 0) in a frame of 8 bytes or fewer: can-isotp accepts it, we reject it as TEST_VECTORS 2.1 requires. | Spec choice. | Kept. |

Classifier note: `check_isotp_fuzz.py` counts a difference as explained when the mutated frame list contains one of the
F1–F5 patterns. That is coarse (a list with such a frame could, in principle, also hide a second cause); every
difference was also inspected by hand on the first run, before the fixes.

Result: **2 bugs found and fixed (F3, F4)**; segmentation and reassembly of valid traffic agree in all 21,780 cases.
