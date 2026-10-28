// Simulator tests by Embedded Garage: every flow in docs/TEST_VECTORS.md section 5.
'use strict'; // strict mode for the test file too

const test = require('node:test'); // built-in test runner
const assert = require('node:assert/strict'); // strict assertions
const E = require('../src/core.js'); // decoder (also used to check the bus trace)
const S = require('../src/sim.js'); // the module under test

/**
 * Converts hex text into bytes.
 * @param {string} s hex text
 * @returns {number[]} bytes
 */
function h(s) {
  return E.parseHexBytes(s).bytes; // reuse the core parser
}

/**
 * Wraps an ECU with a clock that advances 100 ms per request (vector convention).
 * @returns {{ecu: object, send: function, at: function, now: function}} driver
 */
function bench() {
  const ecu = S.createEcu(); // default config
  let t = 0; // virtual time in ms
  let first = true; // the first request is at t = 0
  return {
    ecu, // direct access
    /**
     * Sends a request 100 ms after the previous one and returns the response hex strings.
     * @param {string} hex request
     * @param {object} [opts] handle options
     * @returns {string[]} responses as hex
     */
    send(hex, opts) {
      if (!first) t += 100; else first = false; // 100 ms apart
      return ecu.handle(h(hex), t, opts).responses.map((r) => E.hexBytes(r.bytes)); // hex responses
    },
    /**
     * Sends a request at an absolute time.
     * @param {number} ms time
     * @param {string} hex request
     * @returns {string[]} responses as hex
     */
    at(ms, hex) {
      t = ms; first = false; // jump the clock
      return ecu.handle(h(hex), t).responses.map((r) => E.hexBytes(r.bytes)); // hex responses
    },
    /** @returns {number} current time */
    now: () => t,
  };
}

/**
 * Unlocks security in the current session using the demo key.
 * @param {object} b bench
 */
function unlock(b) {
  const seed = h(b.send('27 01')[0]).slice(2); // seed bytes
  assert.deepEqual(b.send('27 02 ' + E.hexBytes(S.demoKey(seed))), ['67 02']); // correct key accepted
}

const VIN = '45 47 54 45 53 54 31 32 33 34 35 36 37 38 39 30 31'; // "EGTEST12345678901"

// ---------------------------------------------------------------------------------------------------------------------
// 5.1 Basics
// ---------------------------------------------------------------------------------------------------------------------

test('5.1 basics', () => {
  const b = bench(); // fresh ECU
  assert.deepEqual(b.send('22 F1 90'), ['62 F1 90 ' + VIN]); // 1: VIN in the default session
  assert.deepEqual(b.send('22 F1 86'), ['62 F1 86 01']); // 2: default session
  assert.deepEqual(b.send('27 01'), ['7F 27 7F']); // 3: not in default
  assert.deepEqual(b.send('10 03'), ['50 03 00 32 01 F4']); // 4: extended
  assert.deepEqual(b.send('22 F1 86'), ['62 F1 86 03']); // 4: session byte follows
  assert.deepEqual(b.send('10'), ['7F 10 13']); // 5: length
  assert.deepEqual(b.send('10 05'), ['7F 10 12']); // 5: unsupported session
  assert.deepEqual(b.send('23 00 00'), ['7F 23 11']); // 6: unsupported service
  assert.deepEqual(b.send('23 00 00', { functional: true }), []); // 6: suppressed when functional
  assert.deepEqual(b.send('3E 00'), ['7E 00']); // 7
  assert.deepEqual(b.send('3E 80'), []); // 7: suppress bit
  assert.deepEqual(b.send('3E 05'), ['7F 3E 12']); // 7
  assert.deepEqual(b.send('22 DE AD'), ['7F 22 31']); // 8: unknown DID
  assert.deepEqual(b.send('22 F1 90 DE AD'), ['62 F1 90 ' + VIN]); // 8: unknown DID omitted
});

test('5.1.9 functional request ID 0x7DF', () => {
  const ecu = S.createEcu(); // fresh ECU
  let x = S.exchange(ecu, h('22 F1 90'), 0, { reqId: 0x7DF, pad: 0xAA }); // functional by ID
  assert.equal(x.functional, true); assert.equal(x.responses.length, 1); // answered
  assert.deepEqual(x.responses[0].bytes, h('62 F1 90 ' + VIN)); // VIN
  x = S.exchange(ecu, h('22 DE AD'), 1, { reqId: 0x7DF }); // unknown DID
  assert.equal(x.responses.length, 0); // NRC 0x31 suppressed
});

// ---------------------------------------------------------------------------------------------------------------------
// 5.2 Security
// ---------------------------------------------------------------------------------------------------------------------

test('5.2.1 seed, key, zero seed', () => {
  const b = bench(); // fresh ECU
  b.send('10 03'); // extended
  const r = b.send('27 01'); // seed
  assert.match(r[0], /^67 01 [0-9A-F ]{11}$/); // 4-byte seed
  const seed = h(r[0]).slice(2); // seed bytes
  assert.ok(seed.some((x) => x !== 0)); // non-zero
  assert.deepEqual(b.send('27 02 ' + E.hexBytes(S.demoKey(seed))), ['67 02']); // unlocked
  assert.deepEqual(b.send('27 01'), ['67 01 00 00 00 00']); // already unlocked
});

test('5.2.2 key without seed', () => {
  const b = bench(); // fresh ECU
  b.send('10 03'); // extended
  assert.deepEqual(b.send('27 02 00 00 00 00'), ['7F 27 24']); // sequence error
});

test('5.2.3 wrong keys, lockout and restart of the counter', () => {
  const b = bench(); // fresh ECU
  b.at(0, '10 03'); // extended at t = 0
  b.at(100, '27 01'); assert.deepEqual(b.at(200, '27 02 00 00 00 00'), ['7F 27 35']); // wrong key 1
  b.at(300, '27 01'); assert.deepEqual(b.at(400, '27 02 00 00 00 00'), ['7F 27 35']); // wrong key 2
  b.at(500, '27 01'); assert.deepEqual(b.at(600, '27 02 00 00 00 00'), ['7F 27 36']); // wrong key 3: lockout from 600
  assert.deepEqual(b.at(700, '27 01'), ['7F 27 37']); // within 10 000 ms
  b.at(4000, '3E 80'); b.at(8000, '3E 80'); // keep the extended session alive (S3 = 5000 ms)
  assert.deepEqual(b.at(10599, '27 01'), ['7F 27 37']); // still 1 ms short
  const r = b.at(10600, '27 01'); // lockout over
  assert.match(r[0], /^67 01 /); // seed works again
  assert.equal(b.ecu.snapshot(10600).attempts, 0); // counter restarted
  assert.deepEqual(b.at(10700, '27 02 00 00 00 00'), ['7F 27 35']); // first wrong key again, not a lockout
});

test('5.2.4 WriteDataByIdentifier F198', () => {
  const b = bench(); // fresh ECU
  assert.deepEqual(b.send('2E F1 98 01 02 03 04 05 06'), ['7F 2E 7F']); // default session
  b.send('10 03'); // extended
  assert.deepEqual(b.send('2E F1 98 01 02 03 04 05 06'), ['7F 2E 33']); // locked
  unlock(b); // unlock
  assert.deepEqual(b.send('2E F1 98 01 02 03 04 05 06'), ['6E F1 98']); // written
  assert.deepEqual(b.send('22 F1 98'), ['62 F1 98 01 02 03 04 05 06']); // read back
  assert.deepEqual(b.send('2E F1 98 01 02 03 04 05'), ['7F 2E 13']); // 5 data bytes
  assert.deepEqual(b.send('2E F1 99 01 02 03 04 05 06'), ['7F 2E 31']); // unknown DID
});

test('5.2.5 session change locks security', () => {
  const b = bench(); // fresh ECU
  b.send('10 03'); unlock(b); // unlocked in extended
  b.send('10 01'); b.send('10 03'); // leave and come back
  assert.deepEqual(b.send('2E F1 98 01 02 03 04 05 06'), ['7F 2E 33']); // locked again
});

test('5.2.6 demo key known answers', () => {
  assert.deepEqual(S.demoKey(h('12 34 56 78')), h('6B AB B9 07')); // vector 1
  assert.deepEqual(S.demoKey(h('00 00 00 01')), h('32 32 6D E5')); // vector 2
  assert.deepEqual(S.demoKey(h('DE AD BE EF')), h('DC 7E CB 90')); // vector 3
  assert.deepEqual(S.createEcu().demoKey(h('12 34 56 78')), h('6B AB B9 07')); // also on the ECU object
});

// ---------------------------------------------------------------------------------------------------------------------
// 5.3 Timing
// ---------------------------------------------------------------------------------------------------------------------

test('5.3 S3 timeout', () => {
  let ecu = S.createEcu(); // fresh ECU
  ecu.handle(h('10 03'), 0); // extended at t = 0
  assert.equal(ecu.tick(5000).length, 0); // not yet (strictly greater than S3)
  const ev = ecu.tick(5001); // expired
  assert.ok(ev.length > 0 && ev.join(' ').includes('S3')); // event
  const s = ecu.snapshot(5001); // state
  assert.equal(s.session, 1); assert.equal(s.unlocked, false); // default and locked
  assert.deepEqual(ecu.handle(h('22 F1 86'), 5100).responses.map((r) => E.hexBytes(r.bytes)), ['62 F1 86 01']); // default session
  ecu = S.createEcu(); // fresh ECU
  ecu.handle(h('10 03'), 0); ecu.handle(h('3E 80'), 4000); // keep-alive at 4000
  assert.equal(ecu.tick(8000).length, 0); assert.equal(ecu.snapshot(8000).session, 3); // still extended at 8000
  assert.equal(ecu.tick(9000).length, 0); // exactly S3: not yet
  assert.ok(ecu.tick(9001).length > 0); assert.equal(ecu.snapshot(9001).session, 1); // expired after 9000
});

test('5.3 S3 countdown in the snapshot', () => {
  const ecu = S.createEcu(); // fresh ECU
  assert.equal(ecu.snapshot(0).s3RemainingMs, null); // no countdown in the default session
  ecu.handle(h('10 03'), 0); // extended
  assert.equal(ecu.snapshot(0).s3RemainingMs, 5000); // full
  assert.equal(ecu.snapshot(2500).s3RemainingMs, 2500); // half
  assert.equal(ecu.snapshot(6000).s3RemainingMs, 0); // never negative
});

// ---------------------------------------------------------------------------------------------------------------------
// 5.4 Programming flow
// ---------------------------------------------------------------------------------------------------------------------

test('5.4 programming flow', () => {
  const b = bench(); // fresh ECU
  assert.deepEqual(b.send('10 02'), ['50 02 00 32 01 F4']); // 1
  unlock(b); // 2
  assert.deepEqual(b.send('34 00 44 08 00 00 00 00 00 01 00'), ['7F 34 24']); // 3: not erased
  const t = b.now() + 100; // time of the erase request
  const er = b.ecu.handle(h('31 01 FF 00'), t); // 4: erase
  assert.deepEqual(er.responses.map((r) => [E.hexBytes(r.bytes), r.delayMs]), [['7F 31 78', 50], ['7F 31 78', 4050], ['71 01 FF 00 00', 7000]]); // three responses
  b.at(t + 7100, '3E 80'); // after the routine finished (S3 restarts after the final response)
  assert.equal(b.ecu.snapshot(t + 7100).session, 2); // still in programming
  assert.deepEqual(b.send('34 00 44 08 00 00 00 00 00 01 00'), ['74 20 01 00']); // 5: accepted
  assert.deepEqual(b.send('34 00 44 10 00 00 00 00 00 01 00'), ['7F 34 31']); // 5: outside flash
  assert.deepEqual(b.send('34 00 44 08 00 00'), ['7F 34 13']); // 5: truncated
  const block = Array.from({ length: 254 }, (_, i) => E.hex2(i)).join(' '); // 254 data bytes
  assert.deepEqual(b.send('36 01 ' + block), ['76 01']); // 6
  assert.deepEqual(b.send('36 03 AA BB'), ['7F 36 73']); // 6: wrong counter
  assert.deepEqual(b.send('37'), ['7F 37 24']); // 6: 254 of 256 bytes
  assert.deepEqual(b.send('36 02 AA BB'), ['76 02']); // 6
  assert.deepEqual(b.send('37'), ['77']); // 6: complete
  assert.deepEqual(b.send('36 01 AA'), ['7F 36 24']); // 6: no active download
});

test('5.4.7 programming services in the extended session', () => {
  const b = bench(); // fresh ECU
  b.send('10 03'); unlock(b); // extended, unlocked
  assert.deepEqual(b.send('31 01 FF 00'), ['7F 31 7F']); // erase needs programming
  assert.deepEqual(b.send('34 00 44 08 00 00 00 00 00 01 00'), ['7F 34 7F']); // download needs programming
});

test('5.4.8 erase while locked', () => {
  const b = bench(); // fresh ECU
  b.send('10 02'); // programming, locked
  assert.deepEqual(b.send('31 01 FF 00'), ['7F 31 33']); // security
});

// ---------------------------------------------------------------------------------------------------------------------
// 5.5 Other services
// ---------------------------------------------------------------------------------------------------------------------

test('5.5 ECUReset', () => {
  const b = bench(); // fresh ECU
  b.send('10 02'); unlock(b); // programming, unlocked
  assert.deepEqual(b.send('11 01'), ['51 01']); // reset
  const s = b.ecu.snapshot(b.now()); // state
  assert.equal(s.session, 1); assert.equal(s.unlocked, false); assert.equal(s.download, null); // default, locked, no download
  assert.deepEqual(b.send('11 04'), ['7F 11 12']); // unsupported reset type
});

test('5.5 DTC services', () => {
  let b = bench(); // fresh ECU
  assert.deepEqual(b.send('19 02 FF'), ['59 02 FF 03 00 00 2F 01 13 00 08 C1 00 87 09']); // all three
  assert.deepEqual(b.send('19 02 01'), ['59 02 FF 03 00 00 2F C1 00 87 09']); // testFailed only
  assert.deepEqual(b.send('19 01 FF'), ['59 01 FF 01 00 03']); // count
  assert.deepEqual(b.send('19 0A'), ['59 0A FF 03 00 00 2F 01 13 00 08 C1 00 87 09']); // supported DTCs
  assert.deepEqual(b.send('14 FF FF FF'), ['54']); // clear all
  assert.deepEqual(b.send('19 02 FF'), ['59 02 FF']); // no records
  assert.deepEqual(b.send('19 01 FF'), ['59 01 FF 01 00 00']); // zero
  b = bench(); // fresh ECU
  assert.deepEqual(b.send('14 01 13 00'), ['54']); // clear one DTC
  assert.deepEqual(b.send('14 12 34 56'), ['7F 14 31']); // unknown DTC
  assert.deepEqual(b.send('19 01 FF'), ['59 01 FF 01 00 02']); // two left
  assert.deepEqual(b.send('19 03'), ['7F 19 12']); assert.deepEqual(b.send('19 02'), ['7F 19 13']); // unsupported / wrong length
});

test('5.5 ControlDTCSetting and CommunicationControl', () => {
  const b = bench(); // fresh ECU
  assert.deepEqual(b.send('85 02'), ['7F 85 7F']); // default session
  b.send('10 03'); // extended
  assert.deepEqual(b.send('85 02'), ['C5 02']); // off
  assert.deepEqual(b.send('28 03 01'), ['68 03']); // disable Rx and Tx
  assert.deepEqual(b.send('28 09 01'), ['7F 28 12']); // control type
  assert.deepEqual(b.send('28 03 00'), ['7F 28 31']); // message class 0
  const s = b.ecu.snapshot(b.now()); // state
  assert.equal(s.dtcSetting, 'off'); assert.equal(s.comm.ctrl, 3); // recorded
  b.send('10 01'); // back to default restores both
  assert.equal(b.ecu.snapshot(b.now()).comm, null); assert.equal(b.ecu.snapshot(b.now()).dtcSetting, 'on'); // restored
});

test('5.5 RoutineControl demo self-test', () => {
  const b = bench(); // fresh ECU
  b.send('10 03'); // extended
  assert.deepEqual(b.send('31 01 02 00'), ['71 01 02 00 00']); // start
  assert.deepEqual(b.send('31 03 02 00'), ['71 03 02 00 01']); // results
  assert.deepEqual(b.send('31 02 02 00'), ['71 02 02 00']); // stop
  assert.deepEqual(b.send('31 01 12 34'), ['7F 31 31']); // unknown routine
});

test('InputOutputControl demo LED', () => {
  const b = bench(); // fresh ECU
  b.send('10 03'); // extended
  assert.deepEqual(b.send('2F 03 00 03 01'), ['7F 2F 33']); // locked
  unlock(b); // unlock
  assert.deepEqual(b.send('2F 03 00 03 01'), ['6F 03 00 03 01']); // LED on
  assert.deepEqual(b.send('22 03 00'), ['62 03 00 01']); // read back
  assert.deepEqual(b.send('2F 03 00 00'), ['6F 03 00 00 00']); // return control
  assert.deepEqual(b.send('2F 03 00 03'), ['7F 2F 13']); // state byte missing
});

test('battery voltage DID is in range and dynamic', () => {
  const ecu = S.createEcu(); // fresh ECU
  const v = (t) => { const r = ecu.handle(h('22 01 00'), t).responses[0].bytes; return r[3] * 256 + r[4]; }; // mV at time t
  assert.equal(v(0), 12480); assert.equal(v(1000), 12517); // 12480 + 37
  for (let t = 0; t < 100000; t += 3700) { const x = v(t); assert.ok(x >= 12480 && x < 12540); } // always in range
});

// ---------------------------------------------------------------------------------------------------------------------
// 5.6 Exchange driver
// ---------------------------------------------------------------------------------------------------------------------

test('5.6 classic CAN frames for a VIN read', () => {
  const x = S.exchange(S.createEcu(), h('22 F1 90'), 0, { fd: false, pad: 0xAA }); // physical, classic
  const lines = x.frames.map((f) => E.hexId(f.id, f.ext) + ': ' + E.hexBytes(f.data)); // compact text
  assert.deepEqual(lines, [
    '7E0: 03 22 F1 90 AA AA AA AA', // request
    '7E8: 10 14 62 F1 90 45 47 54', // FF
    '7E0: 30 00 00 AA AA AA AA AA', // tester flow control
    '7E8: 21 45 53 54 31 32 33 34', // CF 1
    '7E8: 22 35 36 37 38 39 30 31', // CF 2
  ]);
  assert.deepEqual(x.frames.map((f) => f.who), ['tester', 'ecu', 'tester', 'ecu', 'ecu']); // senders
});

test('5.6 CAN FD 64-byte frames use the escape single frame', () => {
  const x = S.exchange(S.createEcu(), h('22 F1 90'), 0, { fd: true, canDl: 64, pad: 0xAA }); // FD
  const rsp = x.frames.filter((f) => f.who === 'ecu'); // ECU frames
  assert.equal(rsp.length, 1); // one single frame
  assert.deepEqual(rsp[0].data.slice(0, 5), h('00 14 62 F1 90')); // escape form
  assert.equal(rsp[0].data.length, 24); // 22 bytes padded to a legal size
});

test('5.6 frames decode back to the same messages', () => {
  const ecu = S.createEcu(); // fresh ECU
  const reqs = ['22 F1 90', '10 02', '27 01', '22 F1 86 F1 87 F1 89', '31 01 FF 00', '19 02 FF']; // a mixed session
  for (const cfg of [{ fd: false, pad: 0xAA }, { fd: false, pad: null }, { fd: true, canDl: 12, brs: true, pad: null }, { fd: true, canDl: 64 }]) { // framings
    ecu.reset(); // fresh state each time
    let t = 0; // seconds
    const lines = [], expected = []; // candump text and payloads
    for (const r of reqs) { // each request
      const x = S.exchange(ecu, h(r), t, cfg); // on the bus
      lines.push(...x.frames.map((f) => E.formatCandump(f))); // log lines
      expected.push(h(r), ...x.responses.map((y) => y.bytes)); // request then responses
      t = x.tEnd + 0.1; // next request later
    }
    const d = E.decodeAll(lines.join('\n')); // decode the log
    assert.deepEqual(d.messages.map((m) => m.payload), expected, JSON.stringify(cfg)); // same payloads
    assert.equal(d.events.length, 0, JSON.stringify(d.events)); // clean ISO-TP
  }
});

test('5.6 pending responses are segmented separately at 50, 4050 and 7000 ms', () => {
  const ecu = S.createEcu(); // fresh ECU
  S.exchange(ecu, h('10 02'), 0); // programming
  const seed = S.exchange(ecu, h('27 01'), 0.1).responses[0].bytes.slice(2); // seed
  S.exchange(ecu, [0x27, 0x02, ...S.demoKey(seed)], 0.2); // unlock
  const x = S.exchange(ecu, h('31 01 FF 00'), 1.0); // erase at t = 1 s
  const ecuFrames = x.frames.filter((f) => f.who === 'ecu'); // three single frames
  assert.deepEqual(ecuFrames.map((f) => Number((f.t - 1.0).toFixed(6))), [0.05, 4.05, 7.0]); // relative times
  assert.deepEqual(ecuFrames.map((f) => E.hexBytes(f.data).slice(0, 14)), ['03 7F 31 78 AA', '03 7F 31 78 AA', '05 71 01 FF 00']); // each its own SF
});

test('exchange: functional multi-frame request is refused', () => {
  const x = S.exchange(S.createEcu(), h('22 F1 90 F1 86 F1 87 F1 89'), 0, { functional: true, fd: false }); // 9 bytes, classic
  assert.equal(x.frames.length, 0); assert.ok(x.events[0].includes('Single Frame')); // nothing sent, explained
});

test('exchange: multi-frame request gets the ECU flow control', () => {
  const x = S.exchange(S.createEcu(), h('2E F1 98 01 02 03 04 05 06'), 0, { fd: false, pad: 0xAA }); // 9 bytes, classic
  assert.deepEqual(x.frames.map((f) => f.who), ['tester', 'ecu', 'tester', 'ecu']); // FF, FC, CF, response
  assert.deepEqual(x.frames[1].data, h('30 00 00 AA AA AA AA AA')); // ECU flow control
});

test('fuzz: random requests never throw', () => {
  const ecu = S.createEcu(); // one ECU across all requests
  let s = 99; // PRNG state
  const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0); // LCG
  for (let i = 0; i < 20000; i++) { // many requests
    const n = rnd() % 12; // length
    const p = Array.from({ length: n }, () => rnd() & 0xFF); // random bytes
    if (n && i % 2) p[0] = S.SUPPORTED[rnd() % S.SUPPORTED.length]; // bias toward supported services
    const r = ecu.handle(p, i * 10, { functional: (rnd() & 7) === 0 }); // handle
    assert.ok(Array.isArray(r.responses) && Array.isArray(r.events)); // shape
  }
});
