// Core decoder tests by Embedded Garage: every vector in docs/TEST_VECTORS.md sections 1 to 4, plus property and fuzz tests.
'use strict'; // strict mode for the test file too

const test = require('node:test'); // built-in test runner
const assert = require('node:assert/strict'); // strict assertions
const E = require('../src/core.js'); // the module under test

/**
 * Converts "22 F1 90" or "22F190" into bytes.
 * @param {string} s hex text
 * @returns {number[]} bytes
 */
function h(s) {
  return E.parseHexBytes(s).bytes; // reuse the core parser (itself tested below)
}

/**
 * Parses one line and returns its only frame.
 * @param {string} line log line
 * @returns {object} frame
 */
function frameOf(line) {
  const r = E.parseLog(line); // parse
  assert.equal(r.frames.length, 1, 'expected one frame from: ' + line); // exactly one frame
  return r.frames[0]; // the frame
}

/**
 * Decodes a payload given as hex text.
 * @param {string} hex payload
 * @param {string} dir 'req' or 'rsp'
 * @param {string} [req] paired request payload as hex
 * @returns {object} decode result
 */
function dec(hex, dir, req) {
  return E.decodeUds(h(hex), { dir, request: req ? h(req) : null }); // decode
}

/**
 * Asserts that fields cover every payload byte exactly once and in order.
 * @param {number[]} p payload
 * @param {object} r decode result
 */
function assertCoverage(p, r) {
  const flat = []; // bytes from all fields in order
  for (const f of r.fields) flat.push(...f.bytes); // concatenate
  assert.deepEqual(flat, p, 'fields must cover the payload exactly'); // same bytes, same order
}

/**
 * Finds a field by label (exact or prefix).
 * @param {object} r decode result
 * @param {string} label label or prefix
 * @returns {object} field
 */
function field(r, label) {
  const f = r.fields.find((x) => x.label === label) || r.fields.find((x) => x.label.startsWith(label)); // exact first
  assert.ok(f, 'missing field ' + label + ' in ' + r.fields.map((x) => x.label).join(', ')); // must exist
  return f; // the field
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. Parsing
// ---------------------------------------------------------------------------------------------------------------------

test('1 parsing: candump -L classic', () => {
  const f = frameOf('(0.001000) can0 7E0#0210030000000000'); // vector line
  assert.equal(f.time, 0.001); assert.equal(f.iface, 'can0'); assert.equal(f.id, 0x7E0); // time, interface, ID
  assert.equal(f.ext, false); assert.equal(f.fd, false); assert.equal(f.data.length, 8); // flags and length
});

test('1 parsing: candump -L 29-bit', () => {
  const f = frameOf('(0.002000) can0 18DAF110#0210030000000000'); // vector line
  assert.equal(f.id, 0x18DAF110); assert.equal(f.ext, true); // 29-bit ID
});

test('1 parsing: candump -L CAN FD with BRS', () => {
  const f = frameOf('(0.003000) can0 7E0##1000922F190F186F187F189AA'); // vector line
  assert.equal(f.fd, true); assert.equal(f.brs, true); // FD flags
  assert.deepEqual(f.data, h('00 09 22 F1 90 F1 86 F1 87 F1 89 AA')); // 12 data bytes
});

test('1 parsing: candump default without time', () => {
  const f = frameOf('  can0  7E8   [8]  06 50 03 00 32 01 F4 AA'); // vector line
  assert.equal(f.id, 0x7E8); assert.equal(f.data.length, 8); assert.equal(f.time, null); // no time
});

test('1 parsing: candump default with time', () => {
  const f = frameOf('(1698484800.123456) can0 7E8 [3] 02 50 03'); // optional leading time
  assert.equal(f.time, 1698484800.123456); assert.deepEqual(f.data, [0x02, 0x50, 0x03]); // parsed
});

test('1 parsing: Vector ASC', () => {
  const f = frameOf('   0.016000 1  7E0             Tx   d 8 02 10 03 00 00 00 00 00'); // vector line
  assert.equal(f.time, 0.016); assert.equal(f.dirHint, 'req'); assert.equal(f.id, 0x7E0); // time and hint
  const g = frameOf('0.020000 1 18DAF110x Rx d 3 02 50 03 Length = 0 BitCount = 0'); // extended ID and trailing fields
  assert.equal(g.ext, true); assert.equal(g.dirHint, 'rsp'); assert.deepEqual(g.data, [0x02, 0x50, 0x03]); // parsed
});

test('1 parsing: plain formats', () => {
  const f = frameOf('7E8: 06 50 03 00 32 01 F4 AA'); // colon form
  assert.equal(f.id, 0x7E8); assert.equal(f.data.length, 8); // parsed
  const g = frameOf('7E0#0210030000000000'); // hash form
  assert.equal(g.id, 0x7E0); assert.equal(g.data.length, 8); // parsed
  const k = frameOf('7E0 02 10 03'); // space form
  assert.deepEqual(k.data, [0x02, 0x10, 0x03]); // parsed
});

test('1 parsing: raw UDS payload', () => {
  const r = E.parseLog('22 F1 90'); // vector line
  assert.equal(r.frames.length, 0); assert.deepEqual(r.raws[0].data, [0x22, 0xF1, 0x90]); // raw, no frame
});

test('1 parsing: malformed lines go to ignored with line numbers', () => {
  const r = E.parseLog('7E0#021003000000000\nhello world'); // odd digits, nonsense
  assert.equal(r.frames.length, 0); // nothing parsed
  assert.deepEqual(r.ignored.map((x) => x.line), [1, 2]); // 1-based line numbers
});

test('1 parsing: comments and blank lines are skipped, not ignored', () => {
  const r = E.parseLog('# comment\n\n   \n// another\n7E0#0210030000000000'); // comments and blanks
  assert.equal(r.ignored.length, 0); assert.equal(r.frames.length, 1); // only the frame
  assert.equal(r.frames[0].line, 5); // line numbers still count skipped lines
});

test('1 parsing: classic data over 8 bytes is FD', () => {
  assert.equal(frameOf('7E0#000922F190F186F187F189AA').fd, true); // 12 bytes with a single #
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. ISO-TP
// ---------------------------------------------------------------------------------------------------------------------

const VIN_LOG = [ // vector 2.2
  '(0.000000) can0 7E0#0322F19000000000',
  '(0.003000) can0 7E8#101462F190454754',
  '(0.003500) can0 7E0#300000AAAAAAAAAA',
  '(0.004000) can0 7E8#2145535431323334',
  '(0.004200) can0 7E8#2235363738393031',
];

test('2.1 single frames', () => {
  let r = E.decodeAll('7E0#0210030000000000'); // request
  assert.equal(r.messages.length, 1); assert.equal(r.messages[0].kind, 'SF'); // one SF
  assert.deepEqual(r.messages[0].payload, [0x10, 0x03]); assert.equal(r.messages[0].dir, 'req'); // payload and direction
  r = E.decodeAll('7E8#065003003201F4AA'); // response
  assert.deepEqual(r.messages[0].payload, h('50 03 00 32 01 F4')); assert.equal(r.messages[0].dir, 'rsp'); // padding ignored
});

test('2.1 single frame errors', () => {
  let r = E.decodeAll('7E0#0010030000000000'); // SF_DL 0
  assert.equal(r.messages.length, 0); // nothing emitted
  assert.ok(r.events.some((e) => e.level === 'error' && e.text.includes('SF_DL = 0 is invalid in a classic CAN frame'))); // spec wording
  r = E.decodeAll('7E0#0810030000000000'); // SF_DL 8 in 8 bytes
  assert.equal(r.messages.length, 0); // nothing emitted
  assert.ok(r.events.some((e) => e.level === 'error' && e.text.includes('does not fit'))); // explained
});

test('2.2 multi-frame VIN read', () => {
  const r = E.decodeAll(VIN_LOG.join('\n')); // the session
  assert.equal(r.messages.length, 2); // request + response
  const [m1, m2] = r.messages; // both messages
  assert.deepEqual(m1.payload, h('22 F1 90')); // request
  assert.equal(m2.kind, 'MF'); assert.equal(m2.payload.length, 20); // response
  assert.deepEqual(m2.payload, [0x62, 0xF1, 0x90, ...Buffer.from('EGTEST12345678901')]); // bytes
  assert.deepEqual(m2.frameIdx, [1, 3, 4]); // frames 2, 4 and 5 (1-based in the vector)
  assert.equal(r.timeline[2].msgNo, null); // the FC belongs to no message
  assert.ok(r.timeline[2].text.startsWith('FC · ContinueToSend, BS 0 (no limit), STmin 0 ms')); // FC text
  assert.equal(r.events.length, 0); // clean session
  const u = m2.uds; // decoded response
  assert.equal(u.kind, 'positive'); assert.equal(u.name, 'ReadDataByIdentifier'); // service
  assert.ok(field(u, 'dataIdentifier').text.includes('F190 VIN')); // DID name
  assert.equal(field(u, 'F190 data').text, '"EGTEST12345678901"'); // VIN text
  assert.equal(m2.reqNo, 1); // paired with message 1
  assert.ok(Math.abs(m2.latencyMs - 3.0) < 1e-9); // 0.003 − 0.000 s
});

test('2.3 sequence error then orphan', () => {
  const lines = VIN_LOG.slice(); // copy
  lines[3] = '(0.004000) can0 7E8#2345535431323334'; // SN 3 instead of SN 1
  const r = E.decodeAll(lines.join('\n')); // decode
  assert.ok(r.events.some((e) => e.level === 'error' && e.text.includes('expected SN 1, got 3'))); // sequence error
  const partial = r.messages.find((m) => m.partial); // partial message
  assert.ok(partial); assert.ok(partial.error); // flagged
  assert.deepEqual(partial.payload, h('62 F1 90 45 47 54')); // first 6 bytes
  assert.ok(r.events.some((e) => e.index === 4 && e.text.includes('orphan Consecutive Frame'))); // next CF is an orphan
});

test('2.3 orphan, incomplete, new FF, invalid PCI', () => {
  let r = E.decodeAll('7E8#2145535431323334'); // lone CF
  assert.ok(r.events.some((e) => e.level === 'error' && e.text.includes('orphan Consecutive Frame'))); // orphan
  r = E.decodeAll('7E8#101462F190454754'); // lone FF
  assert.equal(r.messages.length, 1); assert.equal(r.messages[0].partial, true); // partial emitted
  assert.ok(r.events.some((e) => e.level === 'warn' && e.text.includes('received 6 of 20 bytes'))); // warning
  r = E.decodeAll('7E8#101462F190454754\n7E8#101462F190454754'); // two FFs
  assert.ok(r.events.some((e) => e.level === 'warn' && e.text.includes('discarded'))); // first one dropped
  assert.equal(r.messages.length, 1); // only the second (incomplete) transfer remains
  r = E.decodeAll('7E8#4112345678000000'); // PCI type 4
  assert.ok(r.events.some((e) => e.level === 'error' && e.text.includes('invalid PCI type 4'))); // spec wording
});

test('2.3 flow control variants', () => {
  let r = E.decodeAll('7E0#300A7FAAAAAAAAAA'); // BS 10, STmin 127
  assert.ok(r.timeline[0].text.includes('BS 10, STmin 127 ms')); // parameters
  r = E.decodeAll('7E0#3000F1AAAAAAAAAA'); // STmin 100 µs
  assert.ok(r.timeline[0].text.includes('STmin 100 µs')); // parameters
  r = E.decodeAll('7E0#3200000000000000'); // overflow
  assert.ok(r.events.some((e) => e.level === 'error' && e.text.includes('receiver reports buffer overflow'))); // error
  r = E.decodeAll('7E0#3300000000000000'); // invalid FS
  assert.ok(r.events.some((e) => e.level === 'error' && e.text.includes('invalid FlowStatus 3'))); // error
  assert.equal(r.messages.length, 0); // FC frames are never messages
});

test('2.4 CAN FD single frame with escape length', () => {
  const r = E.decodeAll('7E0##1000922F190F186F187F189AA'); // 12 data bytes
  assert.equal(r.messages.length, 1); // one message
  assert.deepEqual(r.messages[0].payload, h('22 F1 90 F1 86 F1 87 F1 89')); // payload
  const ids = r.messages[0].uds.fields.filter((f) => f.label === 'dataIdentifier'); // DIDs
  assert.equal(ids.length, 4); assert.equal(r.messages[0].uds.name, 'ReadDataByIdentifier'); // four DIDs
  assert.equal(r.events.length, 0); // valid
});

test('2.4 CAN FD 4-bit SF_DL in a 12-byte frame', () => {
  const r = E.decodeAll('7E0##00322F1900000000000000000'); // 12 data bytes starting 03 22 F1 90
  assert.deepEqual(r.messages[0].payload, h('22 F1 90')); // payload
  assert.ok(r.events.some((e) => e.level === 'warn' && e.text.includes('escape form is required above 8 bytes'))); // warning
});

test('2.4 escaped First Frame for 5000 bytes', () => {
  const p = Array.from({ length: 5000 }, (_, i) => i & 0xFF); // payload
  const frames = E.segment(p, { fd: true, canDl: 64 }); // segment
  assert.deepEqual(frames[0].slice(0, 6), h('10 00 00 00 13 88')); // escaped FF header
  assert.equal(frames[0].length - 6, 58); // payload bytes in the FF
  const objs = frames.map((d, i) => ({ index: i, line: i + 1, time: i / 1000, id: 0x7E8, ext: false, fd: true, brs: false, data: d })); // frame objects
  const r = E.reassemble(objs); // reassemble
  assert.equal(r.messages.length, 1); assert.deepEqual(r.messages[0].payload, p); // round trip
});

test('2.5 extended addressing', () => {
  const r = E.decodeAll('7E0#F102100300000000', { addressing: 'extended' }); // address byte F1
  assert.equal(r.messages.length, 1); assert.equal(r.messages[0].addr, 0xF1); // address
  assert.equal(r.messages[0].kind, 'SF'); assert.deepEqual(r.messages[0].payload, [0x10, 0x03]); // payload
});

test('2.6 STmin text', () => {
  assert.equal(E.stminText(0x00), '0 ms'); assert.equal(E.stminText(0x7F), '127 ms'); // milliseconds
  assert.ok(E.stminText(0x80).startsWith('reserved')); // reserved
  assert.equal(E.stminText(0xF1), '100 µs'); assert.equal(E.stminText(0xF9), '900 µs'); // microseconds
  assert.ok(E.stminText(0xFA).startsWith('reserved')); // reserved
});

test('2.7 round trip segment → reassemble (property)', () => {
  const lengths = []; // payload lengths under test
  for (let n = 1; n <= 200; n++) lengths.push(n); // 1..200
  lengths.push(4095, 4096, 5000); // length-field boundaries
  const legal = new Set(E.tables.DLC_SIZES); // legal FD sizes
  const combos = [{ fd: false, canDl: 8 }, { fd: true, canDl: 8 }, { fd: true, canDl: 12 }, { fd: true, canDl: 64 }]; // classic / FD sizes
  for (const c of combos) for (const ext of [false, true]) for (const pad of [null, 0xAA]) for (const n of lengths) { // every combination
    const p = Array.from({ length: n }, (_, i) => i & 0xFF); // bytes cycle 0..255
    const frames = E.segment(p, { fd: c.fd, canDl: c.canDl, pad, extAddr: ext ? 0xF1 : null }); // segment
    for (const d of frames) { // frame size checks
      if (c.fd) assert.ok(legal.has(d.length), 'illegal FD length ' + d.length); // legal DLC size
      else assert.ok(d.length <= 8, 'classic frame longer than 8'); // classic limit
      if (!c.fd && pad !== null) assert.equal(d.length, 8); // classic padding fills to 8
    }
    const objs = frames.map((d, i) => ({ index: i, line: i + 1, time: 0, id: 0x7E0, ext: false, fd: c.fd, brs: false, data: d })); // frame objects
    const r = E.reassemble(objs, { addressing: ext ? 'extended' : 'normal' }); // reassemble
    const tag = JSON.stringify({ ...c, ext, pad, n }); // for failure messages
    assert.equal(r.messages.length, 1, tag); // exactly one message
    assert.deepEqual(r.messages[0].payload, p, tag); // identical payload
    assert.equal(r.events.length, 0, tag + ' ' + JSON.stringify(r.events)); // no events
  }
});

test('2 flowControl and formatCandump', () => {
  assert.deepEqual(E.flowControl({ pad: 0xAA }, 0, 0, 0), h('30 00 00 AA AA AA AA AA')); // padded FC
  assert.deepEqual(E.flowControl({}, 0, 8, 20), h('30 08 14')); // unpadded FC
  assert.equal(E.formatCandump({ t: 1.5, id: 0x7E0, ext: false, data: [0x02, 0x10, 0x03] }), '(1.500000) can0 7E0#021003'); // classic
  assert.equal(E.formatCandump({ t: 0, id: 0x18DAF110, ext: true, data: [1], fd: true, brs: true }, 'vcan0'), '(0.000000) vcan0 18DAF110##101'); // FD
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. UDS decoding
// ---------------------------------------------------------------------------------------------------------------------

/** Vectors from section 3 with exact summaries where the vector gives one. */
const SUMMARY_VECTORS = [
  ['10 03', 'req', 'DiagnosticSessionControl · extendedDiagnosticSession'],
  ['10 83', 'req', 'DiagnosticSessionControl · extendedDiagnosticSession'],
  ['50 03 00 32 01 F4', 'rsp', '+ DiagnosticSessionControl · extendedDiagnosticSession · P2 50 ms · P2* 5000 ms'],
  ['11 01', 'req', 'ECUReset · hardReset'],
  ['51 01', 'rsp', '+ ECUReset · hardReset'],
  ['27 01', 'req', 'SecurityAccess · requestSeed (level 1)'],
  ['67 01 12 34 56 78', 'rsp', '+ SecurityAccess · requestSeed (level 1)'],
  ['27 02 6B AB B9 07', 'req', 'SecurityAccess · sendKey (level 1)'],
  ['67 02', 'rsp', '+ SecurityAccess · sendKey (level 1)'],
  ['27 03', 'req', 'SecurityAccess · requestSeed (level 2)'],
  ['7F 27 35', 'rsp', '− SecurityAccess · invalidKey (0x35)'],
  ['7F 22 31', 'rsp', '− ReadDataByIdentifier · requestOutOfRange (0x31)'],
  ['2E F1 98 01 02 03 04 05 06', 'req', 'WriteDataByIdentifier · F198'],
  ['6E F1 98', 'rsp', '+ WriteDataByIdentifier · F198'],
  ['14 FF FF FF', 'req', 'ClearDiagnosticInformation · all DTCs'],
  ['31 01 FF 00', 'req', 'RoutineControl · startRoutine FF00 eraseMemory'],
  ['37', 'req', 'RequestTransferExit'],
  ['77', 'rsp', '+ RequestTransferExit'],
  ['85 02', 'req', 'ControlDTCSetting · DTC setting off'],
];

for (const [hex, dir, summary] of SUMMARY_VECTORS) { // one test per vector
  test('3 summary: ' + hex, () => {
    const r = dec(hex, dir); // decode
    assert.equal(r.summary, summary); // exact summary
    assertCoverage(h(hex), r); // every byte in exactly one field
  });
}

test('3 suppress bit shown in field text', () => {
  const r = dec('10 83', 'req'); // suppress bit set
  assert.ok(field(r, 'diagnosticSessionType').text.includes('suppressPosRspMsg = 1')); // field text
  assert.ok(dec('10 03', 'req').fields[1].text.includes('suppressPosRspMsg = 0')); // and clear
});

test('3 SecurityAccess seed fields', () => {
  let r = dec('67 01 12 34 56 78', 'rsp'); // seed
  assert.equal(field(r, 'securitySeed').bytes.length, 4); // 4-byte seed field
  r = dec('67 01 00 00 00 00', 'rsp'); // zero seed
  assert.ok(field(r, 'securitySeed').text.includes('already unlocked')); // explained
});

test('3 negative responses', () => {
  let r = dec('7F 27 35', 'rsp'); // invalid key
  assert.equal(r.kind, 'negative'); assert.equal(r.level, 'warn'); // warning level
  r = dec('7F 31 78', 'rsp'); // response pending
  assert.equal(r.pending, true); assert.equal(r.level, 'info'); // pending, info
  r = dec('7F 99 11', 'rsp'); // unknown service
  assert.equal(r.name, 'Service 0x99'); assert.ok(field(r, 'negativeResponseCode').text.startsWith('serviceNotSupported')); // names
});

test('3 NRC names including reserved ranges', () => {
  assert.equal(E.nrcName(0x40), 'reservedByExtendedDataLinkSecurityDocument'); // 0x38..0x4F
  for (let c = 0; c < 256; c++) assert.equal(typeof E.nrcName(c), 'string'); // every value has a name
});

test('3 ReadDataByIdentifier request DIDs', () => {
  const r = dec('22 F1 90 F1 86', 'req'); // two DIDs
  const ids = r.fields.filter((f) => f.label === 'dataIdentifier'); // DID fields
  assert.deepEqual(ids.map((f) => f.text), ['F190 VIN', 'F186 activeDiagnosticSession']); // IDs and names
  assert.ok(r.summary.includes('F190, F186')); // listed in the summary
});

test('3 ReadDataByIdentifier response with one requested DID', () => {
  const p = '62 F1 90 45 47 54 45 53 54 31 32 33 34 35 36 37 38 39 30 31'; // VIN response
  const r = dec(p, 'rsp', '22 F1 90'); // with its request
  assert.equal(field(r, 'F190 data').text, '"EGTEST12345678901"'); // VIN text
  assertCoverage(h(p), r); // coverage
});

test('3 ReadDataByIdentifier response split by requested DIDs', () => {
  const p = '62 F1 90 45 47 54 45 53 54 31 32 33 34 35 36 37 38 39 30 31 F1 86 03'; // two records
  const r = dec(p, 'rsp', '22 F1 90 F1 86'); // with its request
  assert.equal(field(r, 'F190 data').text, '"EGTEST12345678901"'); // first record
  assert.deepEqual(field(r, 'F186 data').bytes, [0x03]); // second record
  assert.ok(r.notes.some((n) => n.level === 'info' && n.text.includes('split'))); // heuristic note
  assertCoverage(h(p), r); // coverage
});

test('3 ReadDataByIdentifier response without request', () => {
  const p = '62 F1 90 45 47 54 45 53 54 31 32 33 34 35 36 37 38 39 30 31 F1 86 03'; // two records, no request
  const r = dec(p, 'rsp'); // decode alone
  assert.equal(r.fields.filter((f) => f.label === 'dataIdentifier').length, 1); // only the first DID is separated
  assertCoverage(h(p), r); // coverage
});

test('3 ReadDTCInformation', () => {
  let r = dec('19 02 09', 'req'); // by status mask
  assert.ok(r.summary.includes('reportDTCByStatusMask')); // sub-function
  const mask = field(r, 'DTCStatusMask').text; // mask text
  assert.ok(mask.includes('testFailed') && mask.includes('confirmedDTC')); // bits
  r = dec('59 02 FF 01 33 00 2F C1 00 87 08', 'rsp'); // two DTC records
  assert.equal(field(r, 'DTCStatusAvailabilityMask').bytes[0], 0xFF); // mask
  assert.equal(field(r, 'DTC 1').text, 'P0133-00'); // first DTC
  assert.equal(field(r, 'statusOfDTC 1').text, '0x2F: testFailed, testFailedThisOperationCycle, pendingDTC, confirmedDTC, testFailedSinceLastClear'); // status bits
  assert.equal(field(r, 'DTC 2').text, 'U0100-87'); // second DTC
  assert.equal(field(r, 'statusOfDTC 2').text, '0x08: confirmedDTC'); // status bits
  assert.ok(r.detail.includes('2 DTCs')); // detail
  r = dec('59 01 FF 01 00 03', 'rsp'); // count
  assert.ok(r.summary.includes('reportNumberOfDTCByStatusMask')); // sub-function
  assert.equal(field(r, 'DTCFormatIdentifier').text, 'ISO 14229-1 DTC format'); // format
  assert.equal(field(r, 'DTCCount').text, '3'); // count
});

test('3 RoutineControl response', () => {
  const r = dec('71 01 FF 00 00', 'rsp'); // status record 00
  assert.deepEqual(field(r, 'routineStatusRecord').bytes, [0x00]); // status record
});

test('3 Request/TransferData', () => {
  let r = dec('34 00 44 08 00 00 00 00 00 10 00', 'req'); // RequestDownload
  assert.ok(field(r, 'dataFormatIdentifier').text.includes('no compression') && field(r, 'dataFormatIdentifier').text.includes('no encryption')); // format
  assert.equal(field(r, 'memoryAddress').text, '0x08000000'); // address
  assert.equal(field(r, 'memorySize').text, '4096 bytes'); // size
  r = dec('74 20 01 00', 'rsp'); // response
  assert.ok(field(r, 'maxNumberOfBlockLength').text.startsWith('256 bytes → 254 data bytes')); // block length
  r = dec('36 01 AA BB CC', 'req'); // TransferData
  assert.ok(r.summary.includes('block 1, 3 data bytes')); // counter and length
  r = dec('76 01', 'rsp'); // response
  assert.ok(r.summary.includes('block 1')); // counter
});

test('3 CommunicationControl and TesterPresent', () => {
  let r = dec('28 03 01', 'req'); // disable Rx and Tx
  assert.ok(r.summary.includes('disableRxAndTx') && r.summary.includes('normalCommunicationMessages')); // names
  r = dec('3E 00', 'req'); // tester present
  assert.ok(r.summary.startsWith('TesterPresent')); // name
  r = dec('3E 80', 'req'); // with suppress bit
  assert.ok(r.summary.startsWith('TesterPresent') && field(r, 'zeroSubFunction').text.includes('suppressPosRspMsg = 1')); // suppress bit
  r = dec('7E 00', 'rsp'); // response
  assert.ok(r.summary.startsWith('+ TesterPresent')); // positive
});

test('3 truncated, empty and unknown', () => {
  let r = dec('10', 'req'); // missing session byte
  assert.ok(r.notes.some((n) => n.level === 'error' && n.text === 'Truncated message: diagnosticSessionType needs 1 byte')); // spec wording
  r = E.decodeUds([], { dir: 'req' }); // empty
  assert.equal(r.summary, 'empty message'); assert.equal(r.level, 'error'); // error
  r = dec('55 01 02', 'req'); // unknown
  assert.ok(r.notes.some((n) => n.level === 'warn')); assertCoverage(h('55 01 02'), r); // warning, raw bytes
});

test('3 other services decode name and stay raw', () => {
  const r = dec('29 05 01 02', 'req'); // Authentication
  assert.ok(r.summary.startsWith('Authentication')); // name
  assert.ok(r.notes.some((n) => n.level === 'info' && n.text.includes('not implemented'))); // honesty note
  assertCoverage(h('29 05 01 02'), r); // coverage
});

test('3 pairing keeps a request open across 0x78', () => {
  const log = ['(0.000) can0 7E0#043101FF00000000', '(0.050) can0 7E8#037F3178AAAAAAAA', '(4.050) can0 7E8#037F3178AAAAAAAA', '(7.000) can0 7E8#057101FF0000AAAA'].join('\n'); // erase with two pending responses
  const r = E.decodeAll(log); // decode
  assert.equal(r.messages.length, 4); // request + three responses
  assert.deepEqual(r.messages.slice(1).map((m) => m.reqNo), [1, 1, 1]); // all paired with the request
  assert.ok(Math.abs(r.messages[3].latencyMs - 7000) < 1e-6); // final latency
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. OBD-II and DTC text
// ---------------------------------------------------------------------------------------------------------------------

test('4 OBD-II mode 01', () => {
  let r = dec('01 0C', 'req'); // engine speed request
  assert.ok(r.summary.startsWith('OBD-II Mode 01 ShowCurrentData')); // mode name
  assert.equal(field(r, 'PID').text, '0C engineSpeed'); // PID
  assert.ok(r.notes.some((n) => n.level === 'info' && n.text.includes('OBD-II'))); // OBD note
  r = dec('41 0C 1A F8', 'rsp'); // 1726 rpm
  assert.equal(field(r, 'engineSpeed').text, '1726 rpm'); // value
  r = dec('41 05 7B', 'rsp'); // 83 °C
  assert.equal(field(r, 'engineCoolantTemperature').text, '83 °C'); // value
  r = dec('41 0D 3C', 'rsp'); // 60 km/h
  assert.equal(field(r, 'vehicleSpeed').text, '60 km/h'); // value
  r = dec('41 00 BE 1F A8 13', 'rsp'); // supported PIDs
  assert.equal(field(r, 'pidsSupported01to20').text, 'PIDs supported: 01 03 04 05 06 07 0C 0D 0E 0F 10 11 13 15 1C 1F 20'); // exact list
});

test('4 OBD-II mode 03 and 09', () => {
  let r = dec('03', 'req'); // stored DTCs request
  assert.ok(r.summary.startsWith('OBD-II Mode 03')); // mode name
  r = dec('43 02 01 33 C1 00', 'rsp'); // two DTCs
  assert.equal(field(r, 'numberOfDTCs').text, '2'); // count
  assert.equal(field(r, 'DTC 1').text, 'P0133'); assert.equal(field(r, 'DTC 2').text, 'U0100'); // codes
  r = dec('09 02', 'req'); // VIN request
  assert.ok(r.summary.includes('VIN')); // info type
  r = dec('49 02 01 45 47 54 45 53 54 31 32 33 34 35 36 37 38 39 30 31', 'rsp'); // VIN response
  assert.equal(field(r, 'VIN').text, '"EGTEST12345678901"'); // VIN text
});

test('4 DTC text', () => {
  assert.equal(E.dtcText([0x01, 0x33]), 'P0133'); assert.equal(E.dtcText([0xC1, 0x00]), 'U0100'); // P and U
  assert.equal(E.dtcText([0x43, 0x21]), 'C0321'); assert.equal(E.dtcText([0x81, 0x23]), 'B0123'); // C and B
});

// ---------------------------------------------------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Small deterministic PRNG so fuzz failures are reproducible.
 * @param {number} seed start value
 * @returns {function(): number} next value 0..2^32-1
 */
function prng(seed) {
  let s = seed >>> 0; // state
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0); // LCG step
}

test('fuzz: random payloads never throw and are always fully covered', () => {
  const rnd = prng(42); // reproducible
  for (let i = 0; i < 20000; i++) { // many payloads
    const n = rnd() % 24; // length 0..23
    const p = Array.from({ length: n }, () => rnd() & 0xFF); // random bytes
    if (i % 3 === 0 && n) p[0] = [0x10, 0x19, 0x22, 0x27, 0x31, 0x34, 0x59, 0x62, 0x7F, 0x41, 0x43, 0x49][rnd() % 12]; // bias toward real services
    const r = E.decodeUds(p, { dir: rnd() & 1 ? 'req' : 'rsp', request: rnd() & 1 ? [0x22, p[1] || 0, p[2] || 0, 0xF1, 0x86] : null }); // decode
    if (n) assertCoverage(p, r); // coverage holds for every payload
    assert.equal(typeof r.summary, 'string'); // always a summary
  }
});

test('fuzz: random text and random frames never throw', () => {
  const rnd = prng(7); // reproducible
  const alphabet = '0123456789ABCDEFabcdef #()[]:.xTRd\n\t-'; // characters that look like logs
  for (let i = 0; i < 2000; i++) { // many logs
    let s = ''; // random text
    const n = rnd() % 200; // length
    for (let k = 0; k < n; k++) s += alphabet[rnd() % alphabet.length]; // build
    E.decodeAll(s); E.decodeAll(s, { addressing: 'extended' }); // must not throw
  }
  for (let i = 0; i < 3000; i++) { // random frames on a diagnostic ID
    const len = rnd() % 65; // 0..64 bytes
    const line = '7E8#' + Array.from({ length: len }, () => E.hex2(rnd() & 0xFF)).join(''); // one frame
    E.decodeAll(line + '\n' + line); // must not throw
  }
  E.decodeAll(null); E.decodeAll(undefined); E.reassemble([null, 5, {}]); E.decodeUds(null); E.annotate(null); // garbage arguments
});

test('performance: 10,000 frames decode in under one second', () => {
  const lines = []; // log lines
  for (let i = 0; i < 2000; i++) lines.push(...VIN_LOG.map((l) => l.replace(/^\(([\d.]+)\)/, (_, t) => '(' + (i + Number(t)).toFixed(6) + ')'))); // 2000 × 5 frames
  const t0 = Date.now(); // start
  const r = E.decodeAll(lines.join('\n')); // decode
  const ms = Date.now() - t0; // elapsed
  assert.equal(r.frames.length, 10000); assert.equal(r.messages.length, 4000); // all decoded
  assert.ok(ms < 1000, 'took ' + ms + ' ms'); // budget
});

test('ID roles and direction inference', () => {
  assert.equal(E.classifyId(0x7DF, false), 'req'); assert.equal(E.classifyId(0x7E3, false), 'req'); // requests
  assert.equal(E.classifyId(0x7EF, false), 'rsp'); assert.equal(E.classifyId(0x123, false), null); // response, unknown
  assert.equal(E.classifyId(0x18DAF110, true), 'rsp'); assert.equal(E.classifyId(0x18DA10F1, true), 'req'); // 29-bit physical
  assert.equal(E.classifyId(0x18DB33F1, true), 'req'); // 29-bit functional
  assert.equal(E.classifyId(0x123, false, { rspIds: [0x123] }), 'rsp'); // user list first
  assert.equal(E.inferDir([0x7F, 0x10, 0x12]), 'rsp'); assert.equal(E.inferDir([0x41, 0x0C]), 'rsp'); // negative, OBD
  assert.equal(E.inferDir([0x62, 0xF1]), 'rsp'); assert.equal(E.inferDir([0x22, 0xF1]), 'req'); // UDS
});

test('other bus traffic is skipped when diagnostic IDs are present', () => {
  const r = E.decodeAll('100#0102030405060708\n7E0#0210030000000000'); // cyclic frame + request
  assert.equal(r.messages.length, 1); assert.equal(r.timeline[0].kind, '--'); assert.equal(r.events.length, 0); // skipped quietly
});

test('hex input helpers', () => {
  assert.deepEqual(E.parseHexBytes('22 F190 0x01').bytes, [0x22, 0xF1, 0x90, 0x01]); // mixed groups
  assert.ok(E.parseHexBytes('2').error); assert.ok(E.parseHexBytes('zz').error); // errors
  assert.deepEqual(E.parseIdList('7E0, 18DAF110 ; x').ids, [0x7E0, 0x18DAF110]); // IDs
  assert.deepEqual(E.parseIdList('7E0, x').bad, ['x']); // bad tokens reported
});
