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

## 3. UDS (udsoncan 1.26.1) — `check_uds.py`

### A. Names: 167 compared, 146 agree, 21 differ

Compared: every NRC that udsoncan's `ResponseCode` names (with the edition it gives each one), every service class's
SID and name, and the sub-function constants of 0x10, 0x11, 0x19, 0x28, 0x29, 0x2C, 0x31, 0x83, 0x85 and 0x87, plus
the DTC format identifiers. Names were compared case-insensitively, ignoring underscores.

| Difference | Verdict | Action |
|---|---|---|
| 0x19 sub-functions 0x0F..0x13 had **no name** in our table ("subFunction 0x0F"), although our decoder already parsed their masks and records. | **Our bug** (incomplete table). | **Fixed**: names added from our reading of the standard. 0x0F and 0x11 agree with udsoncan; 0x10, 0x12 and 0x13 differ in spelling and carry `// VERIFY`. Regression test added. |
| 0x19 0x05 `reportDTCStoredDataByRecordNumber` vs `reportDTCSnapshotRecordByRecordNumber` | Standard-edition difference, as far as we can tell (we believe the name changed after 2006). | `// VERIFY` added. |
| 0x19 0x06 / 0x10 `Ext` vs `Extended`; 0x0A `reportSupportedDTC` vs `...DTCs`; 0x12 / 0x13 `EmissionsOBD` vs `EmissionsRelatedOBD` | Ambiguous (spelling). | `// VERIFY` added; names kept. |
| 0x87 `verifyModeTransitionWith...` vs `verifyBaudrateTransitionWith...` | Standard-edition difference, as far as we can tell (udsoncan's names look like the older edition's). | `// VERIFY` added. |
| NRC 0x36 `exceededNumberOfAttempts` vs `ExceedNumberOfAttempts`; 0x8F `brakeSwitchesNotClosed` vs `BrakeSwitchNotClosed`; 0x57 `...InvalidCertificateRevoked` vs `..._InvalidCertificate` | Ambiguous (spelling). | `// VERIFY` added / kept. |
| NRC 0x38..0x40: our range name vs udsoncan's ISO 15764 names; 0x38..0x3A also carry 2020 "secure data transmission" names in udsoncan (it defines two names for each of those three values, so its own lookup is ambiguous). | Standard-edition difference / ambiguous; arguably an **oracle inconsistency** for 0x38..0x3A. | `// VERIFY` added; range name kept. |

Agreements that removed VERIFY markers: Authentication 0x29 (all nine names), 0x19 sub-functions 0x16..0x1A, 0x42,
0x55, 0x56, NRC 0x34, 0x50..0x56, 0x58..0x5D and 0x94 (udsoncan dates all of them to the 2020 edition), DTC formats
0x00..0x04. See `docs/VERIFY.md` for the item-by-item status.

### B. Requests encoded by udsoncan, decoded by us: 5,312 cases, 0 mismatches

udsoncan's `make_request` built random requests for 0x10, 0x11, 0x14 (with and without memory selection), 0x19
(01, 02, 04, 06, 0A..0E, 15), 0x22 (1..6 DIDs), 0x23, 0x27 (seed and key, every level), 0x28 (all control types,
random subnet and message classes, node id for 04/05), 0x2E, 0x2F (with control state), 0x31, 0x34, 0x35 (random
compression/encryption nibbles, 1..5-byte addresses, 1..4-byte sizes), 0x36, 0x37, 0x3D, 0x3E (with and without the
suppress bit), 0x83 and 0x85. For each, our `decodeUds()` fields had to cover every byte exactly once and carry the
values udsoncan encoded (session, reset type, group, mask, DTC, record number, DIDs, address-and-length format,
address, size, data format, level, key, control and communication type, node id, data, control parameter, routine id,
option record, block counter).

### C. Responses generated here, interpreted by both: 4,409 cases, 0 unexplained mismatches

Generated positive responses were interpreted by udsoncan's `interpret_response` and by our core: 0x50 P2 / P2*
(converted to ms), 0x51 (including power-down time), 0x59 01 (mask, format, count), 0x59 02/0A/0B..0E/15 (every DTC and
status byte), 0x62 with 1..4 DIDs of random lengths (udsoncan was given the true lengths; we split by searching for the
requested DIDs), 0x63, 0x67 (seed), 0x71 (status record), 0x74 / 0x75 (max block length, 1..4-byte width), 0x76, 0x77,
0x7D, and 500 negative responses (service and NRC).

- The 0x62 split heuristic (DECISIONS D11) agreed with the true lengths in all 500 cases. Random data rarely contains a
  requested DID value; the heuristic's known limitation is unchanged and documented.
- Weakly covered: the one-byte echo responses (0x68, 0x7E, 0xC3, 0xC5: one case each), and 0x59 04/06, 0x6F and 0xC3
  records, which were not compared field by field.
- Script bugs found on the way (not product bugs): our generator first produced empty seeds and a
  `CommunicationType` with no message class; udsoncan rightly refused both.

Result: **1 bug fixed** (missing 0x19 names); request and response field values agree everywhere they were compared.

## 4. Log parsing (python-can 4.6.1) — `check_logs.py`

How: each generated line was parsed alone by our `parseLog()` and by python-can's `CanutilsLogReader` (candump `-L`)
or `ASCReader` (Vector ASC, after a generated three-line header). Compared: time, interface/channel, ID, 11/29-bit flag,
CAN FD and BRS flags, data bytes, and for ASC the Rx/Tx direction (our `dirHint`).

| Area | Cases | Mismatches |
|---|---|---|
| candump `-L` canonical lines: 11- and 29-bit IDs, classic 0..8 bytes, CAN FD every legal size with flag digits 0..3, mixed letter case, optional ` R` / ` T` direction marker, several interface names | 4,000 | 0 |
| Vector ASC classic lines: 11-bit and `x`-marked 29-bit IDs, 0..8 bytes, Rx/Tx, channels 1..4, optional trailing `Length = … BitCount = … ID = …` fields, mixed case | 4,000 | 0 |
| Edge cases (below) | 10 | 9 differences, all classified |

| Edge case | Ours | python-can | Verdict |
|---|---|---|---|
| ID written with 4..7 hex digits (`07E0#…`), value ≤ 0x7FF | 11-bit | 29-bit (any ID longer than 3 digits) | Ambiguous: candump only writes 3 or 8 digits. Kept DECISIONS D6. |
| Remote frame `7E0#R` | ignored line ("remote frame") | remote frame | Behaviour difference by design: remote frames carry no diagnostic data. |
| CAN FD flags digit `A` (`7E0##A0102`) | parsed (flags are a hex digit) | `ValueError` (reads the digit as decimal) | **Oracle limitation**; ours unchanged. |
| 12 bytes after a single `#` | `fd = true` | `is_fd = False` with 12 bytes | SPEC section 3 says frames over 8 bytes are FD. Kept. |
| Odd number of data digits | ignored (TEST_VECTORS section 1) | accepted, last nibble dropped | Ours follows the vector; python-can is more lenient. Kept. |
| ASC line whose DLC is larger than the bytes present | ignored | accepted with the bytes present | Ambiguous; we prefer to report a malformed line. Kept. |
| ASC `7E0x` (29-bit flag on a small value) | 29-bit | 29-bit | Agree. |

Not compared: candump default format, the plain `ID bytes` formats and raw payload lines (python-can has no reader for
them), and ASC CAN FD lines (we do not parse them; see the README's format list).

Result: **no bugs found**.
