# UDS Bench specification v0.1

Keywords: MUST, SHOULD and MAY are used in their usual sense.

## 1. Purpose and scope

UDS Bench is a browser tool with three tabs:

1. **Decode**: paste a CAN / CAN FD log, get ISO-TP reassembly and UDS / OBD-II decoding with explained, colour-coded bytes.
2. **Simulate**: a virtual ECU. Send requests, see the ISO-TP frames on the bus and the decoded responses, send the session to Decode.
3. **Reference**: lookup tables (services, NRCs, ISO-TP frame types, DTC status bits, sessions).

It is public and free, needs no sign-in and makes no network requests other than Google Fonts. Nothing leaves the browser.

**Non-goals for v0.1:** hardware access (WebUSB, WebSerial), DBC / ODX / A2L files, J1939, LIN, DoIP, real vendor security
algorithms, vendor DID dictionaries, persistence of user data, accounts.

## 2. Repository layout and module contracts

```
src/core.js              parsing, ISO-TP, UDS and OBD-II decoding (no DOM)       global: EGUDS
src/sim.js               virtual ECU and exchange driver (no DOM)                global: EGSIM
src/ui.js                all DOM code
src/style.css            all styling
src/index.template.html  page markup with {{STYLE}}, {{CORE}}, {{SIM}}, {{UI}} placeholders
scripts/build.mjs        inlines the above into dist/index.html
test/core.test.js        node:test
test/sim.test.js         node:test
examples/*.log           three sample logs
dist/index.html          build output, committed so static hosting needs no build step
docs/                    SPEC.md, TEST_VECTORS.md, DECISIONS.md, VERIFY.md
PROGRESS.md              what is finished, updated at the end of every phase
netlify.toml             publish = "dist", command = "node scripts/build.mjs"
```

- `core.js` and `sim.js` are plain scripts. Each defines one global (`EGUDS`, `EGSIM`) and also executes
  `module.exports = ...` when `module` exists, so Node tests can `require` them. `sim.js` obtains `EGUDS` from `globalThis`
  or `require('./core.js')`.
- Time is a number of seconds in logs and frames, and a number of milliseconds inside the ECU simulator.
- Bytes are plain arrays of integers 0..255.

## 3. Log parsing (core)

`parseLog(text)` returns `{frames, raws, ignored}`. It MUST NOT throw. Blank lines and lines starting with `#` or `//` are skipped.
Lines that match no format go to `ignored` with their 1-based line number.

| Format | Example |
|---|---|
| candump `-L` | `(1698484800.123456) can0 7E0#0210030000000000` |
| candump `-L` CAN FD | `(1698484800.123456) can0 7E0##1000922F190F186F187F189AA` (after `##`: one flags nibble, bit 0 = BRS, then data) |
| candump default | `  can0  7E0   [8]  02 10 03 00 00 00 00 00`, optionally with a leading `(time)` |
| Vector ASC (classic) | `   0.016000 1  7E0             Tx   d 8 02 10 03 00 00 00 00 00` (trailing `x` on the ID = 29-bit; `Tx` = request hint, `Rx` = response hint) |
| plain with hash | `7E0#0210030000000000` |
| plain | `7E0 02 10 03 00 00 00 00 00`, also `7E0: 02 10 03` |
| raw UDS payload | `22 F1 90` (only bytes: a ready-made payload with no CAN framing; decoded directly) |

Frame object: `{index, line, time|null, iface, id, ext, fd, brs, data[], dirHint|null, dir|null}`.
- `ext` is true for 8-hex-digit IDs (29-bit), false for 3 digits.
- `fd` is true when the format says so or when `data.length > 8`.
- A line with an odd number of data digits is malformed and goes to `ignored`.

## 4. CAN ID roles (core)

`classifyId(id, ext, cfg)` returns `'req'`, `'rsp'` or `null`. Order: user-supplied sets `cfg.reqIds` / `cfg.rspIds` first; then
11-bit: `0x7DF` and `0x7E0..0x7E7` are requests, `0x7E8..0x7EF` are responses; 29-bit: `0x18DAttss` is a response when `tt` (target) is `F1`
and a request otherwise, `0x18DB33F1` is a functional request. Anything else is `null`: the direction is then inferred from the payload
(`inferDir`): first byte `0x7F` → response; `0x41..0x4A` → OBD-II response; `SID - 0x40` is a known UDS service → response; otherwise request.
The UI MUST let the user override the request and response ID lists (comma-separated hex).

## 5. ISO-TP (core)

`reassemble(frames, {addressing})` where addressing is `'normal'` or `'extended'` (extended: the first data byte is an address byte and the PCI byte is second).
Returns `{messages, timeline, events}`. Reassembly state is kept per CAN ID.

**Frames (PCI = first nibble of the PCI byte)**
- `0` Single Frame: `SF_DL` = low nibble (1..7, or 1..6 with extended addressing). If the low nibble is 0 and the frame has more than 8 bytes, the
  next byte holds `SF_DL` (CAN FD escape). `SF_DL = 0` in a classic frame, or `SF_DL` larger than the bytes present, is an error. A 4-bit `SF_DL`
  in a frame of more than 8 bytes is a warning. Bytes after `SF_DL` are padding and are ignored.
- `1` First Frame: `FF_DL` = 12 bits (low nibble + next byte). If it is 0, the next 4 bytes hold a 32-bit length (escape). All remaining bytes
  of the frame are payload. A new FF on an ID with an open transfer discards the open transfer with a warning.
- `2` Consecutive Frame: sequence number SN = low nibble, starting at 1 after the FF, wrapping 15 → 0. A CF with no open transfer is an
  orphan error. A wrong SN aborts the transfer with an error and emits the partial message (flagged). Bytes beyond the announced length are padding.
- `3` Flow Control: FS 0 ContinueToSend, 1 Wait, 2 Overflow; then BS and STmin. STmin: `0x00..0x7F` ms, `0xF1..0xF9` 100..900 µs, others reserved (treat as 127 ms).
  FS = 2 is an error ("receiver overflow"). Invalid FS (3..15) is an error. FC frames are annotated in the timeline but are not messages.
- `4..F` invalid PCI type: error.
- A transfer still open at the end of the log is emitted as a partial message with a warning ("received X of Y bytes").
- A short CF (classic frame under 8 bytes) while more data is still expected is a warning.

**Outputs**
- `messages[]`: `{no, id, ext, dir, time, endTime, frameIdx[], kind: 'SF'|'MF'|'RAW', payload[], partial, error|null, line, total}`.
- `timeline[]`, one entry per frame: `{index, id, time, kind: 'SF'|'FF'|'CF'|'FC'|'??', text, level: 'ok'|'info'|'warn'|'error', msgNo|null, pciLen}`.
- `events[]`: `{index, level, text}` for warnings and errors (used by the summary line).

**Segmentation** `segment(payload, {fd, canDl, pad, extAddr})` returns an array of frames (byte arrays):
- Payload up to 7 bytes (6 with extended addressing): SF with a 4-bit length.
- FD and payload fitting in `canDl - addr - 2`: SF with the escape form.
- Otherwise FF (12-bit length up to 4095, escaped 32-bit length above) followed by CFs, SN starting at 1.
- `canDl` is one of 8, 12, 16, 20, 24, 32, 48, 64 (classic CAN is always 8). With FD, frames longer than 8 bytes MUST be padded to a legal DLC size.
- `pad` is a byte value or `null`. Classic frames are padded to 8 when `pad` is set. Default padding byte `0xCC` when FD needs padding and `pad` is `null`.
- `flowControl(opts, fs, bs, stMin)` builds an FC frame. `formatCandump(...)` renders a frame as a candump `-L` line (`#` classic, `##<flags>` FD).
- Property: `reassemble(segment(p)) == p` for payload lengths 1..200, 4095, 4096, 5000 in every combination of classic/FD (canDl 8, 12, 64), normal/extended addressing, padding on/off.

## 6. UDS decoding (core)

`decodeUds(payload, {dir, request})` returns `{kind: 'request'|'positive'|'negative', sid, name, detail, summary, fields[], notes[], level, pending}`.

- `fields[]`: ordered, covering every payload byte exactly once: `{role, label, bytes[], text}`. Roles: `sid`, `sub`, `id` (DID, RID, DTC, address, size), `meta` (format identifiers, counters, masks), `data`, `nrc`.
- `notes[]`: `{level, text}`. `level` is the worst note level (`ok < info < warn < error`). A negative response is `warn`; NRC `0x78` is `info` and sets `pending`.
- `summary` examples: `DiagnosticSessionControl · extendedDiagnosticSession`, `+ SecurityAccess · requestSeed (level 1)`, `− SecurityAccess · invalidKey (0x35)`.
- Truncated payloads produce an `error` note and decode as far as the bytes allow; they never throw.
- Sub-function services: bit 7 of a request's sub-function byte is `suppressPosRspMsgIndicationBit`; show it in the field text.
- Pairing (`annotate`): a response is paired with the most recent unanswered request whose SID matches (positive: `p[0] - 0x40`; negative: `p[1]`). `0x78` keeps the request open. If both have timestamps, `latencyMs = (response first frame time - request last frame time) * 1000`.
- Positive responses to `0x22` use the paired request's DID list to split data records (UDS carries no data lengths); split by scanning for the next requested DID and add an `info` note saying so. Without a request, decode the first DID and show the rest as one block.

**Service coverage (request and positive response)**

| SID | Service | Fields to decode |
|---|---|---|
| 0x10 | DiagnosticSessionControl | session type; response adds P2Server_max (ms) and P2*Server_max (units of 10 ms) |
| 0x11 | ECUReset | reset type; `powerDownTime` for type 4 |
| 0x14 | ClearDiagnosticInformation | groupOfDTC (3 bytes, `FFFFFF` = all) |
| 0x19 | ReadDTCInformation | sub-functions 01, 02, 04, 06, 0A, 0B..0E, 15 fully; others raw. Response 01: availability mask, format, count. Responses 02/0A/…: availability mask + records of DTC (3 bytes) + status (1 byte) |
| 0x22 | ReadDataByIdentifier | DID list; response DID + data records |
| 0x23, 0x3D | Read / WriteMemoryByAddress | address-and-length format identifier, address, size, data |
| 0x27 | SecurityAccess | odd sub-function = requestSeed (level (sf+1)/2), even = sendKey (level sf/2); seed (all zero = already unlocked), key |
| 0x28 | CommunicationControl | control type, communication type (low 2 bits = message class, high nibble = subnet), node id for 04/05 |
| 0x2E | WriteDataByIdentifier | DID + data |
| 0x2F | InputOutputControlByIdentifier | DID, control parameter, state/mask |
| 0x31 | RoutineControl | sub-function, routine id, option / status record |
| 0x34, 0x35 | RequestDownload / Upload | data format id (compression/encryption nibbles), address-and-length format id, address, size; response: length format id + max block length (bytes incl. SID and counter, show "→ N data bytes") |
| 0x36 | TransferData | block sequence counter + data length |
| 0x37 | RequestTransferExit | optional record |
| 0x3E | TesterPresent | zeroSubFunction (0x00, or 0x80 with suppress bit) |
| 0x83 | AccessTimingParameter | sub-function names, raw record |
| 0x85 | ControlDTCSetting | on / off |
| 0x29, 0x24, 0x2A, 0x2C, 0x38, 0x84, 0x86, 0x87 | other | service name, sub-function name where it exists, rest raw, `info` note "field decoding not implemented" |
| other | unknown | `warn` note, raw bytes |

**Negative responses**: `7F <SID> <NRC>`; names for every NRC in ISO 14229-1 including the reserved ranges (`0x38..0x4F`, `0x94..0xFE`).
**DTCs**: 3-byte DTC shown SAE-J2012 style (`P0133`, with `-FF` failure-type suffix for UDS), status byte expanded to the eight named bits (testFailed, testFailedThisOperationCycle, pendingDTC, confirmedDTC, testNotCompletedSinceLastClear, testFailedSinceLastClear, testNotCompletedThisOperationCycle, warningIndicatorRequested).
**DIDs**: names for the standardised ISO 14229-1 Annex C range (F180..F19F); known text DIDs (VIN `F190`, part and version numbers, supplier id, serial) display as ASCII text when printable; ranges `F200..F2FF`, `F300..F3FF`, `F400..F8FF`, `FF00..FFFF` get a generic name; other DIDs say "manufacturer/supplier specific".
**Routines**: `FF00` eraseMemory, `FF01` checkProgrammingDependencies, `FF02` eraseMirrorMemoryDTCs, `E200` deployLoopRoutineID; `0200..DFFF` "vehicle-manufacturer specific".
**Sessions**: 01 default, 02 programming, 03 extended, 04 safetySystem; **reset types** 01..05; **control types** per the table above.
Mark every table row you are unsure of with `// VERIFY`.

## 7. OBD-II subset (core)

Same ISO-TP transport (`0x7DF`/`0x7E0` requests, `0x7E8` responses). Request SIDs `0x01..0x0A`, responses `0x41..0x4A`.
- Mode 01 / 02 (PID blocks; Mode 02 adds a frame number byte). PIDs with lengths and formulas:
  `00/20/40/60` supported-PID masks (list the PIDs set; bit 31 = PID base+1), `04` load `A*100/255 %`, `05` coolant `A-40 °C`,
  `0C` rpm `(256A+B)/4`, `0D` speed `A km/h`, `0F` intake air `A-40 °C`, `10` MAF `(256A+B)/100 g/s`, `11` throttle `A*100/255 %`,
  `1F` run time `256A+B s`, `2F` fuel level `A*100/255 %`, `42` module voltage `(256A+B)/1000 V`, `46` ambient `A-40 °C`, `5C` oil `A-40 °C`.
  Unknown PID: show the PID and the rest as raw bytes.
- Mode 03 / 07 / 0A: count byte then 2-byte DTCs (`01 33` → `P0133`, `C1 00` → `U0100`).
- Mode 04: no data. Mode 09: info type, item count, data (VIN as text).
- Every OBD message carries an `info` note saying it is OBD-II, not UDS.

## 8. Virtual ECU simulator (sim)

Everything here is illustrative. Data and the security algorithm are made up and MUST be described as such in the UI.

**API**
- `createEcu(config)` → `{handle(req, nowMs, {functional}), tick(nowMs), reset(), snapshot(nowMs), demoKey(seedBytes)}`.
  `handle` returns `{responses: [{bytes, delayMs}], events: [text]}`; `tick` returns `events` (for example the S3 timeout).
- `exchange(ecu, req, tNowSec, cfg)` → `{frames: [{t, id, ext, data, fd, brs, who: 'tester'|'ecu'}], responses, events, tEnd}`.
  It segments the request with `core.segment`, inserts the receiver's Flow Control after a First Frame (ContinueToSend, BS 0, configurable STmin), calls `handle`, and
  segments each response (including the `0x78` pending responses) at `tNow + delayMs/1000`. `cfg`: `{reqId, rspId, ext, fd, canDl, brs, pad, extAddr, stMinMs, functional, iface}`.
- Config defaults: `p2 = 50 ms`, `p2star = 5000 ms`, `s3 = 5000 ms`, `lockoutMs = 10000`, `maxAttempts = 3`, request ID `0x7E0`, response ID `0x7E8` (functional `0x7DF`).

**State**: session (1 default, 2 programming, 3 extended), security unlocked flag, pending seed, failed-attempt count, lockout deadline,
last-activity time, communication control state, DTC-setting state, download context, "erased" flag, writable DID storage, DTC list.

**Rules common to all services**
- Every received request first applies `tick(now)` (S3 expiry), then refreshes the S3 timer.
- S3: when session ≠ default and `now - lastActivity > s3`, return to the default session, lock security, discard any download, restore communication control. Emit an event.
- Any change of session (to a different session) locks security. ECUReset returns to the default session, locks security, clears the download.
- Check order (illustrative): service supported (`0x11`) → allowed in current session (`0x7F`) → length (`0x13`) → sub-function supported (`0x12`) → conditions/sequence (`0x22`, `0x24`) → request range (`0x31`) → security (`0x33`) → execute. Where the order above conflicts with the table below, the table wins.
- Suppress positive response bit (bit 7 of the sub-function) is honoured for `0x10, 0x11, 0x27, 0x28, 0x3E, 0x85, 0x31`; negative responses are still sent.
- Functional addressing (`functional: true`): NRCs `0x11, 0x12, 0x31, 0x7E, 0x7F` are suppressed (no response).
- Supported services: `10 11 14 19 22 27 28 2E 2F 31 34 36 37 3E 85`. Anything else → NRC `0x11`.

**Services**

| Service | Behaviour |
|---|---|
| 0x10 | length must be 2 (`0x13`); sub 01/02/03, else `0x12`. Positive: `50 <sub> 00 32 01 F4` (P2 = 50 ms, P2* = 500 × 10 ms) |
| 0x11 | length 2; sub 01, 02, 03 supported, else `0x12`. Positive `51 <sub>`, then reset as described |
| 0x14 | length 4; `FFFFFF` clears all DTCs; a DTC code that exists clears that DTC; otherwise `0x31`. Positive `54` |
| 0x19 | sub 01 (needs mask byte), 02 (mask byte), 0A (no parameter); else `0x12`; wrong length `0x13`. Responses per spec section 6; availability mask `FF`; 02 returns DTCs where `status & mask != 0` |
| 0x22 | length ≥ 3 and odd, else `0x13`. If none of the requested DIDs exists → `0x31`; otherwise the supported ones are returned, unsupported ones omitted. Response over 4095 bytes → `0x14` |
| 0x27 | not in the default session (`0x7F`). Only level 1: sub 01 requestSeed, sub 02 sendKey, others `0x12`. requestSeed: lockout active → `0x37`; already unlocked → `67 01 00 00 00 00`; else new 4-byte seed from a deterministic PRNG (never zero) → `67 01 <seed>`. sendKey: length 6 else `0x13`; no pending seed → `0x24`; correct key → `67 02`, unlocked, attempts reset; wrong key → `0x35`, attempts+1, seed discarded; on the 3rd failure → `0x36` and lockout for 10 s |
| 0x28 | extended session only (`0x7F`); length 3; control type 00..03 else `0x12`; communication type low 2 bits must be 1..3 else `0x31`. Positive `68 <type>` and record the state |
| 0x2E | length ≥ 4; only DID `F198` is writable (6 bytes), else `0x31`; extended session only (`0x7F`); data length 6 else `0x13`; security unlocked else `0x33`. Positive `6E F1 98` |
| 0x2F | DID `0300` (a demo "LED"); extended session (`0x7F`); parameter 00..03; security required (`0x33`); positive `6F 03 00 <param> <state>` |
| 0x31 | length ≥ 4; sub 01/02/03 else `0x12`. RID `FF00` (eraseMemory): programming session only (`0x7F`), security (`0x33`), start only (others `0x12`); responses `7F 31 78` at 50 ms, `7F 31 78` at 4050 ms, then `71 01 FF 00 00` at 7000 ms; sets "erased". RID `0200` (demo self-test): extended session only; start → `71 01 02 00 00`, stop → `71 02 02 00`, results → `71 03 02 00 01`. Other RID → `0x31` |
| 0x34 | programming session only (`0x7F`); length ≥ 5; data format identifier must be 00 else `0x31`; address-and-length format with both widths 1..4 and a matching total length else `0x13`; security (`0x33`); address range `0x08000000..0x080FFFFF` and size > 0 and inside the range else `0x31`; not erased → `0x24`. Positive `74 20 01 00` (max block 256 bytes) and start a download context |
| 0x36 | programming session only; no download → `0x24`; length ≥ 2 else `0x13`; block counter must be `previous + 1` (starting at 1, wrapping 255 → 0), else `0x73`; request longer than 256 bytes → `0x13`; total over the announced size → `0x72`. Positive `76 <counter>` |
| 0x37 | programming session only; no download or received ≠ announced size → `0x24`. Positive `77`, download context cleared, "erased" cleared |
| 0x3E | length 2; sub 00 → `7E 00`; sub 80 → no response; others `0x12` |
| 0x85 | extended session only (`0x7F`); sub 01 or 02 else `0x12`. Positive `C5 <sub>` |

**Demo data (exact values, tests depend on them)**
- DIDs: `F190` = ASCII `EGTEST12345678901`; `F187` = `EG-DEMO-0001`; `F189` = `1.0.3`; `F18A` = `EMBEDDED GARAGE`; `F18C` = `0000042`;
  `F191` = `HW-A1`; `F195` = `SW-1.0.3`; `F186` = 1 byte, the active session (dynamic); `F198` = 6 bytes, default `00 00 00 00 00 00`, writable;
  `0100` = 2 bytes battery voltage in millivolts, `12480 + ((floor(nowMs/1000) * 37) % 60)` (dynamic); `0101` = 1 byte coolant, raw `0x5A`.
- DTCs: `03 00 00` status `2F` (P0300-00); `01 13 00` status `08` (P0113-00); `C1 00 87` status `09` (U0100-87).
- Demo security algorithm (made up; show it in the UI): `key = (ROL32(seed XOR 0xC0FFEE11, 5) + 0x1234ABCD) mod 2^32`, seed and key big-endian 4 bytes.
  Known answers: seed `12345678` → key `6BABB907`; seed `00000001` → key `32326DE5`; seed `DEADBEEF` → key `DC7ECB90`.
- PRNG for seeds: `state = (imul(state, 1664525) + 1013904223) >>> 0`, initial state `0x1BADB002`, never emit 0 (advance again).

**Virtual clock (UI)**: simulated time = real elapsed time + a virtual offset. After an exchange whose last response is scheduled `D` ms in the
future, the offset grows by `D` so later requests come after it. The S3 countdown shown in the UI uses this clock; a timer calls `tick` four times per second.

## 9. Interface

Single page, three tabs (`Decode`, `Simulate`, `Reference`) implemented as real tabs (`role="tablist"`, `role="tab"`, `role="tabpanel"`, arrow-key navigation).
Routing uses only the URL hash: `#decode` (default), `#simulate`, `#reference`; the hash is read on load and on `hashchange`.

**Decode tab**
- Large monospace textarea pre-filled with the basic example. Controls: example picker (basic session, CAN FD multi-frame, error cases), addressing select
  (normal / extended), request IDs and response IDs inputs (comma-separated hex), "Only problems" checkbox, Decode button (also decodes live while typing, debounced 250 ms), Clear.
- Summary line: frames, messages, problems, ignored lines (expandable list of ignored lines with line numbers).
- **Messages list** (first, because it is the answer): one row per message with number, direction chip (Tester → ECU / ECU → Tester / unknown), CAN ID, time, and the UDS `summary`.
  Negative responses use the warning colour, errors the error colour. Responses show the latency to their request. Each row expands to: coloured byte chips (role colours, each chip shows
  the hex byte; hovering or focusing shows the field label), a field table (label, bytes, meaning), notes, and the ISO-TP frames that formed the message.
- **Frame timeline** (second, collapsible, open by default): table with index, time, ID, length, data bytes with the PCI bytes highlighted, ISO-TP meaning (`SF · 3 bytes`, `FF · total 20 bytes`, `CF · SN 1`, `FC · ContinueToSend, BS 0, STmin 0 ms`), problem markers. Clicking a row scrolls to its message.
- Copy button on every byte group and on the whole decoded summary (use `navigator.clipboard.writeText` inside the click handler, catch rejection and fall back to selecting the text).

**Simulate tab**
- Status panel: session, S3 countdown bar, security (locked / unlocked / locked out with seconds left, attempts), communication state, download progress, DTC count, a "Reset ECU" button. Shows the current seed and the "Compute key" helper with the algorithm text.
- Bus settings: request ID, response ID, functional addressing toggle, CAN FD toggle (+ BRS, frame size), padding byte, STmin.
- Composer: hex input + Send (Enter sends), quick buttons (`10 01`, `10 02`, `10 03`, `3E 00`, `22 F190`, `22 F186 F187`, `27 01`, `27 02` with the key inserted automatically, `2E F198 …`, `19 02 FF`, `14 FFFFFF`, `31 01 FF00`, `34 …`, `36 …`, `37`, `11 01`, `28 03 01`, `85 02`), and a keep-alive toggle that sends `3E 80` every 2 s.
- Session log: each exchange as a card: request (decoded), ECU responses (decoded, in time order with their timestamps, including pending `0x78`), and a collapsed list of the frames on the bus. Events (S3 timeout, session change, lockout) appear as small separators.
- Frame log as candump `-L` text with Copy and "Open in Decode" (puts the text in the Decode tab and switches to it).

**Reference tab**: tables generated from the same data as the decoder (services with request and response SID, NRCs, ISO-TP frame types with PCI values, DTC status bits, sessions, the PID formulas) and a legend of the byte colours.

**General**
- Opens in a realistic state (example decoded). No empty shells.
- Works embedded in an iframe on another site. No `alert`, `confirm` or `prompt`. No printing or file download buttons.
- Footer: one line stating that the simulator is a teaching model and that details should be checked against the standard; "Built by Embedded Garage".

## 10. Visual design

Direction: a bench instrument. Dark first, quiet, with the signal colour reserved for the active/selected thing and the byte-role colours doing the visual work.

- Colour tokens (dark values on bare `:root`; define every colour as a token; light variant under `@media (prefers-color-scheme: light)` and `:root[data-theme="light"]`):
  `--bg #0B0D10`, surface `#12161B`, raised surface `#181D24`, line `#252C35`, text `#E7EAEE`, muted text `#8E99A6`, accent (signal amber) `#F59E0B`.
  Light variant: bg `#F4F5F7`, surface `#FFFFFF`, text `#14181D`, accent `#B45309` (darker amber for contrast).
  Byte roles (hue-separated, each with enough contrast on the surface): sid amber, sub sky blue, id green, meta violet-grey, data neutral, nrc red. Warning and error colours are separate from the accent.
- Typography: display and labels `Barlow Condensed` (500/600/700, uppercase labels with letter-spacing), body `IBM Plex Sans` (400/500/600), data and bytes `IBM Plex Mono` (400/500/600). Google Fonts link with `display=swap`; real fallbacks (`system-ui`, `ui-monospace`). `font-variant-numeric: tabular-nums` wherever digits align.
- Layout: max content width about 1180 px; side gutter at least 16 px at every width; Decode uses two columns on wide screens (input left, results right) and one column below ~900 px; tables scroll inside their own container; the page never scrolls horizontally at 400 px.
- Focus states visible; `prefers-reduced-motion` respected; no decorative animation except the S3 bar.
- Voice: plain and direct. Errors say what happened and what to do. Nothing cute.

## 11. Quality bar

- **Tests**: `node --test test/`. Core tests cover every vector in `docs/TEST_VECTORS.md` plus property tests (segment → reassemble) and fuzz-style tests (random bytes and random text never throw). Simulator tests cover every flow in section 5 of the vectors.
- **Robustness**: no uncaught exceptions on any input; huge inputs are handled (10,000 frames decode in under 1 s; the UI renders messages in chunks).
- **Security**: all user-derived text goes through `textContent` / DOM nodes, never `innerHTML`.
- **Size**: `dist/index.html` under 300 KB.
- **Accessibility**: keyboard operable, tab roles, contrast checked in both themes, information never conveyed by colour alone.
- **Honesty**: `// VERIFY` markers and `docs/VERIFY.md` for anything not certain.

## 12. Acceptance checklist

- [ ] `npm test` green; `npm run build` produces `dist/index.html` with no external requests except Google Fonts.
- [ ] Every vector in `docs/TEST_VECTORS.md` passes.
- [ ] Decode: all seven formats parse; ISO-TP errors are flagged; example decodes on first load.
- [ ] Simulate: full programming flow works, lockout and S3 timeout work, frames decode back to the same messages in Decode.
- [ ] 400 px width: no horizontal page scroll; both themes readable.
- [ ] No personal names, employer names or e-mail addresses anywhere in the repository.
- [ ] `PROGRESS.md`, `docs/DECISIONS.md`, `docs/VERIFY.md` are filled in; pull request opened.
