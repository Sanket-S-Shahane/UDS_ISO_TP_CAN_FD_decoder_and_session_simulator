/*
 * UDS Bench virtual ECU by Embedded Garage.
 * A teaching model: the data, the DTCs and the security algorithm are made up and belong to no real ECU.
 * No DOM access: this file runs unchanged in Node (tests) and in the browser (global EGSIM).
 * Time inside the ECU is in milliseconds; the exchange driver works in seconds like the logs.
 */
(function (root) { // wrap everything so only one global is created
  'use strict'; // catch accidental globals and silent errors

  const core = root.EGUDS || (typeof require === 'function' ? require('./core.js') : null); // decoder helpers (segment, flowControl)

  const SESSION_NAMES = { 1: 'default', 2: 'programming', 3: 'extended' }; // sessions the ECU supports
  const SUPPORTED = [0x10, 0x11, 0x14, 0x19, 0x22, 0x27, 0x28, 0x2E, 0x2F, 0x31, 0x34, 0x36, 0x37, 0x3E, 0x85]; // spec section 8
  const SPR_SERVICES = [0x10, 0x11, 0x27, 0x28, 0x3E, 0x85, 0x31]; // services honouring the suppress-positive-response bit
  const FUNCTIONAL_SUPPRESSED = [0x11, 0x12, 0x31, 0x7E, 0x7F]; // NRCs not sent to functional requests
  const FLASH_START = 0x08000000, FLASH_END = 0x080FFFFF; // demo flash range (inclusive end)
  const MAX_BLOCK = 256; // maxNumberOfBlockLength announced in 0x74 (bytes incl. SID and counter)

  const DEFAULTS = { // spec section 8 defaults
    p2: 50, p2star: 5000, s3: 5000, lockoutMs: 10000, maxAttempts: 3, // timing and security limits (ms)
    responseMs: 2, // time the ECU takes for an ordinary response (ms, below P2)
  };

  /**
   * Converts a string to ASCII bytes.
   * @param {string} s text
   * @returns {number[]} bytes
   */
  function bytesOf(s) {
    return Array.from(s, (ch) => ch.charCodeAt(0) & 0xFF); // one byte per character
  }

  /**
   * Rotates a 32-bit value left.
   * @param {number} x value
   * @param {number} n bit count 0..31
   * @returns {number} rotated unsigned value
   */
  function rol32(x, n) {
    return ((x << n) | (x >>> (32 - n))) >>> 0; // shift both ways and merge
  }

  /**
   * The made-up demo security algorithm: key = (ROL32(seed XOR 0xC0FFEE11, 5) + 0x1234ABCD) mod 2^32.
   * @param {number[]} seed 4 seed bytes, big-endian
   * @returns {number[]} 4 key bytes, big-endian
   */
  function demoKey(seed) {
    const s = seed.slice(0, 4).reduce((v, b) => v * 256 + (b & 0xFF), 0) >>> 0; // seed as an unsigned 32-bit number
    const k = (rol32((s ^ 0xC0FFEE11) >>> 0, 5) + 0x1234ABCD) >>> 0; // the formula, wrapped to 32 bits
    return [k >>> 24, (k >>> 16) & 0xFF, (k >>> 8) & 0xFF, k & 0xFF]; // big-endian bytes
  }

  /**
   * Builds a fresh ECU state.
   * @returns {object} state
   */
  function freshState() {
    return { // spec section 8 "State"
      session: 1, unlocked: false, seed: null, attempts: 0, lockoutUntil: null, lastActivity: 0, // session and security
      comm: null, dtcSetting: 'on', download: null, erased: false, // communication, DTC setting, programming
      f198: [0, 0, 0, 0, 0, 0], led: 0, ledOverride: false, rng: 0x1BADB002, // writable data, IO control, PRNG
      dtcs: [{ code: [0x03, 0x00, 0x00], status: 0x2F }, { code: [0x01, 0x13, 0x00], status: 0x08 }, { code: [0xC1, 0x00, 0x87], status: 0x09 }], // demo DTCs
    };
  }

  /**
   * Creates a virtual ECU.
   * @param {object} [config] overrides for the defaults (p2, p2star, s3, lockoutMs, maxAttempts, responseMs)
   * @returns {{handle: function, tick: function, reset: function, snapshot: function, demoKey: function, config: object}} ECU API
   */
  function createEcu(config) {
    const cfg = Object.assign({}, DEFAULTS, config || {}); // effective configuration
    let st = freshState(); // mutable state

    /**
     * Advances the demo PRNG and returns a non-zero 4-byte seed.
     * @returns {number[]} seed bytes
     */
    function nextSeed() {
      do { st.rng = (Math.imul(st.rng, 1664525) + 1013904223) >>> 0; } while (st.rng === 0); // LCG step, never zero
      const v = st.rng; // seed value
      return [v >>> 24, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF]; // big-endian bytes
    }

    /**
     * Changes the session and applies the side effects of a session change.
     * @param {number} s new session
     * @param {string[]} events event list to append to
     * @param {string} why reason shown in the event
     */
    function setSession(s, events, why) {
      if (s === st.session) return; // same session: nothing changes, security stays as it is
      const from = st.session; // old session for the event text
      st.session = s; // switch
      st.unlocked = false; st.seed = null; // any session change locks security
      if (from === 2) st.download = null; // leaving programming abandons a download
      if (s === 1) { st.comm = null; st.dtcSetting = 'on'; st.ledOverride = false; st.led = 0; } // default session restores normal behaviour
      events.push('Session ' + SESSION_NAMES[from] + ' → ' + SESSION_NAMES[s] + ' (' + why + '); security locked'); // tell the user
    }

    /**
     * Applies time-based changes: S3 expiry and the end of a lockout.
     * @param {number} nowMs current time in ms
     * @returns {string[]} events
     */
    function tick(nowMs) {
      const events = []; // what happened
      if (st.lockoutUntil !== null && nowMs >= st.lockoutUntil) { // lockout delay has passed
        st.lockoutUntil = null; st.attempts = 0; // seed requests are allowed again and the counter restarts
        events.push('Security lockout over; seed requests are accepted again'); // tell the user
      }
      if (st.session !== 1 && nowMs - st.lastActivity > cfg.s3) { // S3 expired in a non-default session
        st.download = null; // discard any download
        setSession(1, events, 'S3 timeout: no request for ' + cfg.s3 + ' ms'); // back to default, locked
      }
      return events; // events for the caller
    }

    /**
     * Builds a negative response list.
     * @param {number} sid request SID
     * @param {number} code NRC
     * @returns {object[]} one response
     */
    function nrc(sid, code) {
      return [{ bytes: [0x7F, sid, code], delayMs: cfg.responseMs }]; // 7F SID NRC
    }

    /**
     * Builds a positive response list, honouring the suppress bit.
     * @param {number[]} bytes response bytes
     * @param {boolean} suppress true when the request asked for no positive response
     * @returns {object[]} zero or one response
     */
    function pos(bytes, suppress) {
      return suppress ? [] : [{ bytes, delayMs: cfg.responseMs }]; // nothing when suppressed
    }

    /**
     * Returns the readable data identifiers and their current values.
     * @param {number} did data identifier
     * @param {number} nowMs current time (for dynamic values)
     * @returns {number[]|null} value bytes, or null when not supported
     */
    function readDid(did, nowMs) {
      switch (did) { // demo data from spec section 8
        case 0xF190: return bytesOf('EGTEST12345678901'); // VIN
        case 0xF187: return bytesOf('EG-DEMO-0001'); // spare part number
        case 0xF189: return bytesOf('1.0.3'); // software version
        case 0xF18A: return bytesOf('EMBEDDED GARAGE'); // supplier
        case 0xF18C: return bytesOf('0000042'); // serial number
        case 0xF191: return bytesOf('HW-A1'); // hardware number
        case 0xF195: return bytesOf('SW-1.0.3'); // supplier software version
        case 0xF186: return [st.session]; // active session (dynamic)
        case 0xF198: return st.f198.slice(); // writable repair shop code
        case 0x0100: { const mv = 12480 + ((Math.floor(nowMs / 1000) * 37) % 60); return [mv >> 8, mv & 0xFF]; } // battery voltage in mV (dynamic)
        case 0x0101: return [0x5A]; // coolant, raw value
        case 0x0300: return [st.led]; // demo LED state (see DECISIONS)
        default: return null; // not supported
      }
    }

    /**
     * Encodes the DTC records that match a status mask.
     * @param {number|null} mask status mask, or null for all DTCs
     * @returns {number[]} DTC + status records
     */
    function dtcRecords(mask) {
      const out = []; // records
      for (const d of st.dtcs) if (mask === null || (d.status & mask) !== 0) out.push(...d.code, d.status); // 4 bytes each
      return out; // flattened records
    }

    /**
     * Executes one request (after the common checks).
     * @param {number[]} p request bytes
     * @param {number} nowMs current time
     * @param {string[]} events event list
     * @returns {object[]} responses [{bytes, delayMs}]
     */
    function service(p, nowMs, events) {
      const sid = p[0]; // service ID
      if (!SUPPORTED.includes(sid)) return nrc(sid, 0x11); // serviceNotSupported
      const sub = p.length > 1 ? p[1] & 0x7F : null; // sub-function value
      const spr = SPR_SERVICES.includes(sid) && p.length > 1 && (p[1] & 0x80) !== 0; // suppress positive response?
      switch (sid) {
        case 0x10: { // DiagnosticSessionControl
          if (p.length !== 2) return nrc(sid, 0x13); // exact length
          if (![1, 2, 3].includes(sub)) return nrc(sid, 0x12); // sessions we support
          setSession(sub, events, 'DiagnosticSessionControl'); // switch (locks security when it changes)
          return pos([0x50, sub, 0x00, 0x32, 0x01, 0xF4], spr); // P2 = 50 ms, P2* = 500 × 10 ms
        }
        case 0x11: { // ECUReset
          if (p.length !== 2) return nrc(sid, 0x13); // exact length
          if (![1, 2, 3].includes(sub)) return nrc(sid, 0x12); // reset types we support
          const was = st.session; // for the event
          st.session = 1; st.unlocked = false; st.seed = null; st.download = null; // reset: default session, locked, no download
          st.comm = null; st.dtcSetting = 'on'; st.ledOverride = false; st.led = 0; // and normal communication
          events.push('ECU reset (' + core.subName(0x11, sub) + '): ' + SESSION_NAMES[was] + ' → default session, security locked'); // tell the user
          return pos([0x51, sub], spr); // positive response is sent before the reset takes effect
        }
        case 0x14: { // ClearDiagnosticInformation
          if (p.length !== 4) return nrc(sid, 0x13); // group of DTC is 3 bytes
          const g = (p[1] << 16) | (p[2] << 8) | p[3]; // group value
          if (g === 0xFFFFFF) { st.dtcs = []; events.push('All DTCs cleared'); return pos([0x54], false); } // clear all
          const k = st.dtcs.findIndex((d) => ((d.code[0] << 16) | (d.code[1] << 8) | d.code[2]) === g); // a single DTC
          if (k < 0) return nrc(sid, 0x31); // unknown group
          events.push('DTC ' + core.dtcText(st.dtcs[k].code) + ' cleared'); // tell the user
          st.dtcs.splice(k, 1); // remove it
          return pos([0x54], false); // positive response
        }
        case 0x19: { // ReadDTCInformation
          if (p.length < 2) return nrc(sid, 0x13); // need a sub-function
          if (![0x01, 0x02, 0x0A].includes(sub)) return nrc(sid, 0x12); // report types we support
          if (p.length !== (sub === 0x0A ? 2 : 3)) return nrc(sid, 0x13); // 0x0A has no parameter, 01/02 have a mask
          if (sub === 0x01) { // number of DTCs by status mask
            const n = st.dtcs.filter((d) => (d.status & p[2]) !== 0).length; // matching DTCs
            return pos([0x59, 0x01, 0xFF, 0x01, n >> 8, n & 0xFF], false); // mask FF, ISO 14229-1 format, count
          }
          return pos([0x59, sub, 0xFF, ...dtcRecords(sub === 0x02 ? p[2] : null)], false); // records
        }
        case 0x22: { // ReadDataByIdentifier
          if (p.length < 3 || p.length % 2 === 0) return nrc(sid, 0x13); // SID + pairs
          const out = [0x62]; // response
          for (let i = 1; i < p.length; i += 2) { // each requested DID
            const did = (p[i] << 8) | p[i + 1]; // DID
            const v = readDid(did, nowMs); // value
            if (v) out.push(p[i], p[i + 1], ...v); // supported DIDs only; unsupported ones are omitted
          }
          if (out.length === 1) return nrc(sid, 0x31); // none supported
          if (out.length > 4095) return nrc(sid, 0x14); // larger than one ISO-TP message (classic length field)
          return pos(out, false); // records
        }
        case 0x27: { // SecurityAccess
          if (st.session === 1) return nrc(sid, 0x7F); // not in the default session
          if (p.length < 2) return nrc(sid, 0x13); // need a sub-function
          if (sub !== 0x01 && sub !== 0x02) return nrc(sid, 0x12); // only level 1
          if (sub === 0x01) { // requestSeed
            if (p.length !== 2) return nrc(sid, 0x13); // no extra data accepted
            if (st.lockoutUntil !== null && nowMs < st.lockoutUntil) return nrc(sid, 0x37); // delay not expired
            if (st.unlocked) return pos([0x67, 0x01, 0, 0, 0, 0], spr); // already unlocked: zero seed
            st.seed = nextSeed(); // new seed
            return pos([0x67, 0x01, ...st.seed], spr); // send it
          }
          if (p.length !== 6) return nrc(sid, 0x13); // 4-byte key
          if (!st.seed) return nrc(sid, 0x24); // no seed requested
          const expect = demoKey(st.seed); // correct key
          st.seed = null; // a seed is used once, right or wrong
          if (expect.every((b, i) => b === p[2 + i])) { // correct key
            st.unlocked = true; st.attempts = 0; // unlocked, counter cleared
            events.push('Security level 1 unlocked'); // tell the user
            return pos([0x67, 0x02], spr); // positive
          }
          st.attempts++; // wrong key
          if (st.attempts >= cfg.maxAttempts) { // too many wrong keys
            st.lockoutUntil = nowMs + cfg.lockoutMs; // start the delay
            events.push('Security locked out for ' + cfg.lockoutMs / 1000 + ' s after ' + st.attempts + ' wrong keys'); // tell the user
            return nrc(sid, 0x36); // exceededNumberOfAttempts
          }
          return nrc(sid, 0x35); // invalidKey
        }
        case 0x28: { // CommunicationControl
          if (st.session !== 3) return nrc(sid, 0x7F); // extended session only
          if (p.length !== 3) return nrc(sid, 0x13); // control type + communication type
          if (sub > 0x03) return nrc(sid, 0x12); // control types 00..03
          if ((p[2] & 0x03) === 0) return nrc(sid, 0x31); // message class must be 1..3
          st.comm = { ctrl: sub, type: p[2] }; // remember the state
          events.push('Communication control: ' + core.subName(0x28, sub)); // tell the user
          return pos([0x68, sub], spr); // positive
        }
        case 0x2E: { // WriteDataByIdentifier (table order: length, DID, session, data length, security)
          if (p.length < 4) return nrc(sid, 0x13); // DID + at least one byte
          if (((p[1] << 8) | p[2]) !== 0xF198) return nrc(sid, 0x31); // only F198 is writable
          if (st.session !== 3) return nrc(sid, 0x7F); // extended session only
          if (p.length !== 9) return nrc(sid, 0x13); // exactly 6 data bytes
          if (!st.unlocked) return nrc(sid, 0x33); // security required
          st.f198 = p.slice(3, 9); // store
          return pos([0x6E, 0xF1, 0x98], false); // positive
        }
        case 0x2F: { // InputOutputControlByIdentifier on the demo LED
          if (p.length < 4) return nrc(sid, 0x13); // DID + control parameter
          if (((p[1] << 8) | p[2]) !== 0x0300) return nrc(sid, 0x31); // only the LED DID
          if (st.session !== 3) return nrc(sid, 0x7F); // extended session only
          const param = p[3]; // control parameter
          if (param > 0x03) return nrc(sid, 0x31); // 00..03 defined
          if (p.length !== (param === 0x03 ? 5 : 4)) return nrc(sid, 0x13); // shortTermAdjustment carries one state byte
          if (!st.unlocked) return nrc(sid, 0x33); // security required
          if (param === 0x00 || param === 0x01) { st.led = 0; st.ledOverride = false; } // return control / reset to default: LED off under ECU control
          else if (param === 0x02) st.ledOverride = true; // freeze the current state
          else { st.led = p[4]; st.ledOverride = true; } // short-term adjustment to the given state
          return pos([0x6F, 0x03, 0x00, param, st.led], false); // DID, parameter, state
        }
        case 0x31: { // RoutineControl
          if (p.length < 4) return nrc(sid, 0x13); // sub + routine ID
          if (![1, 2, 3].includes(sub)) return nrc(sid, 0x12); // start, stop, results
          const rid = (p[2] << 8) | p[3]; // routine ID
          if (rid === 0xFF00) { // eraseMemory
            if (st.session !== 2) return nrc(sid, 0x7F); // programming session only
            if (!st.unlocked) return nrc(sid, 0x33); // security required
            if (sub !== 0x01) return nrc(sid, 0x12); // start only
            st.erased = true; // flash is now erased
            events.push('Flash erase running (response pending twice, done at ' + 7000 + ' ms)'); // tell the user
            return [ // two pending responses, then the result (sent even with the suppress bit because 0x78 was sent)
              { bytes: [0x7F, 0x31, 0x78], delayMs: 50 }, // first pending inside P2
              { bytes: [0x7F, 0x31, 0x78], delayMs: 4050 }, // second pending inside P2*
              { bytes: [0x71, 0x01, 0xFF, 0x00, 0x00], delayMs: 7000 }, // routine finished, status 00
            ];
          }
          if (rid === 0x0200) { // demo self-test
            if (st.session !== 3) return nrc(sid, 0x7F); // extended session only
            if (sub === 0x01) return pos([0x71, 0x01, 0x02, 0x00, 0x00], spr); // started, status 00
            if (sub === 0x02) return pos([0x71, 0x02, 0x02, 0x00], spr); // stopped
            return pos([0x71, 0x03, 0x02, 0x00, 0x01], spr); // results: 01 = passed
          }
          return nrc(sid, 0x31); // unknown routine
        }
        case 0x34: { // RequestDownload
          if (st.session !== 2) return nrc(sid, 0x7F); // programming session only
          if (p.length < 5) return nrc(sid, 0x13); // DFI + ALFID + at least 1 + 1 bytes
          if (p[1] !== 0x00) return nrc(sid, 0x31); // no compression or encryption supported
          const aw = p[2] & 0x0F, sw = p[2] >> 4; // address and size widths
          if (aw < 1 || aw > 4 || sw < 1 || sw > 4 || p.length !== 3 + aw + sw) return nrc(sid, 0x13); // malformed format
          if (!st.unlocked) return nrc(sid, 0x33); // security required
          const addr = p.slice(3, 3 + aw).reduce((v, b) => v * 256 + b, 0); // address
          const size = p.slice(3 + aw).reduce((v, b) => v * 256 + b, 0); // size
          if (addr < FLASH_START || addr > FLASH_END || size === 0 || addr + size - 1 > FLASH_END) return nrc(sid, 0x31); // outside flash
          if (!st.erased) return nrc(sid, 0x24); // erase first
          if (st.download) return nrc(sid, 0x22); // one download at a time (see DECISIONS)
          st.download = { address: addr, size, received: 0, counter: 0 }; // start
          events.push('Download started: ' + size + ' bytes at 0x' + addr.toString(16).toUpperCase().padStart(8, '0')); // tell the user
          return pos([0x74, 0x20, MAX_BLOCK >> 8, MAX_BLOCK & 0xFF], false); // 2-byte max block length = 256
        }
        case 0x36: { // TransferData
          if (st.session !== 2) return nrc(sid, 0x7F); // programming session only
          if (!st.download) return nrc(sid, 0x24); // no download active
          if (p.length < 2) return nrc(sid, 0x13); // need the counter
          const d = st.download; // active download
          if (p[1] !== ((d.counter + 1) & 0xFF)) return nrc(sid, 0x73); // wrong block sequence counter
          if (p.length > MAX_BLOCK) return nrc(sid, 0x13); // longer than announced
          if (d.received + p.length - 2 > d.size) return nrc(sid, 0x72); // more than announced in total
          d.counter = p[1]; d.received += p.length - 2; // accept the block
          return pos([0x76, p[1]], false); // positive
        }
        case 0x37: { // RequestTransferExit
          if (st.session !== 2) return nrc(sid, 0x7F); // programming session only
          if (!st.download || st.download.received !== st.download.size) return nrc(sid, 0x24); // nothing to finish or data missing
          events.push('Download complete: ' + st.download.received + ' bytes'); // tell the user
          st.download = null; st.erased = false; // done; the flash is programmed, not erased
          return pos([0x77], false); // positive
        }
        case 0x3E: { // TesterPresent
          if (p.length !== 2) return nrc(sid, 0x13); // sub-function only
          if (sub !== 0x00) return nrc(sid, 0x12); // zeroSubFunction only
          return pos([0x7E, 0x00], spr); // 3E 80 gets no response
        }
        case 0x85: { // ControlDTCSetting
          if (st.session !== 3) return nrc(sid, 0x7F); // extended session only
          if (p.length < 2) return nrc(sid, 0x13); // need a sub-function
          if (sub !== 0x01 && sub !== 0x02) return nrc(sid, 0x12); // on / off
          st.dtcSetting = sub === 0x01 ? 'on' : 'off'; // remember
          return pos([0xC5, sub], spr); // positive
        }
        default: return nrc(sid, 0x11); // unreachable: SUPPORTED covers every case
      }
    }

    /**
     * Handles one request.
     * @param {number[]} req request bytes
     * @param {number} nowMs time the request was received (ms)
     * @param {{functional?: boolean}} [opts] addressing
     * @returns {{responses: {bytes: number[], delayMs: number}[], events: string[]}} responses in time order and events
     */
    function handle(req, nowMs, opts) {
      const o = opts || {}; // optional
      const now = Number(nowMs) || 0; // tolerate missing time
      const events = tick(now); // S3 expiry and lockout end first
      const p = Array.isArray(req) ? req.map((b) => (Number(b) & 0xFF) >>> 0) : []; // sanitise
      if (!p.length) return { responses: [], events: events.concat('Empty request ignored') }; // nothing to answer
      st.lastActivity = now; // any request restarts S3
      let responses = service(p, now, events); // execute
      if (o.functional) responses = responses.filter((r) => !(r.bytes[0] === 0x7F && FUNCTIONAL_SUPPRESSED.includes(r.bytes[2]))); // functional NRC suppression
      responses.sort((a, b) => a.delayMs - b.delayMs); // time order
      if (responses.some((r) => r.bytes[0] === 0x7F && r.bytes[2] === 0x78)) st.lastActivity = now + responses[responses.length - 1].delayMs; // S3 restarts after the final response of a pending sequence
      return { responses, events }; // result
    }

    /**
     * Describes the ECU state for the UI and tests.
     * @param {number} nowMs current time
     * @returns {object} state summary
     */
    function snapshot(nowMs) {
      const now = Number(nowMs) || 0; // tolerate missing time
      const s3Left = st.session === 1 ? null : Math.max(0, Math.min(cfg.s3, cfg.s3 - (now - st.lastActivity))); // counts down from s3 to 0
      return { // copy of the interesting state
        session: st.session, sessionName: SESSION_NAMES[st.session], unlocked: st.unlocked, // session and security
        seed: st.seed ? st.seed.slice() : null, attempts: st.attempts, maxAttempts: cfg.maxAttempts, // pending seed and counter
        lockoutRemainingMs: st.lockoutUntil === null ? 0 : Math.max(0, st.lockoutUntil - now), // lockout delay left
        s3RemainingMs: s3Left, s3Ms: cfg.s3, // S3 countdown
        comm: st.comm ? { ctrl: st.comm.ctrl, type: st.comm.type, text: core.subName(0x28, st.comm.ctrl) } : null, // communication control
        dtcSetting: st.dtcSetting, erased: st.erased, led: st.led, ledOverride: st.ledOverride, f198: st.f198.slice(), // other state
        download: st.download ? Object.assign({}, st.download) : null, // programming progress
        dtcs: st.dtcs.map((d) => ({ code: d.code.slice(), text: core.dtcText(d.code), status: d.status })), dtcCount: st.dtcs.length, // DTCs
      };
    }

    /** Restores the power-on state (DTCs, data and PRNG included). */
    function reset() {
      st = freshState(); // brand new state
    }

    return { handle, tick, reset, snapshot, demoKey, config: cfg }; // ECU API
  }

  /**
   * Sends a request through ISO-TP to the ECU and returns every frame on the bus.
   * @param {object} ecu ECU from createEcu
   * @param {number[]} req request bytes
   * @param {number} tNowSec time of the first request frame (s)
   * @param {object} [cfg] {reqId, rspId, ext, fd, canDl, brs, pad, extAddr, rspExtAddr, stMinMs, functional, iface}
   * @returns {{frames: object[], responses: object[], events: string[], tEnd: number, functional: boolean}} bus trace
   */
  function exchange(ecu, req, tNowSec, cfg) {
    const c = Object.assign({ ext: false, fd: false, canDl: 64, brs: false, pad: 0xAA, extAddr: null, rspExtAddr: null, stMinMs: 0, functional: false, iface: 'can0' }, cfg || {}); // defaults
    if (c.reqId === undefined) c.reqId = c.ext ? 0x18DA10F1 : 0x7E0; // physical request ID
    if (c.rspId === undefined) c.rspId = c.ext ? 0x18DAF110 : 0x7E8; // response ID
    const funcId = c.ext ? 0x18DB33F1 : 0x7DF; // functional request ID
    const functional = !!c.functional || c.reqId === funcId; // a request on the functional ID is functional
    const txId = c.functional ? funcId : c.reqId; // ID the tester sends on
    const physId = c.reqId === funcId ? (c.ext ? 0x18DA10F1 : 0x7E0) : c.reqId; // ID for the tester's flow control
    const t0 = Number(tNowSec) || 0; // start time
    const reqOpts = { fd: c.fd, canDl: c.canDl, pad: c.pad, extAddr: c.extAddr }; // tester framing
    const rspOpts = { fd: c.fd, canDl: c.canDl, pad: c.pad, extAddr: c.rspExtAddr === null && c.extAddr !== null ? 0xF1 : c.rspExtAddr }; // ECU framing
    const stByte = core.encodeStmin(c.stMinMs); // STmin byte for flow control
    const sep = Math.max(core.stminMs(stByte), 0.2) / 1000; // gap between CFs (at least 0.2 ms of bus time)
    const turn = 0.001; // time to answer a First Frame with a Flow Control (1 ms)
    const frames = []; // bus trace
    const events = []; // driver and ECU events
    const mk = (t, id, data, who) => ({ t: Number(t.toFixed(6)), id, ext: !!c.ext, data, fd: !!c.fd, brs: !!c.fd && !!c.brs, who, iface: c.iface }); // frame object

    /**
     * Puts one message on the bus with its flow control.
     * @param {number[]} payload message bytes
     * @param {number} t time of the first frame
     * @param {number} id sender ID
     * @param {number} fcId receiver's ID for flow control
     * @param {object} opts sender framing
     * @param {object} fcOpts receiver framing
     * @param {string} who 'tester' or 'ecu'
     * @param {string} other the receiver
     * @returns {number} time of the last frame
     */
    function send(payload, t, id, fcId, opts, fcOpts, who, other) {
      const segs = core.segment(payload, opts); // ISO-TP frames
      frames.push(mk(t, id, segs[0], who)); // SF or FF
      if (segs.length === 1) return t; // single frame: done
      let tt = t + turn; // flow control after the turnaround time
      frames.push(mk(tt, fcId, core.flowControl(fcOpts, 0, 0, stByte), other)); // ContinueToSend, BS 0
      for (let k = 1; k < segs.length; k++) { tt += sep; frames.push(mk(tt, id, segs[k], who)); } // CFs spaced by STmin
      return tt; // last frame time
    }

    const p = Array.isArray(req) ? req : []; // request bytes
    if (!p.length) return { frames, responses: [], events: ['Empty request: nothing sent'], tEnd: t0, functional }; // nothing to send
    if (functional && core.segment(p, reqOpts).length > 1) { // ISO-TP functional addressing allows single frames only
      return { frames, responses: [], events: ['Functional requests must fit in one Single Frame; nothing was sent'], tEnd: t0, functional }; // refuse
    }
    const tReqEnd = send(p, t0, txId, c.rspId, reqOpts, rspOpts, 'tester', 'ecu'); // request on the bus
    const h = ecu.handle(p, tReqEnd * 1000, { functional }); // the ECU processes it after the last frame
    events.push(...h.events); // ECU events
    const responses = []; // responses with their times
    let tEnd = tReqEnd; // last frame time so far
    for (const r of h.responses) { // each response in time order
      const tr = tReqEnd + r.delayMs / 1000; // when the ECU starts sending
      tEnd = Math.max(tEnd, send(r.bytes, tr, c.rspId, physId, rspOpts, reqOpts, 'ecu', 'tester')); // response on the bus
      responses.push({ bytes: r.bytes, delayMs: r.delayMs, t: Number(tr.toFixed(6)) }); // keep the time
    }
    frames.sort((a, b) => a.t - b.t); // bus order (stable for equal times)
    return { frames, responses, events, tEnd: Number(tEnd.toFixed(6)), functional }; // bus trace
  }

  const EGSIM = { createEcu, exchange, demoKey, DEFAULTS, SESSION_NAMES, SUPPORTED }; // the one global
  root.EGSIM = EGSIM; // browser global
  if (typeof module !== 'undefined' && module.exports) module.exports = EGSIM; // Node / tests
})(typeof globalThis !== 'undefined' ? globalThis : this); // the global object in any environment
