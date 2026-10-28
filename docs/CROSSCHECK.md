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
