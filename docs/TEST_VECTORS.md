# Test vectors

Known answers for the tests. They were worked out by hand from the public standards. If one looks wrong, do not change it silently:
record it in `docs/VERIFY.md` with your reasoning.

Notation: payloads and frame data are hex bytes. Times are seconds.

## 1. Parsing

| Input line | Expected frame |
|---|---|
| `(0.001000) can0 7E0#0210030000000000` | time 0.001, iface `can0`, id 0x7E0, ext false, fd false, 8 data bytes |
| `(0.002000) can0 18DAF110#0210030000000000` | id 0x18DAF110, ext true |
| `(0.003000) can0 7E0##1000922F190F186F187F189AA` | fd true, brs true, 12 data bytes `00 09 22 F1 90 F1 86 F1 87 F1 89 AA` |
| `  can0  7E8   [8]  06 50 03 00 32 01 F4 AA` | id 0x7E8, 8 bytes, time null |
| `   0.016000 1  7E0             Tx   d 8 02 10 03 00 00 00 00 00` | time 0.016, dirHint `req` |
| `7E8: 06 50 03 00 32 01 F4 AA` | id 0x7E8, 8 bytes |
| `7E0#0210030000000000` | id 0x7E0, 8 bytes |
| `22 F1 90` | raw payload `22 F1 90`, no frame |
| `7E0#021003000000000` (odd digit count) | goes to `ignored` |
| `hello world` | goes to `ignored` |
| `# comment` and blank lines | skipped, not in `ignored` |

## 2. ISO-TP

**2.1 Single frames**
- `7E0#0210030000000000` → one message, kind SF, payload `10 03`, dir `req`.
- `7E8#065003003201F4AA` → payload `50 03 00 32 01 F4`, dir `rsp`.
- Classic frame `7E0#0010030000000000` (SF_DL 0) → error "SF_DL = 0 is invalid in a classic CAN frame".
- `7E0#0810030000000000` (SF_DL 8 in an 8-byte frame) → error (does not fit).

**2.2 Multi-frame (VIN read), expected as one session**
```
(0.000000) can0 7E0#0322F19000000000
(0.003000) can0 7E8#101462F190454754
(0.003500) can0 7E0#300000AAAAAAAAAA
(0.004000) can0 7E8#2145535431323334
(0.004200) can0 7E8#2235363738393031
```
Expected: two messages. #1 request payload `22 F1 90`. #2 payload `62 F1 90` + ASCII `EGTEST12345678901` (20 bytes), kind MF, frames 2, 4 and 5 (the FC at frame 3 belongs to no message). Frame 3's timeline text starts with `FC · ContinueToSend, BS 0 (no limit), STmin 0 ms`.
Decoded #2: positive ReadDataByIdentifier, DID `F190` named `VIN`, data text `"EGTEST12345678901"`, paired with message #1, latency 3.0 ms (response first frame 0.003 minus request last frame 0.000).

**2.3 Errors**
- Sequence error: take the session above and replace the 4th line (the first CF) with `(0.004000) can0 7E8#2345535431323334` (SN 3 where SN 1 is expected) → error "expected SN 1, got 3". The partial message (first 6 bytes) is emitted with `partial = true` and `error` set. The following line (SN 2) is then reported as an orphan Consecutive Frame.
- Orphan CF: a lone `7E8#2145535431323334` → error "orphan Consecutive Frame".
- Incomplete: FF `7E8#101462F190454754` alone → at the end a partial message with "received 6 of 20 bytes".
- New FF while open: two FFs on the same ID → warning, first transfer discarded.
- Invalid PCI: `7E8#4112345678000000` → error "invalid PCI type 4".
- Flow control variants: `7E0#300A7FAAAAAAAAAA` → `BS 10, STmin 127 ms`; `7E0#3000F1AAAAAAAAAA` → `STmin 100 µs`; `7E0#3200000000000000` → error "receiver reports buffer overflow"; `7E0#3300000000000000` → error "invalid FlowStatus 3".

**2.4 CAN FD**
- `7E0##1` + `000922F190F186F187F189AA` (12 data bytes) → SF with escape length 9, payload `22 F1 90 F1 86 F1 87 F1 89`, decoded as ReadDataByIdentifier with four DIDs.
- A 4-bit SF_DL in a 12-byte frame: `7E0##00322F1900000000000000000` (12 data bytes starting `03 22 F1 90`) → payload `22 F1 90`, plus a warning that the escape form is required above 8 bytes.
- Escaped First Frame (length above 4095): segment a 5000-byte payload with `{fd: true, canDl: 64}`; first frame starts `10 00 00 00 13 88` and carries 58 payload bytes; reassembly returns the original payload.

**2.5 Extended addressing**
- With `addressing: 'extended'`, the frame `7E0#F102100300000000` (data `F1 02 10 03 00 00 00 00`) → address byte `F1`, SF with payload `10 03`.

**2.6 STmin text**: `0x00` → `0 ms`, `0x7F` → `127 ms`, `0x80` → reserved, `0xF1` → `100 µs`, `0xF9` → `900 µs`, `0xFA` → reserved.

**2.7 Round trip (property)**: for payload lengths 1..200, 4095, 4096, 5000 (bytes cycle 0..255), every combination of classic and FD (`canDl` 8, 12, 64), normal and extended addressing, padding `null` and `0xAA`: `reassemble(segment(p))` returns exactly one message equal to `p`, no events. Every FD frame length is a legal DLC size (0..8, 12, 16, 20, 24, 32, 48, 64).

## 3. UDS decoding

| Payload | dir | Expected summary / key fields |
|---|---|---|
| `10 03` | req | `DiagnosticSessionControl · extendedDiagnosticSession` |
| `10 83` | req | same, field text mentions suppressPosRspMsg = 1 |
| `50 03 00 32 01 F4` | rsp | `+ DiagnosticSessionControl · extendedDiagnosticSession · P2 50 ms · P2* 5000 ms` |
| `11 01` / `51 01` | req / rsp | `ECUReset · hardReset` / `+ ECUReset · hardReset` |
| `27 01` | req | `SecurityAccess · requestSeed (level 1)` |
| `67 01 12 34 56 78` | rsp | `+ SecurityAccess · requestSeed (level 1)`, seed field 4 bytes |
| `67 01 00 00 00 00` | rsp | seed field text says already unlocked |
| `27 02 6B AB B9 07` | req | `SecurityAccess · sendKey (level 1)` |
| `67 02` | rsp | `+ SecurityAccess · sendKey (level 1)` |
| `27 03` | req | `requestSeed (level 2)` |
| `7F 27 35` | rsp | `− SecurityAccess · invalidKey (0x35)`, level `warn` |
| `7F 31 78` | rsp | `pending = true`, level `info` |
| `7F 22 31` | rsp | `− ReadDataByIdentifier · requestOutOfRange (0x31)` |
| `7F 99 11` | rsp | name `Service 0x99`, NRC `serviceNotSupported` |
| `22 F1 90 F1 86` | req | DIDs listed `F190, F186`, names `VIN`, `activeDiagnosticSession` |
| `62 F1 90 45 47 54 45 53 54 31 32 33 34 35 36 37 38 39 30 31` | rsp, request `22 F1 90` | data text `"EGTEST12345678901"` |
| `62 F1 90 45 47 54 45 53 54 31 32 33 34 35 36 37 38 39 30 31 F1 86 03` | rsp, request `22 F1 90 F1 86` | two data records: VIN text and `03` for `F186`; an `info` note about the split heuristic |
| `2E F1 98 01 02 03 04 05 06` | req | `WriteDataByIdentifier · F198` |
| `6E F1 98` | rsp | `+ WriteDataByIdentifier · F198` |
| `19 02 09` | req | `reportDTCByStatusMask`, mask text lists testFailed and confirmedDTC |
| `59 02 FF 01 33 00 2F C1 00 87 08` | rsp | availability mask `FF`; DTC 1 `P0133-00` status `2F` = testFailed, testFailedThisOperationCycle, pendingDTC, confirmedDTC, testFailedSinceLastClear; DTC 2 `U0100-87` status `08` = confirmedDTC; detail `2 DTCs` |
| `59 01 FF 01 00 03` | rsp | `reportNumberOfDTCByStatusMask`, format `ISO 14229-1 DTC format`, count 3 |
| `14 FF FF FF` | req | `ClearDiagnosticInformation · all DTCs` |
| `31 01 FF 00` | req | `RoutineControl · startRoutine FF00 eraseMemory` |
| `71 01 FF 00 00` | rsp | status record `00` |
| `34 00 44 08 00 00 00 00 00 10 00` | req | no compression/encryption; address `0x08000000`; size 4096 bytes |
| `74 20 01 00` | rsp | max block 256 bytes → 254 data bytes |
| `36 01 AA BB CC` | req | block 1, 3 data bytes |
| `76 01` | rsp | block 1 |
| `37` / `77` | req / rsp | `RequestTransferExit` |
| `28 03 01` | req | `disableRxAndTx`, normalCommunicationMessages |
| `3E 00` / `3E 80` / `7E 00` | req / req / rsp | `TesterPresent`, second with suppress bit |
| `85 02` | req | `ControlDTCSetting · DTC setting off` |
| `10` | req | decodes; `error` note "Truncated message: diagnosticSessionType needs 1 byte"; no exception |
| `` (empty) | any | summary `empty message`, level `error` |
| `55 01 02` | req | unknown service, `warn` note |

## 4. OBD-II and DTC text

| Payload | dir | Expected |
|---|---|---|
| `01 0C` | req | `OBD-II Mode 01 ShowCurrentData`, PID `0C engineSpeed` |
| `41 0C 1A F8` | rsp | engineSpeed `1726 rpm` ((0x1A·256 + 0xF8) / 4) |
| `41 05 7B` | rsp | engineCoolantTemperature `83 °C` |
| `41 0D 3C` | rsp | vehicleSpeed `60 km/h` |
| `41 00 BE 1F A8 13` | rsp | supported PIDs exactly `01 03 04 05 06 07 0C 0D 0E 0F 10 11 13 15 1C 1F 20` (bit 31 = PID 01, bit 0 = PID 20) |
| `03` / `43 02 01 33 C1 00` | req / rsp | `P0133`, `U0100`, count 2 |
| `09 02` / `49 02 01 45 47 54 45 53 54 31 32 33 34 35 36 37 38 39 30 31` | req / rsp | VIN text `"EGTEST12345678901"` |
| DTC bytes `01 33` / `C1 00` / `43 21` / `81 23` | | `P0133` / `U0100` / `C0321` / `B0123` |

DTC text rule for the last row: bits 7..6 of the first byte give the letter (`P` = 00, `C` = 01, `B` = 10, `U` = 11), bits 5..4 the first digit (0..3),
bits 3..0 the second digit; the second byte is printed as two hex digits. So `0x43` = `01 00 0011` → `C`, `0`, `3`, then `21` → `C0321`.

## 5. Simulator flows

All with default config, physical addressing, virtual time in ms starting at 0 and requests 100 ms apart unless stated.

**5.1 Basics**
1. `22 F1 90` → `62 F1 90` + ASCII `EGTEST12345678901` (works in the default session).
2. `22 F1 86` → `62 F1 86 01`.
3. `27 01` in the default session → `7F 27 7F`.
4. `10 03` → `50 03 00 32 01 F4`. Then `22 F1 86` → `62 F1 86 03`.
5. `10` → `7F 10 13`; `10 05` → `7F 10 12`.
6. `23 00 00` (unsupported service) → `7F 23 11`. The same request with `functional: true` → no response.
7. `3E 00` → `7E 00`; `3E 80` → no response; `3E 05` → `7F 3E 12`.
8. `22 DE AD` (unknown DID) → `7F 22 31`. `22 F1 90 DE AD` → `62 F1 90 ...` with only the VIN (unknown DID omitted).
9. `22 F1 90` with a request ID of `0x7DF` (functional): the ECU answers (supported service); `22 DE AD` functional → no response (NRC 0x31 suppressed).

**5.2 Security**
1. In the extended session: `27 01` → `67 01 <seed>` with a non-zero 4-byte seed. `27 02 <demoKey(seed)>` → `67 02`. A second `27 01` → `67 01 00 00 00 00`.
2. `27 02 00 00 00 00` with no pending seed → `7F 27 24`.
3. `27 01`, `27 02` with a wrong key → `7F 27 35`; repeat `27 01` + wrong key twice more: the third wrong key → `7F 27 36`. A `27 01` within 10 000 ms → `7F 27 37`. After 10 000 ms the seed request works again and the attempt counter restarts.
4. `2E F1 98 01 02 03 04 05 06` while locked → `7F 2E 33`. After unlocking → `6E F1 98`; `22 F1 98` → `62 F1 98 01 02 03 04 05 06`. In the default session → `7F 2E 7F`. With 5 data bytes → `7F 2E 13`. For an unknown DID `2E F1 99 ...` → `7F 2E 31`.
5. `27 01` after a session change (`10 01` then `10 03`) → security is locked again (a `2E F1 98 ...` returns `7F 2E 33`).
6. Demo key answers (`demoKey` takes and returns 4-byte arrays): seed `12 34 56 78` → `6B AB B9 07`; seed `00 00 00 01` → `32 32 6D E5`; seed `DE AD BE EF` → `DC 7E CB 90`.

**5.3 Timing**
- S3: `10 03` at t = 0; `tick(5001)` returns an event and the session is default and locked; `22 F1 86` → `62 F1 86 01`. With a `3E 80` at t = 4000 the session is still extended at t = 8000 and expires after t = 9000.
- `snapshot(nowMs).s3RemainingMs` counts down from 5000 to 0.

**5.4 Programming flow**
1. `10 02` → `50 02 00 32 01 F4`.
2. `27 01` → seed, `27 02 <key>` → `67 02`.
3. `34 00 44 08 00 00 00 00 00 01 00` before erasing → `7F 34 24`.
4. `31 01 FF 00` → three responses: `7F 31 78` at 50 ms, `7F 31 78` at 4050 ms, `71 01 FF 00 00` at 7000 ms.
5. `34 00 44 08 00 00 00 00 00 01 00` → `74 20 01 00`. A request with address `0x10000000` (`34 00 44 10 00 00 00 00 00 01 00`) → `7F 34 31`. A truncated request `34 00 44 08 00 00` → `7F 34 13`.
6. `36 01` + 254 bytes → `76 01`; `36 03` + 2 bytes → `7F 36 73`; `37` now → `7F 37 24` (only 254 of 256 bytes received); `36 02 AA BB` → `76 02`; `37` → `77`; then `36 01 AA` → `7F 36 24` (no active download).
7. The same flow in the extended session: `31 01 FF 00` → `7F 31 7F`; `34 ...` → `7F 34 7F`.
8. `31 01 FF 00` while locked (programming session) → `7F 31 33`.

**5.5 Other services**
- `11 01` → `51 01`; afterwards the session is default, security locked, download cleared. `11 04` → `7F 11 12`.
- `14 FF FF FF` → `54`; then `19 02 FF` → `59 02 FF` (no records); `19 01 FF` → `59 01 FF 01 00 00`.
- Fresh ECU: `19 02 FF` → `59 02 FF 03 00 00 2F 01 13 00 08 C1 00 87 09`; `19 02 01` → only DTCs with testFailed set: P0300 (2F) and U0100 (09); `19 01 FF` → `59 01 FF 01 00 03`. `19 0A` → all three DTCs.
- `85 02` in extended → `C5 02`; in the default session → `7F 85 7F`.
- `28 03 01` in extended → `68 03`; `28 09 01` → `7F 28 12`; `28 03 00` → `7F 28 31`.
- `31 01 02 00` in extended → `71 01 02 00 00`; `31 03 02 00` → `71 03 02 00 01`; `31 01 12 34` → `7F 31 31`.

**5.6 Exchange driver (frames on the bus)**
- `22 F1 90` physical, classic CAN, padding `0xAA`: request frame `7E0: 03 22 F1 90 AA AA AA AA`; response frames `7E8: 10 14 62 F1 90 45 47 54`, then (from the tester) `7E0: 30 00 00 AA AA AA AA AA`, then `7E8: 21 45 53 54 31 32 33 34`, `7E8: 22 35 36 37 38 39 30 31`.
- The same request with FD and 64-byte frames: the response is a single frame using the escape form (`00 14 62 F1 90 ...`, 22 bytes + padding to a legal size, i.e. 24).
- Decode the frames of any exchange with `core.decodeAll` (candump `-L` text from `formatCandump`): the messages' payloads equal the request and responses.
- Pending responses: `31 01 FF 00` produces frames at 0.050 s, 4.050 s and 7.000 s after the request (relative), each response segmented separately.
