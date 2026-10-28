/*
 * UDS Bench core by Embedded Garage.
 * Log parsing, ISO-TP (ISO 15765-2) reassembly and segmentation, UDS (ISO 14229-1) and OBD-II (SAE J1979) decoding.
 * No DOM access: this file runs unchanged in Node (tests) and in the browser (global EGUDS).
 * Every public function is defensive: bad input is reported, never thrown.
 * Table rows share the comment above their table; rows we are not certain of carry a VERIFY marker (see docs/VERIFY.md).
 */
(function (root) { // wrap everything so only one global is created
  'use strict'; // catch accidental globals and silent errors

  // ---------------------------------------------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------------------------------------------

  const LEVELS = { ok: 0, info: 1, warn: 2, error: 3 }; // severity order used to pick the worst level

  /**
   * Returns the more severe of two levels.
   * @param {string} a level name
   * @param {string} b level name
   * @returns {string} the worse level
   */
  function worse(a, b) {
    return (LEVELS[b] || 0) > (LEVELS[a] || 0) ? b : a; // unknown names count as 'ok'
  }

  /**
   * Formats a byte as two upper-case hex digits.
   * @param {number} b byte value
   * @returns {string} e.g. "0A"
   */
  function hex2(b) {
    return ((b & 0xFF) + 0x100).toString(16).slice(1).toUpperCase(); // add 0x100 to force a leading zero
  }

  /**
   * Formats a byte array as space-separated hex.
   * @param {number[]} arr bytes
   * @returns {string} e.g. "22 F1 90"
   */
  function hexBytes(arr) {
    return (arr || []).map(hex2).join(' '); // one token per byte
  }

  /**
   * Formats a number as upper-case hex with a fixed number of digits.
   * @param {number} v value
   * @param {number} digits minimum digit count
   * @returns {string} padded hex
   */
  function hexN(v, digits) {
    return (v >>> 0).toString(16).toUpperCase().padStart(digits, '0'); // unsigned so large values stay positive
  }

  /**
   * Formats a CAN ID the way candump does: 3 digits for 11-bit, 8 digits for 29-bit.
   * @param {number} id CAN identifier
   * @param {boolean} ext true for a 29-bit identifier
   * @returns {string} hex ID
   */
  function hexId(id, ext) {
    return hexN(id, ext ? 8 : 3); // width depends on the identifier type
  }

  /**
   * Reads a big-endian unsigned integer from bytes (up to 4 bytes stays exact; more bytes use floating point).
   * @param {number[]} b bytes, most significant first
   * @returns {number} value
   */
  function beNum(b) {
    let v = 0; // accumulator
    for (const x of b) v = v * 256 + x; // multiply instead of shifting so 4-byte values do not go negative
    return v; // the assembled number
  }

  /**
   * Formats a number with at most `d` decimals and no trailing zeros.
   * @param {number} x value
   * @param {number} d maximum decimals
   * @returns {string} formatted number
   */
  function num(x, d) {
    return String(Number(x.toFixed(d))); // Number() drops trailing zeros left by toFixed
  }

  /**
   * True when every byte is printable ASCII (space to tilde).
   * @param {number[]} b bytes
   * @returns {boolean} printable or not
   */
  function printable(b) {
    return b.length > 0 && b.every((x) => x >= 0x20 && x <= 0x7E); // empty arrays are not text
  }

  /**
   * Converts bytes to a string assuming ASCII.
   * @param {number[]} b bytes
   * @returns {string} text
   */
  function ascii(b) {
    return String.fromCharCode.apply(null, b); // bytes 0x20..0x7E map one-to-one onto characters
  }

  /**
   * Returns text for a byte array when it is printable ASCII after removing trailing 00/FF/space padding.
   * @param {number[]} b bytes
   * @returns {string|null} quoted text, or null when not text
   */
  function asText(b) {
    let end = b.length; // index just past the last meaningful byte
    while (end > 0 && (b[end - 1] === 0x00 || b[end - 1] === 0xFF)) end--; // strip common fill bytes
    const core = b.slice(0, end); // the part that should be text
    return printable(core) ? '"' + ascii(core) + '"' : null; // quote so padding spaces stay visible
  }

  /**
   * Makes a clean byte array from anything array-like; non-arrays become empty.
   * @param {*} payload candidate byte array
   * @returns {number[]} bytes 0..255
   */
  function toBytes(payload) {
    if (!Array.isArray(payload)) return []; // anything else is treated as no data
    return payload.map((x) => (Number(x) & 0xFF) >>> 0); // force integers in range so later code can trust them
  }

  /**
   * Plural helper for counts in messages.
   * @param {number} n count
   * @param {string} word singular word
   * @returns {string} e.g. "1 byte", "2 bytes"
   */
  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's'); // simple English plural
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Hex input helpers (used by the UI for ID lists and the composer)
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Parses a comma- or space-separated list of hex CAN IDs ("7E0, 18DAF110").
   * @param {string} text user text
   * @returns {{ids: number[], bad: string[]}} parsed IDs and tokens that were not valid
   */
  function parseIdList(text) {
    const out = { ids: [], bad: [] }; // result containers
    String(text == null ? '' : text).split(/[\s,;]+/).forEach((tok) => { // split on commas, semicolons and spaces
      if (!tok) return; // ignore empty pieces from repeated separators
      const t = tok.replace(/^0x/i, ''); // accept an optional 0x prefix
      if (/^[0-9A-Fa-f]{1,8}$/.test(t) && parseInt(t, 16) <= 0x1FFFFFFF) out.ids.push(parseInt(t, 16)); // valid 11- or 29-bit ID
      else out.bad.push(tok); // report anything else back to the user
    });
    return out; // parsed list
  }

  /**
   * Parses hex bytes typed by a user: "22 F190", "22F190", "0x22 0xF1 0x90".
   * @param {string} text user text
   * @returns {{bytes: number[], error: string|null}} bytes, or an explanation of what is wrong
   */
  function parseHexBytes(text) {
    const tokens = String(text == null ? '' : text).trim().split(/[\s,]+/).filter(Boolean); // whitespace or commas separate groups
    const bytes = []; // collected bytes
    for (const tok of tokens) { // each group may hold several bytes
      const t = tok.replace(/^0x/i, ''); // optional 0x prefix
      if (!/^[0-9A-Fa-f]+$/.test(t)) return { bytes: [], error: `"${tok}" is not hex` }; // non-hex characters
      if (t.length % 2) return { bytes: [], error: `"${tok}" has an odd number of digits` }; // half a byte is ambiguous
      for (let i = 0; i < t.length; i += 2) bytes.push(parseInt(t.substr(i, 2), 16)); // two digits per byte
    }
    return { bytes, error: null }; // success
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Log parsing (spec section 3)
  // ---------------------------------------------------------------------------------------------------------------

  const RE_CANDUMP_L = /^\((\d+(?:\.\d+)?)\)\s+(\S+)\s+([0-9A-Fa-f]{1,8})(##|#)(\S*)(?:\s+[RT])?$/; // (time) iface ID#data, optional R/T marker
  const RE_HASH = /^([0-9A-Fa-f]{1,8})(##|#)(\S*)$/; // ID#data with no time or interface
  const RE_ASC = /^(\d+(?:\.\d+)?)\s+(\d+)\s+([0-9A-Fa-f]{1,8})(x?)\s+(Tx|Rx)\s+[dD]\s+(\d{1,2})\b\s*(.*)$/; // Vector ASC classic data frame
  const RE_CANDUMP = /^(?:\((\d+(?:\.\d+)?)\)\s+)?(\S+)\s+([0-9A-Fa-f]{1,8})\s+\[(\d{1,2})\]\s*(.*)$/; // candump default, optional (time)
  const RE_PLAIN = /^([0-9A-Fa-f]{3}|[0-9A-Fa-f]{8}):?\s+(.+)$/; // ID then bytes, optional colon after the ID
  const RE_RAW = /^[0-9A-Fa-f]{2}(?:\s+[0-9A-Fa-f]{2})*$/; // nothing but two-digit bytes: a ready-made payload

  /**
   * Converts the ID text of a log line into a number and its 11/29-bit flag.
   * @param {string} t hex digits
   * @returns {{id: number, ext: boolean}|null} parsed ID or null when out of range
   */
  function parseId(t) {
    const id = parseInt(t, 16); // hex to number
    if (id > 0x1FFFFFFF) return null; // larger than a 29-bit identifier
    const ext = t.length === 8 || id > 0x7FF; // 8 digits, or a value that cannot be 11-bit
    return { id, ext }; // parsed ID
  }

  /**
   * Converts contiguous hex digits ("0210AA") into bytes.
   * @param {string} s hex string
   * @returns {number[]|null} bytes, or null when the digit count is odd or a character is not hex
   */
  function hexRun(s) {
    if (s.length % 2 || !/^[0-9A-Fa-f]*$/.test(s)) return null; // odd count or bad character makes the line malformed
    const out = []; // bytes
    for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16)); // two digits per byte
    return out; // decoded bytes
  }

  /**
   * Converts whitespace-separated hex groups ("02 10 03" or "021003") into bytes.
   * @param {string} s text after the ID
   * @returns {number[]|null} bytes, or null when a group is malformed
   */
  function hexTokens(s) {
    const toks = s.trim().split(/\s+/).filter(Boolean); // groups of digits
    const out = []; // bytes
    for (const t of toks) { // every group must be whole bytes
      const b = hexRun(t); // decode this group
      if (!b) return null; // one bad group spoils the line
      out.push(...b); // append its bytes
    }
    return out; // decoded bytes
  }

  /**
   * Builds the frame object shared by all formats and checks the data length.
   * @param {object} p partial frame fields
   * @returns {object} frame, or {error} describing why the line is malformed
   */
  function makeFrame(p) {
    if (p.data.length > 64) return { error: 'more than 64 data bytes' }; // no CAN frame is that long
    const fd = !!p.fd || p.data.length > 8; // FD when the format says so or the frame is too long for classic CAN
    return { // the frame object from spec section 3
      index: -1, line: p.line, time: p.time, iface: p.iface, id: p.id, ext: p.ext, // identity and origin
      fd, brs: !!p.brs, data: p.data, dirHint: p.dirHint || null, dir: null, // content and direction
    };
  }

  /**
   * Parses one non-empty, non-comment line in any supported format.
   * @param {string} s trimmed line
   * @param {number} line 1-based line number
   * @returns {object|null} {frame}, {raw}, {error} or null when no format matches
   */
  function parseLine(s, line) {
    let m = RE_CANDUMP_L.exec(s); // candump -L
    if (m) { // (time) iface ID#data
      const idp = parseId(m[3]); // identifier
      if (!idp) return { error: 'CAN ID out of range' }; // larger than 29 bits
      let body = m[5]; // text after the separator
      let fd = false, brs = false; // set for the ## form
      if (m[4] === '##') { // CAN FD: one flags nibble, then data
        if (!/^[0-9A-Fa-f]/.test(body)) return { error: 'missing CAN FD flags digit after ##' }; // flags are mandatory
        const flags = parseInt(body[0], 16); // flags nibble
        fd = true; brs = (flags & 1) === 1; body = body.slice(1); // bit 0 = bit rate switch
      } else if (/^R/i.test(body)) return { error: 'remote frame (no data)' }; // RTR frames carry no diagnostic data
      const data = hexRun(body); // data bytes
      if (!data) return { error: 'odd number of data digits or a non-hex character' }; // malformed data
      return { frame: makeFrame({ line, time: parseFloat(m[1]), iface: m[2], ...idp, fd, brs, data }) }; // done
    }
    m = RE_HASH.exec(s); // plain ID#data
    if (m) { // same body rules as candump -L, without time and interface
      const idp = parseId(m[1]); // identifier
      if (!idp) return { error: 'CAN ID out of range' }; // larger than 29 bits
      let body = m[3]; // text after the separator
      let fd = false, brs = false; // set for the ## form
      if (m[2] === '##') { // CAN FD flags nibble
        if (!/^[0-9A-Fa-f]/.test(body)) return { error: 'missing CAN FD flags digit after ##' }; // flags are mandatory
        fd = true; brs = (parseInt(body[0], 16) & 1) === 1; body = body.slice(1); // bit 0 = BRS
      } else if (/^R/i.test(body)) return { error: 'remote frame (no data)' }; // RTR frame
      const data = hexRun(body); // data bytes
      if (!data) return { error: 'odd number of data digits or a non-hex character' }; // malformed
      return { frame: makeFrame({ line, time: null, iface: null, ...idp, fd, brs, data }) }; // done
    }
    m = RE_ASC.exec(s); // Vector ASC
    if (m) { // time channel ID[x] Tx|Rx d dlc bytes...
      const idp = parseId(m[3]); // identifier
      if (!idp) return { error: 'CAN ID out of range' }; // larger than 29 bits
      if (m[4] === 'x') idp.ext = true; // trailing x marks a 29-bit ID even when it has few digits
      const dlc = parseInt(m[6], 10); // declared data length
      if (dlc > 8) return { error: 'classic ASC frame with DLC above 8' }; // classic ASC lines carry at most 8 bytes
      const toks = m[7].trim() ? m[7].trim().split(/\s+/) : []; // remaining tokens (data plus optional extra fields)
      const bytes = toks.slice(0, dlc); // the first DLC tokens are the data
      if (bytes.length < dlc || !bytes.every((t) => /^[0-9A-Fa-f]{2}$/.test(t))) return { error: 'fewer data bytes than the DLC says' }; // malformed
      return { // ASC Tx/Rx gives a direction hint
        frame: makeFrame({ line, time: parseFloat(m[1]), iface: m[2], ...idp, data: bytes.map((t) => parseInt(t, 16)), dirHint: m[5] === 'Tx' ? 'req' : 'rsp' }),
      };
    }
    m = RE_CANDUMP.exec(s); // candump default
    if (m) { // [(time)] iface ID [n] bytes
      const idp = parseId(m[3]); // identifier
      if (!idp) return { error: 'CAN ID out of range' }; // larger than 29 bits
      const data = hexTokens(m[5]); // data bytes
      const n = parseInt(m[4], 10); // declared length
      if (!data || data.length !== n) return { error: 'byte count does not match the [length] field' }; // malformed
      return { frame: makeFrame({ line, time: m[1] ? parseFloat(m[1]) : null, iface: m[2], ...idp, data }) }; // done
    }
    if (RE_RAW.test(s)) { // only two-digit bytes: a ready-made payload, checked before "plain" so "22 F1 90" is not ID 22
      return { raw: { line, data: s.split(/\s+/).map((t) => parseInt(t, 16)) } }; // raw payload
    }
    m = RE_PLAIN.exec(s); // plain "ID bytes" or "ID: bytes"
    if (m) { // three- or eight-digit ID then bytes
      const idp = parseId(m[1]); // identifier
      if (!idp) return { error: 'CAN ID out of range' }; // larger than 29 bits
      const data = hexTokens(m[2]); // data bytes
      if (!data) return { error: 'odd number of data digits or a non-hex character' }; // malformed
      return { frame: makeFrame({ line, time: null, iface: null, ...idp, data }) }; // done
    }
    return null; // no format matched
  }

  /**
   * Parses a pasted log. Never throws.
   * @param {string} text log text
   * @returns {{frames: object[], raws: object[], ignored: {line: number, text: string, reason: string}[]}} parse result
   */
  function parseLog(text) {
    const out = { frames: [], raws: [], ignored: [] }; // result containers
    const src = typeof text === 'string' ? text : String(text == null ? '' : text); // tolerate non-strings
    const lines = src.split(/\r\n|\r|\n/); // any line ending
    for (let i = 0; i < lines.length; i++) { // one line at a time
      const s = lines[i].trim(); // surrounding whitespace never matters
      if (!s || s.startsWith('#') || s.startsWith('//')) continue; // blank lines and comments are skipped silently
      let r = null; // parse result
      try { r = parseLine(s, i + 1); } catch (e) { r = { error: 'could not be parsed' }; } // belt and braces: never throw
      if (r && r.frame && !r.error && !r.frame.error) { // a CAN frame
        r.frame.index = out.frames.length; // position in the frames array
        out.frames.push(r.frame); // keep it
      } else if (r && r.raw) { // a ready-made payload
        r.raw.index = out.raws.length; // position in the raws array
        out.raws.push(r.raw); // keep it
      } else { // unrecognised or malformed
        const reason = r ? (r.error || (r.frame && r.frame.error)) : 'matches no supported format'; // say why
        out.ignored.push({ line: i + 1, text: s.length > 200 ? s.slice(0, 200) + '…' : s, reason }); // cap the stored text
      }
    }
    return out; // parsed log
  }

  // ---------------------------------------------------------------------------------------------------------------
  // CAN ID roles (spec section 4)
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Decides whether a CAN ID carries requests or responses.
   * @param {number} id CAN identifier
   * @param {boolean} ext 29-bit flag
   * @param {{reqIds?: number[], rspIds?: number[]}} [cfg] user-supplied ID lists, checked first
   * @returns {'req'|'rsp'|null} role, or null when unknown
   */
  function classifyId(id, ext, cfg) {
    const c = cfg || {}; // optional configuration
    if (Array.isArray(c.reqIds) && c.reqIds.includes(id)) return 'req'; // user said so
    if (Array.isArray(c.rspIds) && c.rspIds.includes(id)) return 'rsp'; // user said so
    if (!ext) { // 11-bit OBD / UDS convention
      if (id === 0x7DF || (id >= 0x7E0 && id <= 0x7E7)) return 'req'; // functional and physical requests
      if (id >= 0x7E8 && id <= 0x7EF) return 'rsp'; // ECU responses
      return null; // anything else is not a known diagnostic ID
    }
    if (id === 0x18DB33F1) return 'req'; // 29-bit functional request
    if (((id >>> 16) & 0x1FFF) === 0x18DA) return ((id >>> 8) & 0xFF) === 0xF1 ? 'rsp' : 'req'; // 18DA tt ss: target F1 = tester
    return null; // unknown 29-bit ID
  }

  /**
   * Infers the direction of a payload from its first byte when the CAN ID gives no hint.
   * @param {number[]} payload message bytes
   * @returns {'req'|'rsp'|null} direction, or null for an empty payload
   */
  function inferDir(payload) {
    const p = toBytes(payload); // sanitise
    if (!p.length) return null; // nothing to look at
    if (p[0] === 0x7F) return 'rsp'; // negative response
    if (p[0] >= 0x41 && p[0] <= 0x4A) return 'rsp'; // OBD-II response modes
    if (UDS_SERVICES[p[0] - 0x40]) return 'rsp'; // positive response to a known UDS service
    return 'req'; // otherwise assume a request
  }

  // ---------------------------------------------------------------------------------------------------------------
  // ISO-TP (spec section 5)
  // ---------------------------------------------------------------------------------------------------------------

  const DLC_SIZES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64]; // CAN FD frame sizes reachable with a DLC
  const FC_STATUS = ['ContinueToSend', 'Wait', 'Overflow']; // FlowStatus names 0..2

  /**
   * Describes an STmin byte.
   * @param {number} b STmin byte
   * @returns {string} e.g. "0 ms", "100 µs", "reserved (0x80, treated as 127 ms)"
   */
  function stminText(b) {
    if (b <= 0x7F) return b + ' ms'; // 0..127 milliseconds
    if (b >= 0xF1 && b <= 0xF9) return (b - 0xF0) * 100 + ' µs'; // 100..900 microseconds
    return 'reserved (0x' + hex2(b) + ', treated as 127 ms)'; // reserved values fall back to the maximum
  }

  /**
   * Converts an STmin byte into milliseconds (reserved values count as 127 ms).
   * @param {number} b STmin byte
   * @returns {number} milliseconds
   */
  function stminMs(b) {
    if (b <= 0x7F) return b; // plain milliseconds
    if (b >= 0xF1 && b <= 0xF9) return (b - 0xF0) / 10; // tenths of a millisecond
    return 127; // reserved
  }

  /**
   * Encodes a separation time in milliseconds as an STmin byte (0..127 ms or 0.1..0.9 ms).
   * @param {number} ms separation time
   * @returns {number} STmin byte
   */
  function encodeStmin(ms) {
    const v = Number(ms); // tolerate strings
    if (!(v > 0)) return 0; // zero, negative or NaN mean "no gap"
    if (v < 1) return 0xF0 + Math.min(9, Math.max(1, Math.round(v * 10))); // sub-millisecond range
    return Math.min(127, Math.round(v)); // whole milliseconds, capped at the maximum
  }

  /**
   * Builds the per-transfer key so different IDs (and address bytes) keep separate state.
   * @param {object} f frame
   * @param {number|null} addr extended address byte or null
   * @returns {string} map key
   */
  function flowKey(f, addr) {
    return (f.ext ? 'x' : 's') + f.id + '/' + (addr === null ? '-' : addr); // 11-bit and 29-bit IDs never collide
  }

  /**
   * Reassembles ISO-TP messages from CAN frames. Never throws.
   * @param {object[]} frames frames from parseLog
   * @param {{addressing?: string, reqIds?: number[], rspIds?: number[]}} [opts] addressing 'normal' or 'extended'
   * @returns {{messages: object[], timeline: object[], events: object[]}} reassembly result
   */
  function reassemble(frames, opts) {
    const o = opts || {}; // optional settings
    const extAddr = o.addressing === 'extended'; // first data byte is an address byte
    const list = Array.isArray(frames) ? frames : []; // tolerate bad input
    const messages = [], timeline = [], events = []; // outputs
    const open = new Map(); // flow key → open multi-frame transfer
    const knownIds = list.some((f) => f && classifyId(f.id, f.ext, o) !== null); // does the log contain diagnostic IDs at all?
    const deferred = []; // problems found before a frame's meaning text is set; added once the frame is processed

    /**
     * Records a problem on a timeline entry and in the event list.
     * @param {object} entry timeline entry
     * @param {string} level 'warn' or 'error'
     * @param {string} text problem description
     */
    function problem(entry, level, text) {
      entry.level = worse(entry.level, level); // the entry shows its worst problem
      entry.text += ' · ' + text; // keep the frame meaning first, then the problem
      events.push({ index: entry.index, level, text: hexId(entry.id, entry.ext) + ': ' + text }); // summary list
    }

    /**
     * Builds a message object.
     * @param {object} f first frame
     * @param {object} p fields that differ per message
     * @returns {object} message
     */
    function makeMsg(f, p) {
      return { // message object from spec section 5
        no: 0, id: f.id, ext: f.ext, addr: p.addr, dir: null, time: f.time, endTime: p.endTime, // filled by numbering later
        frameIdx: p.frameIdx, kind: p.kind, payload: p.payload, partial: !!p.partial, error: p.error || null, // content
        level: p.level || 'ok', line: f.line, total: p.total, fd: !!f.fd, dirHint: f.dirHint || null, // context
      };
    }

    /**
     * Emits an open transfer as a partial message.
     * @param {object} t open transfer
     * @param {string} error why it is partial
     * @param {string} level 'warn' or 'error'
     */
    function emitPartial(t, error, level) {
      messages.push(makeMsg(t.first, { // partial message keeps the bytes received so far
        addr: t.addr, endTime: t.endTime, frameIdx: t.frameIdx, kind: 'MF', payload: t.payload, // content so far
        partial: true, error, level, total: t.total, // flagged
      }));
    }

    for (let i = 0; i < list.length; i++) { // frames in log order
      const f = list[i]; // current frame
      const ok = f && Array.isArray(f.data); // is it a usable frame object?
      const entry = { index: i, id: ok ? f.id : 0, ext: ok ? !!f.ext : false, time: ok ? f.time : null, kind: '??', text: '', level: 'ok', msgNo: null, pciLen: 0 }; // timeline row
      timeline.push(entry); // one row per frame
      if (!ok) { problem(entry, 'error', 'not a frame object'); continue; } // defensive: skip garbage objects
      if (knownIds && classifyId(f.id, f.ext, o) === null) { // other bus traffic in a log with diagnostic IDs
        entry.kind = '--'; entry.text = 'not a diagnostic ID, skipped'; entry.level = 'info'; // shown, not decoded
        continue; // next frame
      }
      const d = toBytes(f.data); // sanitised data
      if (d.length > 8 && !DLC_SIZES.includes(d.length)) deferred.push([entry, 'warn', 'frame length ' + d.length + ' is not a legal CAN FD frame size (' + DLC_SIZES.filter((n) => n > 8).join(', ') + ')']); // no DLC can express it
      const off = extAddr ? 1 : 0; // PCI position
      const addr = extAddr && d.length ? d[0] : null; // extended address byte
      const addrNote = addr === null ? '' : ' · address ' + hex2(addr); // appended to the frame meaning
      if (d.length <= off) { problem(entry, 'error', extAddr ? 'frame too short for an address byte and a PCI byte' : 'empty frame (no PCI byte)'); continue; } // nothing to decode
      const pci = d[off]; // protocol control information byte
      const type = pci >> 4; // frame type nibble
      const key = flowKey(f, addr); // per-ID state key
      const dir = classifyId(f.id, f.ext, o); // ID role, used to fill message.dir later
      if (type === 0) { // Single Frame
        entry.kind = 'SF'; // frame type
        let len = pci & 0x0F; // 4-bit SF_DL
        let hdr = 1; // PCI byte count
        if (len === 0) { // zero means the CAN FD escape form, valid only in frames longer than 8 bytes
          if (d.length > 8) { // escape: the next byte holds SF_DL
            len = d[off + 1]; hdr = 2; // 8-bit SF_DL
            entry.pciLen = off + 2; // highlight address + both PCI bytes
            entry.text = 'SF · ' + plural(len, 'byte') + ' (escape length)' + addrNote; // meaning
            if (len === 0) { problem(entry, 'error', 'SF_DL = 0 is invalid'); continue; } // empty single frame
          } else { // classic-size frame with SF_DL 0
            entry.pciLen = off + 1; entry.text = 'SF · length 0' + addrNote; // meaning
            problem(entry, 'error', f.fd ? 'SF_DL = 0 is invalid in a frame of 8 bytes or fewer' : 'SF_DL = 0 is invalid in a classic CAN frame'); // spec wording
            continue; // nothing to emit
          }
        } else { // 4-bit length
          entry.pciLen = off + 1; // highlight address + PCI byte
          entry.text = 'SF · ' + plural(len, 'byte') + addrNote; // meaning
          if (d.length > 8) problem(entry, 'warn', '4-bit SF_DL in a frame of ' + d.length + ' bytes; the escape form is required above 8 bytes'); // ISO 15765-2 CAN FD rule
        }
        const avail = d.length - off - hdr; // data bytes actually present
        if (len > avail) { problem(entry, 'error', 'SF_DL ' + len + ' does not fit in the frame (' + plural(avail, 'data byte') + ')'); continue; } // impossible length
        if (open.has(key)) { // a single frame interrupts an unfinished transfer
          const t = open.get(key); // the transfer being dropped
          problem(entry, 'warn', 'Single Frame while a transfer was open; the open transfer (' + t.payload.length + ' of ' + t.total + ' bytes) is discarded'); // ISO: receiver drops it
          open.delete(key); // forget it
        }
        entry.msgRef = makeMsg(f, { addr, endTime: f.time, frameIdx: [i], kind: 'SF', payload: d.slice(off + hdr, off + hdr + len), total: len }); // the message
        entry.msgRef.dir = dir; // remember the ID role
        messages.push(entry.msgRef); // complete message
      } else if (type === 1) { // First Frame
        entry.kind = 'FF'; // frame type
        if (d.length < off + 2) { entry.pciLen = d.length; entry.text = 'FF' + addrNote; problem(entry, 'error', 'First Frame too short for its length field'); continue; } // truncated PCI
        let total = ((pci & 0x0F) << 8) | d[off + 1]; // 12-bit FF_DL
        let hdr = 2; // PCI byte count
        let escape = false; // 32-bit form?
        if (total === 0) { // escape: 32-bit length follows
          if (d.length < off + 6) { entry.pciLen = d.length; entry.text = 'FF' + addrNote; problem(entry, 'error', 'First Frame too short for its 32-bit length'); continue; } // truncated
          total = beNum(d.slice(off + 2, off + 6)); hdr = 6; escape = true; // 32-bit FF_DL
          if (total === 0) { entry.pciLen = off + 6; entry.text = 'FF · total 0 bytes' + addrNote; problem(entry, 'error', 'FF_DL = 0 is invalid'); continue; } // nothing to transfer
        }
        entry.pciLen = off + hdr; // highlight address + PCI bytes
        entry.text = 'FF · total ' + plural(total, 'byte') + (escape ? ' (32-bit length)' : '') + addrNote; // meaning
        if (open.has(key)) { // a new transfer replaces the open one
          const t = open.get(key); // dropped transfer
          problem(entry, 'warn', 'new First Frame while a transfer was open; the open transfer (' + t.payload.length + ' of ' + t.total + ' bytes) is discarded'); // spec rule
          open.delete(key); // forget it
        }
        const payload = d.slice(off + hdr, off + hdr + total); // payload bytes in this frame
        if (payload.length >= total) { // the whole message fit in the First Frame (unusual but decodable)
          problem(entry, 'warn', 'FF_DL is small enough for a Single Frame'); // a sender should have used a SF
          entry.msgRef = makeMsg(f, { addr, endTime: f.time, frameIdx: [i], kind: 'MF', payload, total }); // complete at once
          entry.msgRef.dir = dir; messages.push(entry.msgRef); // emit
          continue; // done with this frame
        }
        open.set(key, { first: f, addr, total, payload, frameIdx: [i], sn: 1, endTime: f.time, dir, ffLen: d.length }); // wait for CFs; ffLen is the sender's frame size
      } else if (type === 2) { // Consecutive Frame
        entry.kind = 'CF'; // frame type
        entry.pciLen = off + 1; // highlight address + PCI byte
        const sn = pci & 0x0F; // sequence number
        entry.text = 'CF · SN ' + sn + addrNote; // meaning
        const t = open.get(key); // transfer this frame should continue
        if (!t) { problem(entry, 'error', 'orphan Consecutive Frame (no open transfer on this ID)'); continue; } // nothing to continue
        if (sn !== t.sn) { // wrong sequence number aborts the transfer
          problem(entry, 'error', 'expected SN ' + t.sn + ', got ' + sn); // spec wording
          emitPartial(t, 'sequence error: expected SN ' + t.sn + ', got ' + sn + ' after ' + t.payload.length + ' of ' + t.total + ' bytes', 'error'); // flagged partial
          open.delete(key); // transfer is over
          continue; // the bad frame is not part of the message
        }
        const need = t.total - t.payload.length; // bytes still expected
        const chunk = d.slice(off + 1, off + 1 + need); // bytes beyond the announced length are padding
        t.payload = t.payload.concat(chunk); // append
        t.frameIdx.push(i); // remember the frame
        t.endTime = f.time; // last frame time so far
        t.sn = (t.sn + 1) & 0x0F; // next expected SN, wrapping 15 → 0
        entry.pendingRef = t; // used to fill msgNo once the message exists
        if (t.payload.length >= t.total) { // transfer complete
          entry.msgRef = makeMsg(t.first, { addr, endTime: f.time, frameIdx: t.frameIdx, kind: 'MF', payload: t.payload, total: t.total }); // full message
          entry.msgRef.dir = t.dir; messages.push(entry.msgRef); // emit
          open.delete(key); // transfer closed
        } else if (d.length < (f.fd ? Math.max(8, t.ffLen) : 8)) { // a CF shorter than the sender's frame size while data is still missing
          problem(entry, 'warn', 'short Consecutive Frame (' + d.length + ' bytes' + (f.fd && t.ffLen > 8 ? ', First Frame had ' + t.ffLen : '') + ') while more data is expected'); // only the last CF may be short (classic: 8 bytes; CAN FD: the FF's size)
        }
      } else if (type === 3) { // Flow Control
        entry.kind = 'FC'; // frame type
        entry.pciLen = Math.min(d.length, off + 3); // address + FS + BS + STmin
        const fs = pci & 0x0F; // flow status
        if (d.length < off + 3) { entry.text = 'FC' + addrNote; problem(entry, 'error', 'Flow Control frame too short (needs FS, BS and STmin)'); continue; } // truncated
        const bs = d[off + 1], st = d[off + 2]; // block size and separation time
        const params = 'BS ' + bs + (bs === 0 ? ' (no limit)' : '') + ', STmin ' + stminText(st); // parameter text
        if (fs <= 2) entry.text = 'FC · ' + FC_STATUS[fs] + ', ' + params + addrNote; // known status
        else entry.text = 'FC · FlowStatus ' + fs + addrNote; // unknown status
        if (fs === 2) problem(entry, 'error', 'receiver reports buffer overflow'); // the receiver cannot take the message
        else if (fs > 2) problem(entry, 'error', 'invalid FlowStatus ' + fs); // reserved values
        else if (st > 0x7F && !(st >= 0xF1 && st <= 0xF9)) problem(entry, 'warn', 'reserved STmin 0x' + hex2(st)); // sender must use 127 ms
      } else { // 4..F
        entry.kind = '??'; entry.pciLen = off + 1; entry.text = 'PCI 0x' + hex2(pci) + addrNote; // unknown frame
        problem(entry, 'error', 'invalid PCI type ' + type.toString(16).toUpperCase()); // spec wording
      }
    }
    for (const [entry, level, text] of deferred) problem(entry, level, text); // frame-size problems, after the frame meaning is set
    events.sort((a, b) => a.index - b.index); // keep the problem list in frame order (sort is stable)
    for (const t of open.values()) { // transfers still open at the end of the log
      const last = timeline[t.frameIdx[t.frameIdx.length - 1]]; // last frame that belonged to it
      const text = 'received ' + t.payload.length + ' of ' + t.total + ' bytes'; // spec wording
      events.push({ index: last.index, level: 'warn', text: hexId(t.first.id, t.first.ext) + ': incomplete transfer at end of log, ' + text }); // summary
      last.level = worse(last.level, 'warn'); // mark the last frame
      last.text += ' · transfer incomplete (' + text + ')'; // and explain on it
      emitPartial(t, 'incomplete: ' + text, 'warn'); // keep the bytes we have
    }
    for (const m of messages) m.dir = m.dir || m.dirHint || inferDir(m.payload); // ID role first, then log hint, then payload
    numberMessages(messages, timeline); // sort, number and link frames to messages
    for (const e of timeline) { delete e.msgRef; delete e.pendingRef; } // internal links are no longer needed
    return { messages, timeline, events }; // result
  }

  /**
   * Sorts messages by their first source line, numbers them from 1 and fills timeline msgNo.
   * @param {object[]} messages messages (modified in place)
   * @param {object[]} timeline timeline rows (modified in place)
   */
  function numberMessages(messages, timeline) {
    messages.sort((a, b) => (a.line || 0) - (b.line || 0)); // log order of the first frame
    messages.forEach((m, k) => { // assign numbers and link frames
      m.no = k + 1; // 1-based message number
      for (const fi of m.frameIdx || []) if (timeline[fi]) timeline[fi].msgNo = m.no; // frames that formed the message
    });
  }

  /**
   * Pads one segmented frame as the options require.
   * @param {number[]} fr frame bytes
   * @param {boolean} fd CAN FD
   * @param {number|null} pad padding byte or null
   * @returns {number[]} padded frame
   */
  function padFrame(fr, fd, pad) {
    if (fr.length <= 8) { // classic-size frame
      if (pad !== null) while (fr.length < 8) fr.push(pad); // pad to 8 only when padding is requested
      return fr; // lengths 0..8 are always legal
    }
    const size = DLC_SIZES.find((n) => n >= fr.length); // next legal CAN FD size
    const fill = pad === null ? 0xCC : pad; // FD needs padding even when none was requested
    while (fr.length < size) fr.push(fill); // pad up to the legal size
    return fr; // padded frame
  }

  /**
   * Normalises segmentation options.
   * @param {object} opts {fd, canDl, pad, extAddr}
   * @returns {{fd: boolean, canDl: number, pad: number|null, pre: number[]}} cleaned options
   */
  function segOpts(opts) {
    const o = opts || {}; // optional
    const fd = !!o.fd; // CAN FD?
    const canDl = fd && [8, 12, 16, 20, 24, 32, 48, 64].includes(Number(o.canDl)) ? Number(o.canDl) : (fd ? 64 : 8); // classic CAN is always 8
    const pad = o.pad === null || o.pad === undefined || o.pad === false ? null : (Number(o.pad) & 0xFF); // padding byte or none
    const ea = o.extAddr === null || o.extAddr === undefined || o.extAddr === false ? null : (o.extAddr === true ? 0 : Number(o.extAddr) & 0xFF); // address byte
    return { fd, canDl, pad, pre: ea === null ? [] : [ea] }; // the prefix is empty with normal addressing
  }

  /**
   * Splits a payload into ISO-TP frames (byte arrays).
   * @param {number[]} payload message bytes
   * @param {{fd?: boolean, canDl?: number, pad?: number|null, extAddr?: number|null}} [opts] framing options
   * @returns {number[][]} frames; empty for an empty payload
   */
  function segment(payload, opts) {
    const p = toBytes(payload); // sanitise
    const { fd, canDl, pad, pre } = segOpts(opts); // options
    const a = pre.length; // address byte count (0 or 1)
    if (!p.length) return []; // ISO-TP cannot carry an empty message
    if (p.length <= 7 - a) return [padFrame([...pre, p.length, ...p], fd, pad)]; // SF with a 4-bit length
    if (fd && p.length <= canDl - a - 2) return [padFrame([...pre, 0x00, p.length, ...p], fd, pad)]; // SF with the escape length
    const frames = []; // output
    const hdr = p.length <= 4095 // FF PCI bytes
      ? [0x10 | (p.length >> 8), p.length & 0xFF] // 12-bit FF_DL
      : [0x10, 0x00, (p.length >>> 24) & 0xFF, (p.length >>> 16) & 0xFF, (p.length >>> 8) & 0xFF, p.length & 0xFF]; // escaped 32-bit FF_DL
    const first = canDl - a - hdr.length; // payload bytes in the FF (the FF always fills the frame)
    frames.push([...pre, ...hdr, ...p.slice(0, first)]); // First Frame
    let pos = first; // next payload byte
    let sn = 1; // CF sequence number starts at 1
    const per = canDl - a - 1; // payload bytes per CF
    while (pos < p.length) { // remaining payload
      frames.push(padFrame([...pre, 0x20 | sn, ...p.slice(pos, pos + per)], fd, pad)); // CF (only the last one can be short)
      pos += per; // advance
      sn = (sn + 1) & 0x0F; // wrap 15 → 0
    }
    return frames; // FF + CFs
  }

  /**
   * Builds a Flow Control frame.
   * @param {{fd?: boolean, pad?: number|null, extAddr?: number|null}} opts framing options
   * @param {number} fs flow status (0 CTS, 1 Wait, 2 Overflow)
   * @param {number} bs block size
   * @param {number} stMin STmin byte
   * @returns {number[]} frame bytes
   */
  function flowControl(opts, fs, bs, stMin) {
    const { fd, pad, pre } = segOpts(opts); // options
    return padFrame([...pre, 0x30 | (fs & 0x0F), bs & 0xFF, stMin & 0xFF], fd, pad); // FS, BS, STmin
  }

  /**
   * Renders a frame as a candump -L line.
   * @param {{t?: number, time?: number, iface?: string, id: number, ext?: boolean, data: number[], fd?: boolean, brs?: boolean}} fr frame
   * @param {string} [iface] interface name override
   * @returns {string} e.g. "(0.000000) can0 7E0#0322F190AAAAAAAA"
   */
  function formatCandump(fr, iface) {
    const t = typeof fr.t === 'number' ? fr.t : (typeof fr.time === 'number' ? fr.time : 0); // seconds
    const name = iface || fr.iface || 'can0'; // interface name
    const data = toBytes(fr.data).map(hex2).join(''); // contiguous hex
    const sep = fr.fd ? '##' + (fr.brs ? '1' : '0') : '#'; // FD form carries a flags nibble (bit 0 = BRS)
    return '(' + t.toFixed(6) + ') ' + name + ' ' + hexId(fr.id, !!fr.ext) + sep + data; // one log line
  }

  // ---------------------------------------------------------------------------------------------------------------
  // UDS tables (spec section 6) — names follow ISO 14229-1
  // ---------------------------------------------------------------------------------------------------------------

  /** Services: request SID → name and whether the first parameter byte is a sub-function. */
  const UDS_SERVICES = {
    0x10: { name: 'DiagnosticSessionControl', sub: true },
    0x11: { name: 'ECUReset', sub: true },
    0x14: { name: 'ClearDiagnosticInformation', sub: false },
    0x19: { name: 'ReadDTCInformation', sub: true },
    0x22: { name: 'ReadDataByIdentifier', sub: false },
    0x23: { name: 'ReadMemoryByAddress', sub: false },
    0x24: { name: 'ReadScalingDataByIdentifier', sub: false },
    0x27: { name: 'SecurityAccess', sub: true },
    0x28: { name: 'CommunicationControl', sub: true },
    0x29: { name: 'Authentication', sub: true },
    0x2A: { name: 'ReadDataByPeriodicIdentifier', sub: false },
    0x2C: { name: 'DynamicallyDefineDataIdentifier', sub: true },
    0x2E: { name: 'WriteDataByIdentifier', sub: false },
    0x2F: { name: 'InputOutputControlByIdentifier', sub: false },
    0x31: { name: 'RoutineControl', sub: true },
    0x34: { name: 'RequestDownload', sub: false },
    0x35: { name: 'RequestUpload', sub: false },
    0x36: { name: 'TransferData', sub: false },
    0x37: { name: 'RequestTransferExit', sub: false },
    0x38: { name: 'RequestFileTransfer', sub: false },
    0x3D: { name: 'WriteMemoryByAddress', sub: false },
    0x3E: { name: 'TesterPresent', sub: true },
    0x83: { name: 'AccessTimingParameter', sub: true },
    0x84: { name: 'SecuredDataTransmission', sub: false },
    0x85: { name: 'ControlDTCSetting', sub: true },
    0x86: { name: 'ResponseOnEvent', sub: true },
    0x87: { name: 'LinkControl', sub: true },
  };

  /** Sub-function names per service (value without the suppress bit). */
  const SUBFUNCTIONS = {
    0x10: { 0x01: 'defaultSession', 0x02: 'programmingSession', 0x03: 'extendedDiagnosticSession', 0x04: 'safetySystemDiagnosticSession' },
    0x11: { 0x01: 'hardReset', 0x02: 'keyOffOnReset', 0x03: 'softReset', 0x04: 'enableRapidPowerShutDown', 0x05: 'disableRapidPowerShutDown' },
    0x19: {
      0x01: 'reportNumberOfDTCByStatusMask', 0x02: 'reportDTCByStatusMask', 0x03: 'reportDTCSnapshotIdentification',
      0x04: 'reportDTCSnapshotRecordByDTCNumber', 0x05: 'reportDTCStoredDataByRecordNumber', 0x06: 'reportDTCExtDataRecordByDTCNumber',
      0x07: 'reportNumberOfDTCBySeverityMaskRecord', 0x08: 'reportDTCBySeverityMaskRecord', 0x09: 'reportSeverityInformationOfDTC',
      0x0A: 'reportSupportedDTC', 0x0B: 'reportFirstTestFailedDTC', 0x0C: 'reportFirstConfirmedDTC',
      0x0D: 'reportMostRecentTestFailedDTC', 0x0E: 'reportMostRecentConfirmedDTC', 0x14: 'reportDTCFaultDetectionCounter',
      0x15: 'reportDTCWithPermanentStatus', 0x16: 'reportDTCExtDataRecordByRecordNumber', // VERIFY: 0x16 name and edition
      0x17: 'reportUserDefMemoryDTCByStatusMask', 0x18: 'reportUserDefMemoryDTCSnapshotRecordByDTCNumber', // VERIFY: 0x17-0x19 names
      0x19: 'reportUserDefMemoryDTCExtDataRecordByDTCNumber', 0x1A: 'reportSupportedDTCExtDataRecord', // VERIFY: 0x1A added in the 2020 edition
      0x42: 'reportWWHOBDDTCByMaskRecord', 0x55: 'reportWWHOBDDTCWithPermanentStatus', // VERIFY: WWH-OBD sub-functions
      0x56: 'reportDTCInformationByDTCReadinessGroupIdentifier', // VERIFY: added in the 2020 edition
    },
    0x28: {
      0x00: 'enableRxAndTx', 0x01: 'enableRxAndDisableTx', 0x02: 'disableRxAndEnableTx', 0x03: 'disableRxAndTx',
      0x04: 'enableRxAndDisableTxWithEnhancedAddressInformation', 0x05: 'enableRxAndTxWithEnhancedAddressInformation',
    },
    0x29: { // VERIFY: Authentication sub-function names (2020 edition)
      0x00: 'deAuthenticate', 0x01: 'verifyCertificateUnidirectional', 0x02: 'verifyCertificateBidirectional',
      0x03: 'proofOfOwnership', 0x04: 'transmitCertificate', 0x05: 'requestChallengeForAuthentication',
      0x06: 'verifyProofOfOwnershipUnidirectional', 0x07: 'verifyProofOfOwnershipBidirectional', 0x08: 'authenticationConfiguration',
    },
    0x2C: { 0x01: 'defineByIdentifier', 0x02: 'defineByMemoryAddress', 0x03: 'clearDynamicallyDefinedDataIdentifier' },
    0x31: { 0x01: 'startRoutine', 0x02: 'stopRoutine', 0x03: 'requestRoutineResults' },
    0x3E: { 0x00: 'zeroSubFunction' },
    0x83: {
      0x01: 'readExtendedTimingParameterSet', 0x02: 'setTimingParametersToDefaultValues',
      0x03: 'readCurrentlyActiveTimingParameters', 0x04: 'setTimingParametersToGivenValues',
    },
    0x85: { 0x01: 'DTC setting on', 0x02: 'DTC setting off' },
    0x86: { // VERIFY: ResponseOnEvent event types differ between the 2013 and 2020 editions
      0x00: 'stopResponseOnEvent', 0x01: 'onDTCStatusChange', 0x03: 'onChangeOfDataIdentifier', 0x04: 'reportActivatedEvents',
      0x05: 'startResponseOnEvent', 0x06: 'clearResponseOnEvent', 0x07: 'onComparisonOfValues',
    },
    0x87: { 0x01: 'verifyModeTransitionWithFixedParameter', 0x02: 'verifyModeTransitionWithSpecificParameter', 0x03: 'transitionMode' },
  };

  /** Negative response codes with names from ISO 14229-1 (ranges are handled in nrcName). */
  const NRC_NAMES = {
    0x00: 'positiveResponse', 0x10: 'generalReject', 0x11: 'serviceNotSupported', 0x12: 'subFunctionNotSupported',
    0x13: 'incorrectMessageLengthOrInvalidFormat', 0x14: 'responseTooLong', 0x21: 'busyRepeatRequest',
    0x22: 'conditionsNotCorrect', 0x24: 'requestSequenceError', 0x25: 'noResponseFromSubnetComponent',
    0x26: 'failurePreventsExecutionOfRequestedAction', 0x31: 'requestOutOfRange', 0x33: 'securityAccessDenied',
    0x34: 'authenticationRequired', // VERIFY: added in the 2020 edition
    0x35: 'invalidKey', 0x36: 'exceededNumberOfAttempts', 0x37: 'requiredTimeDelayNotExpired',
    0x50: 'certificateVerificationFailedInvalidTimePeriod', 0x51: 'certificateVerificationFailedInvalidSignature', // VERIFY: 0x50-0x5D (2020 edition)
    0x52: 'certificateVerificationFailedInvalidChainOfTrust', 0x53: 'certificateVerificationFailedInvalidType',
    0x54: 'certificateVerificationFailedInvalidFormat', 0x55: 'certificateVerificationFailedInvalidContent',
    0x56: 'certificateVerificationFailedInvalidScope', 0x57: 'certificateVerificationFailedInvalidCertificateRevoked',
    0x58: 'ownershipVerificationFailed', 0x59: 'challengeCalculationFailed', 0x5A: 'settingAccessRightsFailed',
    0x5B: 'sessionKeyCreationDerivationFailed', 0x5C: 'configurationDataUsageFailed', 0x5D: 'deAuthenticationFailed',
    0x70: 'uploadDownloadNotAccepted', 0x71: 'transferDataSuspended', 0x72: 'generalProgrammingFailure',
    0x73: 'wrongBlockSequenceCounter', 0x78: 'requestCorrectlyReceivedResponsePending',
    0x7E: 'subFunctionNotSupportedInActiveSession', 0x7F: 'serviceNotSupportedInActiveSession',
    0x81: 'rpmTooHigh', 0x82: 'rpmTooLow', 0x83: 'engineIsRunning', 0x84: 'engineIsNotRunning', 0x85: 'engineRunTimeTooLow',
    0x86: 'temperatureTooHigh', 0x87: 'temperatureTooLow', 0x88: 'vehicleSpeedTooHigh', 0x89: 'vehicleSpeedTooLow',
    0x8A: 'throttlePedalTooHigh', 0x8B: 'throttlePedalTooLow', 0x8C: 'transmissionRangeNotInNeutral',
    0x8D: 'transmissionRangeNotInGear', 0x8F: 'brakeSwitchesNotClosed', 0x90: 'shifterLeverNotInPark',
    0x91: 'torqueConverterClutchLocked', 0x92: 'voltageTooHigh', 0x93: 'voltageTooLow',
    0x94: 'resourceTemporarilyNotAvailable', // VERIFY: 2020 edition; older editions reserve 0x94
  };

  /** Short advice for the most common NRCs, shown as a note. */
  const NRC_HINTS = {
    0x11: 'The ECU does not implement this service.',
    0x12: 'The ECU does not support this sub-function.',
    0x13: 'The request length or format is wrong; check the parameter bytes.',
    0x22: 'A precondition is not met (for example engine state or voltage).',
    0x24: 'Requests arrived in the wrong order (for example sendKey without requestSeed).',
    0x31: 'A parameter is out of range or the identifier is not supported.',
    0x33: 'Unlock with SecurityAccess (0x27) first.',
    0x35: 'The key does not match the seed; request a new seed.',
    0x36: 'Too many wrong keys; the ECU is now locked out for a delay time.',
    0x37: 'Wait for the lockout delay to expire before requesting a seed.',
    0x72: 'Erasing or programming memory failed.',
    0x73: 'The TransferData block counter is not the expected value.',
    0x7E: 'Switch to a session that supports this sub-function first.',
    0x7F: 'Switch to a session that supports this service (0x10) first.',
  };

  /**
   * Returns the name of a negative response code, covering the reserved ranges.
   * @param {number} c NRC byte
   * @returns {string} name
   */
  function nrcName(c) {
    if (NRC_NAMES[c]) return NRC_NAMES[c]; // named code
    if (c >= 0x38 && c <= 0x4F) return 'reservedByExtendedDataLinkSecurityDocument'; // range from the standard
    if (c >= 0x95 && c <= 0xEF) return 'reservedForSpecificConditionsNotCorrect'; // VERIFY: 0x95..0xEF range boundaries
    if (c >= 0xF0 && c <= 0xFE) return 'vehicleManufacturerSpecificConditionsNotCorrect'; // VERIFY: 0xF0..0xFE in the 2020 edition
    return 'ISOSAEReserved'; // everything else is reserved
  }

  const DTC_STATUS_BITS = [ // status-of-DTC bits 0..7
    'testFailed', 'testFailedThisOperationCycle', 'pendingDTC', 'confirmedDTC',
    'testNotCompletedSinceLastClear', 'testFailedSinceLastClear', 'testNotCompletedThisOperationCycle', 'warningIndicatorRequested',
  ];

  const DTC_FORMATS = { // DTCFormatIdentifier values
    0x00: 'SAE J2012-DA DTC format 00 (ISO 15031-6)', 0x01: 'ISO 14229-1 DTC format', 0x02: 'SAE J1939-73 DTC format',
    0x03: 'ISO 11992-4 DTC format', 0x04: 'SAE J2012-DA DTC format 04', // VERIFY: 0x04 name
  };

  /** Standardised data identifiers F180..F19F (ISO 14229-1 Annex C). */
  const DID_NAMES = {
    0xF180: 'bootSoftwareIdentification', 0xF181: 'applicationSoftwareIdentification', 0xF182: 'applicationDataIdentification',
    0xF183: 'bootSoftwareFingerprint', 0xF184: 'applicationSoftwareFingerprint', 0xF185: 'applicationDataFingerprint',
    0xF186: 'activeDiagnosticSession', 0xF187: 'vehicleManufacturerSparePartNumber', 0xF188: 'vehicleManufacturerECUSoftwareNumber',
    0xF189: 'vehicleManufacturerECUSoftwareVersionNumber', 0xF18A: 'systemSupplierIdentifier', 0xF18B: 'ECUManufacturingDate',
    0xF18C: 'ECUSerialNumber', 0xF18D: 'supportedFunctionalUnits', 0xF18E: 'vehicleManufacturerKitAssemblyPartNumber',
    0xF18F: 'ISOSAEReservedStandardized', // VERIFY: F18F name differs between editions
    0xF190: 'VIN', 0xF191: 'vehicleManufacturerECUHardwareNumber', 0xF192: 'systemSupplierECUHardwareNumber',
    0xF193: 'systemSupplierECUHardwareVersionNumber', 0xF194: 'systemSupplierECUSoftwareNumber',
    0xF195: 'systemSupplierECUSoftwareVersionNumber', 0xF196: 'exhaustRegulationOrTypeApprovalNumber',
    0xF197: 'systemNameOrEngineType', 0xF198: 'repairShopCodeOrTesterSerialNumber', 0xF199: 'programmingDate',
    0xF19A: 'calibrationRepairShopCodeOrCalibrationEquipmentSerialNumber', 0xF19B: 'calibrationDate',
    0xF19C: 'calibrationEquipmentSoftwareNumber', 0xF19D: 'ECUInstallationDate', 0xF19E: 'ODXFile', 0xF19F: 'entity',
  };

  const TEXT_DIDS = [0xF180, 0xF181, 0xF182, 0xF187, 0xF188, 0xF189, 0xF18A, 0xF18C, 0xF18E, 0xF190, 0xF191, 0xF192, 0xF193, 0xF194, 0xF195, 0xF196, 0xF197, 0xF198]; // DIDs usually holding ASCII

  /**
   * Returns a name for a data identifier.
   * @param {number} did 16-bit DID
   * @returns {string} name or range description
   */
  function didName(did) {
    if (DID_NAMES[did]) return DID_NAMES[did]; // standardised identifier
    if (did >= 0xF200 && did <= 0xF2FF) return 'periodicDataIdentifier'; // range for 0x2A
    if (did >= 0xF300 && did <= 0xF3FF) return 'dynamicallyDefinedDataIdentifier'; // range for 0x2C
    if (did >= 0xF400 && did <= 0xF8FF) return 'OBD / emissions-related data identifier'; // VERIFY: OBD DID range split F4..F8
    if (did >= 0xFF00 && did <= 0xFFFF) return did === 0xFF00 ? 'UDSVersionDataIdentifier' : 'ISO/SAE reserved'; // VERIFY: FF00 name
    return 'manufacturer/supplier specific'; // everything else has no public meaning
  }

  /**
   * Returns a name for a routine identifier.
   * @param {number} rid 16-bit routine ID
   * @returns {string} name or range description
   */
  function ridName(rid) {
    if (rid === 0xFF00) return 'eraseMemory'; // standardised routine
    if (rid === 0xFF01) return 'checkProgrammingDependencies'; // standardised routine
    if (rid === 0xFF02) return 'eraseMirrorMemoryDTCs'; // standardised routine
    if (rid === 0xE200) return 'deployLoopRoutineID'; // standardised routine
    if (rid >= 0x0200 && rid <= 0xDFFF) return 'vehicle-manufacturer specific'; // range from the standard
    if (rid >= 0xE000 && rid <= 0xE1FF) return 'OBD test identifier'; // VERIFY: OBD test ID range
    if (rid >= 0xF000 && rid <= 0xFEFF) return 'system-supplier specific'; // VERIFY: supplier range
    return 'reserved'; // other values
  }

  /**
   * Formats a DTC in SAE J2012 style.
   * @param {number[]} b 2 bytes (OBD) or 3 bytes (UDS, third byte = failure type)
   * @returns {string} e.g. "P0133" or "P0133-00"
   */
  function dtcText(b) {
    const x = toBytes(b); // sanitise
    if (x.length < 2) return '?'; // not enough bytes for a code
    const letter = 'PCBU'[x[0] >> 6]; // bits 7..6 select the system letter
    const code = letter + ((x[0] >> 4) & 0x03) + (x[0] & 0x0F).toString(16).toUpperCase() + hex2(x[1]); // letter, digit 0..3, hex digit, byte
    return x.length >= 3 ? code + '-' + hex2(x[2]) : code; // UDS adds the failure-type byte
  }

  /**
   * Lists the names of the bits set in a DTC status byte.
   * @param {number} s status byte
   * @returns {string} e.g. "0x09: testFailed, confirmedDTC"
   */
  function dtcStatusText(s) {
    const names = DTC_STATUS_BITS.filter((_, i) => (s >> i) & 1); // bits that are set
    return '0x' + hex2(s) + ': ' + (names.length ? names.join(', ') : 'no bits set'); // value and meaning
  }

  // ---------------------------------------------------------------------------------------------------------------
  // OBD-II tables (spec section 7)
  // ---------------------------------------------------------------------------------------------------------------

  const OBD_MODES = { // service ID → name
    0x01: 'ShowCurrentData', 0x02: 'ShowFreezeFrameData', 0x03: 'ShowStoredDTCs', 0x04: 'ClearDiagnosticInformation',
    0x05: 'OxygenSensorMonitoring', 0x06: 'OnBoardMonitoringTestResults', 0x07: 'ShowPendingDTCs',
    0x08: 'ControlOnBoardSystem', 0x09: 'RequestVehicleInformation', 0x0A: 'ShowPermanentDTCs',
  };

  /** PIDs: data length, name, formula text, and a function producing the value text. */
  const OBD_PIDS = {
    0x00: { len: 4, name: 'pidsSupported01to20', formula: 'bit mask, bit 31 = PID 01' },
    0x04: { len: 1, name: 'calculatedEngineLoad', formula: 'A·100/255 %', fn: (b) => num(b[0] * 100 / 255, 1) + ' %' },
    0x05: { len: 1, name: 'engineCoolantTemperature', formula: 'A−40 °C', fn: (b) => (b[0] - 40) + ' °C' },
    0x0C: { len: 2, name: 'engineSpeed', formula: '(256A+B)/4 rpm', fn: (b) => num((b[0] * 256 + b[1]) / 4, 2) + ' rpm' },
    0x0D: { len: 1, name: 'vehicleSpeed', formula: 'A km/h', fn: (b) => b[0] + ' km/h' },
    0x0F: { len: 1, name: 'intakeAirTemperature', formula: 'A−40 °C', fn: (b) => (b[0] - 40) + ' °C' },
    0x10: { len: 2, name: 'mafAirFlowRate', formula: '(256A+B)/100 g/s', fn: (b) => num((b[0] * 256 + b[1]) / 100, 2) + ' g/s' },
    0x11: { len: 1, name: 'throttlePosition', formula: 'A·100/255 %', fn: (b) => num(b[0] * 100 / 255, 1) + ' %' },
    0x1F: { len: 2, name: 'runTimeSinceEngineStart', formula: '256A+B s', fn: (b) => (b[0] * 256 + b[1]) + ' s' },
    0x20: { len: 4, name: 'pidsSupported21to40', formula: 'bit mask, bit 31 = PID 21' },
    0x2F: { len: 1, name: 'fuelTankLevelInput', formula: 'A·100/255 %', fn: (b) => num(b[0] * 100 / 255, 1) + ' %' },
    0x40: { len: 4, name: 'pidsSupported41to60', formula: 'bit mask, bit 31 = PID 41' },
    0x42: { len: 2, name: 'controlModuleVoltage', formula: '(256A+B)/1000 V', fn: (b) => num((b[0] * 256 + b[1]) / 1000, 3) + ' V' },
    0x46: { len: 1, name: 'ambientAirTemperature', formula: 'A−40 °C', fn: (b) => (b[0] - 40) + ' °C' },
    0x5C: { len: 1, name: 'engineOilTemperature', formula: 'A−40 °C', fn: (b) => (b[0] - 40) + ' °C' },
    0x60: { len: 4, name: 'pidsSupported61to80', formula: 'bit mask, bit 31 = PID 61' },
  };

  const OBD_INFOTYPES = { 0x00: 'supportedInfoTypes', 0x02: 'VIN', 0x04: 'calibrationId', 0x06: 'calibrationVerificationNumber', 0x0A: 'ecuName' }; // Mode 09 info types

  // ---------------------------------------------------------------------------------------------------------------
  // Field cursor used by every decoder
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Creates a cursor that walks a payload and records one field per byte group.
   * Fields always cover every byte exactly once, in order.
   * @param {number[]} p payload
   * @param {object} res decode result receiving fields and notes
   * @returns {object} cursor API
   */
  function cursor(p, res) {
    let pos = 0; // next unread byte
    let truncated = false; // set after the first missing field
    const api = { // cursor methods
      /** @returns {number} bytes left */
      left: () => p.length - pos,
      /** @returns {number} current position */
      pos: () => pos,
      /** @returns {number|undefined} the byte at an offset from the cursor, without consuming it */
      peek: (k) => p[pos + (k || 0)],
      /**
       * Consumes n bytes as one field.
       * @param {number} n byte count
       * @param {string} role field role
       * @param {string} label field label
       * @param {function} [textFn] bytes → meaning
       * @returns {number[]|null} the bytes, or null when the payload is too short
       */
      take(n, role, label, textFn) {
        const have = p.length - pos; // bytes available
        if (have < n) { // truncated message
          if (!truncated) { // report only the first missing field
            res.notes.push({ level: 'error', text: 'Truncated message: ' + label + ' needs ' + plural(n, 'byte') + (have ? ', only ' + have + ' present' : '') }); // spec wording
            truncated = true; // later fields are not reported again
          }
          if (have > 0) res.fields.push({ role, label: label + ' (truncated)', bytes: p.slice(pos), offset: pos, text: 'incomplete' }); // keep coverage of the remaining bytes
          pos = p.length; // nothing left
          return null; // caller stops decoding
        }
        const b = p.slice(pos, pos + n); // field bytes
        let text = hexBytes(b); // default meaning is the hex itself
        if (textFn) { try { text = textFn(b); } catch (e) { text = hexBytes(b); } } // a meaning function must not break decoding
        res.fields.push({ role, label, bytes: b, offset: pos, text }); // record the field
        pos += n; // advance
        return b; // bytes for the caller
      },
      /**
       * Consumes all remaining bytes as one field (nothing when empty).
       * @param {string} role field role
       * @param {string} label field label
       * @param {function} [textFn] bytes → meaning
       * @returns {number[]} the bytes (possibly empty)
       */
      rest(role, label, textFn) {
        if (pos >= p.length) return []; // nothing left
        return api.take(p.length - pos, role, label, textFn); // one field with everything
      },
      /** @returns {boolean} true once a field was missing */
      truncated: () => truncated,
    };
    return api; // cursor
  }

  /**
   * Formats a sub-function byte for a field text.
   * @param {number} sid request service ID
   * @param {number} b sub-function byte as sent
   * @param {boolean} isReq true for requests (bit 7 is the suppress bit only there)
   * @returns {string} meaning
   */
  function subText(sid, b, isReq) {
    const v = b & 0x7F; // value without the suppress bit
    const name = subName(sid, v); // known name or a description
    const spr = isReq ? ', suppressPosRspMsg = ' + (b >> 7) + (b & 0x80 ? ' (no positive response wanted)' : '') : ''; // bit 7 meaning in requests
    return name + ' (0x' + hex2(v) + ')' + spr; // text for the field
  }

  /**
   * Returns the name of a sub-function value.
   * @param {number} sid request service ID
   * @param {number} v value without the suppress bit
   * @returns {string} name
   */
  function subName(sid, v) {
    if (sid === 0x27) return securityName(v); // SecurityAccess names depend on odd/even values
    const t = SUBFUNCTIONS[sid]; // table for this service
    if (t && t[v]) return t[v]; // known value
    if (sid === 0x10 && v >= 0x40 && v <= 0x5F) return 'vehicleManufacturerSpecific session'; // VERIFY: session ranges
    if (sid === 0x10 && v >= 0x60 && v <= 0x7E) return 'systemSupplierSpecific session'; // VERIFY: session ranges
    return 'subFunction 0x' + hex2(v); // unknown value
  }

  /**
   * Names a SecurityAccess sub-function.
   * @param {number} v value without the suppress bit
   * @returns {string} e.g. "requestSeed (level 1)"
   */
  function securityName(v) {
    if (v >= 0x01 && v <= 0x41 && v % 2 === 1) return 'requestSeed (level ' + (v + 1) / 2 + ')'; // odd values request a seed
    if (v >= 0x02 && v <= 0x42 && v % 2 === 0) return 'sendKey (level ' + v / 2 + ')'; // even values send a key
    if (v === 0x5F || v === 0x60) return 'ISO 26021-2 value'; // VERIFY: 0x5F/0x60 reserved for ISO 26021-2
    if (v >= 0x61 && v <= 0x7E) return 'systemSupplierSpecific'; // VERIFY: supplier range
    return 'reserved'; // 0x00, 0x43..0x5E, 0x7F
  }

  /**
   * Names an address-and-length format identifier and returns the widths.
   * @param {number} b ALFID byte
   * @returns {{addr: number, size: number, text: string}} widths in bytes and a description
   */
  function alfid(b) {
    const addr = b & 0x0F, size = b >> 4; // low nibble = address bytes, high nibble = size bytes
    return { addr, size, text: '0x' + hex2(b) + ': ' + addr + '-byte address, ' + size + '-byte size' }; // widths and text
  }

  /**
   * Decodes ALFID, address and size fields (used by 0x23, 0x34, 0x35, 0x3D).
   * @param {object} c cursor
   * @param {object} res decode result
   * @returns {{address: number, size: number}|null} values, or null when malformed
   */
  function addrAndSize(c, res) {
    const f = c.take(1, 'meta', 'addressAndLengthFormatIdentifier', (b) => alfid(b[0]).text); // format byte
    if (!f) return null; // truncated
    const w = alfid(f[0]); // widths
    if (!w.addr || !w.size) { // zero widths make the rest unreadable
      res.notes.push({ level: 'error', text: 'addressAndLengthFormatIdentifier 0x' + hex2(f[0]) + ' has a zero width' }); // explain
      return null; // caller shows the rest raw
    }
    const a = c.take(w.addr, 'id', 'memoryAddress', (b) => '0x' + hexN(beNum(b), b.length * 2)); // address
    if (!a) return null; // truncated
    const s = c.take(w.size, 'id', 'memorySize', (b) => plural(beNum(b), 'byte')); // size
    if (!s) return null; // truncated
    return { address: beNum(a), size: beNum(s) }; // values
  }

  /**
   * Describes a DID value for a field text.
   * @param {number} did data identifier
   * @param {number[]} b data bytes
   * @returns {string} meaning
   */
  function didValueText(did, b) {
    if (did === 0xF186 && b.length === 1) return '0x' + hex2(b[0]) + ' · ' + subName(0x10, b[0]); // session byte
    const text = asText(b); // printable ASCII?
    if (TEXT_DIDS.includes(did) && text) return text; // text identifiers show as text
    return hexBytes(b) + (text && b.length >= 3 ? ' · ASCII ' + text : ''); // otherwise hex, with text when it looks like text
  }

  /**
   * Reads the DID list of a 0x22 request.
   * @param {number[]} req request payload
   * @returns {number[]} DIDs
   */
  function requestDids(req) {
    const out = []; // DIDs
    for (let i = 1; i + 1 < req.length; i += 2) out.push(req[i] * 256 + req[i + 1]); // pairs after the SID
    return out; // list
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Service decoders: each receives (c, ctx) and pushes summary parts to ctx.parts
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Decodes a sub-function byte and adds its name to the summary.
   * @param {object} c cursor
   * @param {object} ctx decode context
   * @param {string} [label] field label
   * @returns {number|null} sub-function value without the suppress bit
   */
  function takeSub(c, ctx, label) {
    const b = c.take(1, 'sub', label || 'subFunction', (x) => subText(ctx.sid, x[0], ctx.isReq)); // sub-function field
    if (!b) return null; // truncated
    ctx.parts.push(subName(ctx.sid, b[0] & 0x7F)); // summary detail
    return b[0] & 0x7F; // value for the caller
  }

  /** Decoders per service: req(c, ctx) for requests, rsp(c, ctx) for positive responses. */
  const DECODERS = {
    0x10: {
      req: (c, ctx) => { takeSub(c, ctx, 'diagnosticSessionType'); }, // session only
      rsp: (c, ctx) => { // session + timing
        if (takeSub(c, ctx, 'diagnosticSessionType') === null) return; // truncated
        if (!c.left()) return; // timing record is optional in very old ECUs
        const p2 = c.take(2, 'data', 'P2Server_max', (b) => beNum(b) + ' ms'); // milliseconds
        if (p2) ctx.parts.push('P2 ' + beNum(p2) + ' ms'); // summary
        const p2s = c.take(2, 'data', 'P2*Server_max', (b) => beNum(b) * 10 + ' ms (' + beNum(b) + ' × 10 ms)'); // 10 ms units
        if (p2s) ctx.parts.push('P2* ' + beNum(p2s) * 10 + ' ms'); // summary
      },
    },
    0x11: {
      req: (c, ctx) => { takeSub(c, ctx, 'resetType'); }, // reset type only
      rsp: (c, ctx) => { // reset type, plus power-down time for type 4
        const t = takeSub(c, ctx, 'resetType'); // reset type
        if (t === 0x04 && c.left()) c.take(1, 'data', 'powerDownTime', (b) => (b[0] === 0xFF ? 'not available' : b[0] + ' s')); // seconds
      },
    },
    0x14: {
      req: (c, ctx) => { // group of DTC (+ optional memory selection)
        const g = c.take(3, 'id', 'groupOfDTC', (b) => (beNum(b) === 0xFFFFFF ? 'FFFFFF = all DTCs' : dtcText(b))); // group
        if (g) ctx.parts.push(beNum(g) === 0xFFFFFF ? 'all DTCs' : 'group ' + hexBytes(g)); // summary
        c.rest('meta', 'memorySelection'); // optional extra byte
      },
      rsp: () => {}, // no parameters
    },
    0x19: {
      req: (c, ctx) => { // report type and its parameters
        const s = takeSub(c, ctx, 'reportType'); // sub-function
        if (s === null) return; // truncated
        if (s === 0x01 || s === 0x02 || s === 0x0F || s === 0x11 || s === 0x12 || s === 0x13) c.take(1, 'meta', 'DTCStatusMask', (b) => dtcStatusText(b[0])); // mask
        else if (s === 0x04 || s === 0x06) { // DTC + record number
          c.take(3, 'id', 'DTCMaskRecord', (b) => dtcText(b)); // the DTC
          c.take(1, 'meta', s === 0x04 ? 'DTCSnapshotRecordNumber' : 'DTCExtDataRecordNumber'); // record selector
        } else if (![0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x14, 0x15].includes(s)) ctx.raw = true; // other report types: raw
      },
      rsp: (c, ctx) => { // report type and records
        const s = takeSub(c, ctx, 'reportType'); // sub-function echo
        if (s === null) return; // truncated
        if (s === 0x01 || s === 0x07 || s === 0x11 || s === 0x12) { // count responses
          c.take(1, 'meta', 'DTCStatusAvailabilityMask', (b) => dtcStatusText(b[0])); // mask
          c.take(1, 'meta', 'DTCFormatIdentifier', (b) => DTC_FORMATS[b[0]] || 'unknown format 0x' + hex2(b[0])); // format
          const n = c.take(2, 'data', 'DTCCount', (b) => String(beNum(b))); // count
          if (n) ctx.parts.push(plural(beNum(n), 'DTC')); // summary
        } else if ([0x02, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x13, 0x15].includes(s)) { // mask + DTC/status records
          if (!c.take(1, 'meta', 'DTCStatusAvailabilityMask', (b) => dtcStatusText(b[0]))) return; // mask
          let k = 0; // record counter
          while (c.left() >= 4) { // full records
            k++; // next record
            c.take(3, 'id', 'DTC ' + k, (b) => dtcText(b)); // DTC
            c.take(1, 'meta', 'statusOfDTC ' + k, (b) => dtcStatusText(b[0])); // status
          }
          if (c.left()) { // incomplete record at the end
            ctx.notes.push({ level: 'error', text: 'Truncated message: last DTC record has ' + plural(c.left(), 'byte') + ' of 4' }); // explain
            c.rest('data', 'incomplete DTC record'); // keep coverage
          }
          ctx.parts.push(plural(k, 'DTC')); // summary
        } else if (s === 0x04 || s === 0x06) { // DTC + status, then records whose layout is ECU-specific
          c.take(3, 'id', 'DTC', (b) => dtcText(b)); // DTC
          c.take(1, 'meta', 'statusOfDTC', (b) => dtcStatusText(b[0])); // status
          c.rest('data', s === 0x04 ? 'snapshot records' : 'extended data records'); // raw records
        } else ctx.raw = true; // other report types: raw
      },
    },
    0x22: {
      req: (c, ctx) => { // list of DIDs
        const dids = []; // for the summary
        while (c.left() >= 2) { // pairs
          const b = c.take(2, 'id', 'dataIdentifier', (x) => hexN(beNum(x), 4) + ' ' + didName(beNum(x))); // DID
          dids.push(hexN(beNum(b), 4)); // keep for the summary
        }
        if (c.left()) { ctx.notes.push({ level: 'error', text: 'Truncated message: dataIdentifier needs 2 bytes, only 1 present' }); c.rest('id', 'dataIdentifier (truncated)'); } // odd byte
        if (!dids.length && !c.left()) ctx.notes.push({ level: 'error', text: 'Truncated message: dataIdentifier needs 2 bytes' }); // no DID at all
        ctx.parts.push(dids.length > 4 ? dids.slice(0, 4).join(', ') + ' +' + (dids.length - 4) : dids.join(', ')); // summary
      },
      rsp: (c, ctx, p) => { // DID + data records
        const req = ctx.request && ctx.request[0] === 0x22 ? requestDids(ctx.request) : null; // DIDs the tester asked for
        const shown = []; // summary items
        let k = 0; // index into req of the last matched DID
        while (c.left() > 0) { // one record per loop
          const start = c.pos(); // position of this record's DID
          const db = c.take(2, 'id', 'dataIdentifier', (x) => hexN(beNum(x), 4) + ' ' + didName(beNum(x))); // DID
          if (!db) break; // truncated
          const did = beNum(db); // DID value
          let len = c.left(); // data length; default is "everything left"
          if (req) { // split using the request's DID list
            const at = req.indexOf(did, k); // where this DID sits in the request
            if (at < 0) { ctx.notes.push({ level: 'warn', text: 'DID ' + hexN(did, 4) + ' was not in the request; the rest is shown as its data' }); } // unexpected
            else { // look for the next requested DID after at least one data byte
              k = at + 1; // later DIDs only
              let best = -1; // earliest position of any later requested DID
              for (const nd of req.slice(k)) { // candidate next DIDs
                for (let j = start + 3; j + 1 < p.length; j++) { // scan the bytes after this DID
                  if (p[j] === (nd >> 8) && p[j + 1] === (nd & 0xFF)) { if (best < 0 || j < best) best = j; break; } // first match of this DID
                }
              }
              if (best > 0) len = best - c.pos(); // data ends where the next DID starts
            }
          }
          const data = c.take(len, 'data', hexN(did, 4) + ' data', (x) => didValueText(did, x)); // data record
          const txt = data ? asText(data) : null; // short text for the summary
          shown.push(hexN(did, 4) + (txt && TEXT_DIDS.includes(did) && txt.length <= 42 ? ' ' + txt : '')); // summary item
          if (!req) break; // without the request only the first DID can be separated
        }
        if (!req) ctx.notes.push({ level: 'info', text: 'Decoded without its request: UDS carries no data lengths, so everything after the first DID is shown as its data.' }); // honesty
        if (req && req.length > 1) ctx.notes.push({ level: 'info', text: 'Records were split by searching for the requested DIDs; UDS carries no data lengths, so a DID value inside the data could split it wrongly.' }); // heuristic note
        ctx.parts.push(shown.join(', ')); // summary
      },
    },
    0x23: {
      req: (c, ctx) => { const v = addrAndSize(c, ctx.res); if (v) ctx.parts.push('0x' + hexN(v.address, 8) + ', ' + plural(v.size, 'byte')); }, // what to read
      rsp: (c, ctx) => { const d = c.rest('data', 'dataRecord', (b) => plural(b.length, 'byte')); ctx.parts.push(plural(d.length, 'byte')); }, // memory content
    },
    0x27: {
      req: (c, ctx) => { // seed request or key
        const s = takeSub(c, ctx, 'securityAccessType'); // level
        if (s === null) return; // truncated
        if (s % 2 === 0 && s > 0 && s <= 0x42) { // sendKey
          if (!c.left()) ctx.notes.push({ level: 'warn', text: 'sendKey without key bytes' }); // a key is expected
          c.rest('data', 'securityKey'); // key bytes
        } else c.rest('data', 'securityAccessDataRecord'); // optional data with a seed request
      },
      rsp: (c, ctx) => { // seed (odd) or nothing (even)
        const s = takeSub(c, ctx, 'securityAccessType'); // level
        if (s === null) return; // truncated
        if (s % 2 === 1) { // requestSeed response
          c.rest('data', 'securitySeed', (b) => (b.every((x) => x === 0) ? hexBytes(b) + ' · all zero: security level already unlocked' : hexBytes(b))); // seed
        } else c.rest('data', 'unexpected data'); // sendKey responses carry no data
      },
    },
    0x28: {
      req: (c, ctx) => { // control type, communication type, optional node id
        const s = takeSub(c, ctx, 'controlType'); // control type
        if (s === null) return; // truncated
        const ct = c.take(1, 'meta', 'communicationType', (b) => commTypeText(b[0])); // message class + subnet
        if (ct) ctx.parts.push(commClass(ct[0])); // summary
        if (s === 0x04 || s === 0x05) c.take(2, 'id', 'nodeIdentificationNumber'); // node id for enhanced address variants
      },
      rsp: (c, ctx) => { takeSub(c, ctx, 'controlType'); }, // echo only
    },
    0x2E: {
      req: (c, ctx) => { // DID + data
        const d = c.take(2, 'id', 'dataIdentifier', (x) => hexN(beNum(x), 4) + ' ' + didName(beNum(x))); // DID
        if (!d) return; // truncated
        ctx.parts.push(hexN(beNum(d), 4)); // summary
        if (!c.left()) ctx.notes.push({ level: 'error', text: 'Truncated message: dataRecord needs at least 1 byte' }); // nothing to write
        c.rest('data', 'dataRecord', (b) => didValueText(beNum(d), b)); // data to write
      },
      rsp: (c, ctx) => { const d = c.take(2, 'id', 'dataIdentifier', (x) => hexN(beNum(x), 4) + ' ' + didName(beNum(x))); if (d) ctx.parts.push(hexN(beNum(d), 4)); }, // echo
    },
    0x2F: {
      req: (c, ctx) => { // DID, control parameter, state/mask
        const d = c.take(2, 'id', 'dataIdentifier', (x) => hexN(beNum(x), 4) + ' ' + didName(beNum(x))); // DID
        if (!d) return; // truncated
        const p = c.take(1, 'meta', 'inputOutputControlParameter', (b) => iocpText(b[0])); // control parameter
        ctx.parts.push(hexN(beNum(d), 4) + (p ? ' ' + iocpText(p[0]) : '')); // summary
        c.rest('data', 'controlState / controlMask'); // state and mask bytes
      },
      rsp: (c, ctx) => { // DID, echo of the parameter, status
        const d = c.take(2, 'id', 'dataIdentifier', (x) => hexN(beNum(x), 4) + ' ' + didName(beNum(x))); // DID
        if (!d) return; // truncated
        const p = c.left() ? c.take(1, 'meta', 'inputOutputControlParameter', (b) => iocpText(b[0])) : null; // control parameter echo
        ctx.parts.push(hexN(beNum(d), 4) + (p ? ' ' + iocpText(p[0]) : '')); // summary
        c.rest('data', 'controlStatusRecord'); // current state
      },
    },
    0x31: {
      req: (c, ctx) => routine(c, ctx, 'routineControlOptionRecord'), // sub + RID + options
      rsp: (c, ctx) => routine(c, ctx, 'routineStatusRecord'), // sub + RID + status
    },
    0x34: { req: (c, ctx) => requestTransfer(c, ctx), rsp: (c, ctx) => transferResponse(c, ctx) }, // RequestDownload
    0x35: { req: (c, ctx) => requestTransfer(c, ctx), rsp: (c, ctx) => transferResponse(c, ctx) }, // RequestUpload
    0x36: {
      req: (c, ctx) => { // counter + data
        const n = c.take(1, 'meta', 'blockSequenceCounter', (b) => String(b[0])); // counter
        if (!n) return; // truncated
        const d = c.rest('data', 'transferRequestParameterRecord', (b) => plural(b.length, 'byte')); // data
        ctx.parts.push('block ' + n[0] + ', ' + plural(d.length, 'data byte')); // summary
      },
      rsp: (c, ctx) => { // counter (+ optional record)
        const n = c.take(1, 'meta', 'blockSequenceCounter', (b) => String(b[0])); // counter
        if (n) ctx.parts.push('block ' + n[0]); // summary
        c.rest('data', 'transferResponseParameterRecord'); // optional data
      },
    },
    0x37: {
      req: (c) => { c.rest('data', 'transferRequestParameterRecord'); }, // optional record
      rsp: (c) => { c.rest('data', 'transferResponseParameterRecord'); }, // optional record
    },
    0x3D: {
      req: (c, ctx) => { // address, size, data
        const v = addrAndSize(c, ctx.res); // where to write
        if (v) ctx.parts.push('0x' + hexN(v.address, 8) + ', ' + plural(v.size, 'byte')); // summary
        if (v) c.rest('data', 'dataRecord', (b) => plural(b.length, 'byte')); // data
      },
      rsp: (c, ctx) => { const v = addrAndSize(c, ctx.res); if (v) ctx.parts.push('0x' + hexN(v.address, 8) + ', ' + plural(v.size, 'byte')); }, // echo
    },
    0x3E: {
      req: (c, ctx) => { takeSub(c, ctx, 'zeroSubFunction'); }, // 0x00 or 0x80
      rsp: (c, ctx) => { takeSub(c, ctx, 'zeroSubFunction'); }, // echo
    },
    0x83: {
      req: (c, ctx) => { if (takeSub(c, ctx, 'timingParameterAccessType') !== null) c.rest('data', 'timingParameterRequestRecord'); }, // raw record
      rsp: (c, ctx) => { if (takeSub(c, ctx, 'timingParameterAccessType') !== null) c.rest('data', 'timingParameterResponseRecord'); }, // raw record
    },
    0x85: {
      req: (c, ctx) => { if (takeSub(c, ctx, 'DTCSettingType') !== null) c.rest('data', 'DTCSettingControlOptionRecord'); }, // on/off + option
      rsp: (c, ctx) => { takeSub(c, ctx, 'DTCSettingType'); }, // echo
    },
  };

  /**
   * Describes a CommunicationControl communication-type byte.
   * @param {number} b communication type
   * @returns {string} message class and subnet
   */
  function commTypeText(b) {
    const subnet = b >> 4; // high nibble selects the network
    const where = subnet === 0 ? 'all networks' : subnet === 0xF ? 'the network this request was received on' : 'subnet ' + subnet; // VERIFY: subnet 0 and F meanings
    return '0x' + hex2(b) + ': ' + commClass(b) + ', ' + where; // full text
  }

  /**
   * Names the message class in the low two bits of a communication type.
   * @param {number} b communication type
   * @returns {string} class name
   */
  function commClass(b) {
    return ['reserved message class 0', 'normalCommunicationMessages', 'networkManagementCommunicationMessages', 'networkManagement and normal messages'][b & 0x03]; // low two bits
  }

  /**
   * Names an InputOutputControlParameter.
   * @param {number} b parameter byte
   * @returns {string} name
   */
  function iocpText(b) {
    return ['returnControlToECU', 'resetToDefault', 'freezeCurrentState', 'shortTermAdjustment'][b] || 'parameter 0x' + hex2(b); // 0..3 are defined
  }

  /**
   * Decodes RoutineControl request and response bodies.
   * @param {object} c cursor
   * @param {object} ctx context
   * @param {string} restLabel label for the trailing record
   */
  function routine(c, ctx, restLabel) {
    const s = c.take(1, 'sub', 'routineControlType', (x) => subText(0x31, x[0], ctx.isReq)); // sub-function
    if (!s) return; // truncated
    const r = c.take(2, 'id', 'routineIdentifier', (x) => hexN(beNum(x), 4) + ' ' + ridName(beNum(x))); // routine ID
    ctx.parts.push(subName(0x31, s[0] & 0x7F) + (r ? ' ' + hexN(beNum(r), 4) + ' ' + ridName(beNum(r)) : '')); // summary
    if (r) c.rest('data', restLabel); // option or status record
  }

  /**
   * Decodes a RequestDownload / RequestUpload request.
   * @param {object} c cursor
   * @param {object} ctx context
   */
  function requestTransfer(c, ctx) {
    c.take(1, 'meta', 'dataFormatIdentifier', (b) => { // compression and encryption nibbles
      const comp = b[0] >> 4, enc = b[0] & 0x0F; // high nibble = compression method, low = encryption method
      return '0x' + hex2(b[0]) + ': ' + (comp ? 'compression method ' + comp : 'no compression') + ', ' + (enc ? 'encryption method ' + enc : 'no encryption'); // text
    });
    const v = addrAndSize(c, ctx.res); // address and size
    if (v) ctx.parts.push('0x' + hexN(v.address, 8) + ', ' + plural(v.size, 'byte')); // summary
  }

  /**
   * Decodes a RequestDownload / RequestUpload positive response.
   * @param {object} c cursor
   * @param {object} ctx context
   */
  function transferResponse(c, ctx) {
    const f = c.take(1, 'meta', 'lengthFormatIdentifier', (b) => '0x' + hex2(b[0]) + ': ' + (b[0] >> 4) + '-byte length'); // high nibble = width
    if (!f) return; // truncated
    const w = f[0] >> 4; // width of maxNumberOfBlockLength
    if (!w) { ctx.notes.push({ level: 'error', text: 'lengthFormatIdentifier has a zero width' }); return; } // malformed
    const m = c.take(w, 'data', 'maxNumberOfBlockLength', (b) => plural(beNum(b), 'byte') + ' → ' + plural(Math.max(0, beNum(b) - 2), 'data byte') + ' per TransferData'); // includes SID and counter
    if (m) ctx.parts.push('max block ' + plural(beNum(m), 'byte') + ' → ' + plural(Math.max(0, beNum(m) - 2), 'data byte')); // summary
  }

  // ---------------------------------------------------------------------------------------------------------------
  // OBD-II decoding (spec section 7)
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Decodes a supported-PID bit mask.
   * @param {number} base PID that the mask was requested with (0x00, 0x20, ...)
   * @param {number[]} b four mask bytes
   * @returns {string} list of supported PIDs
   */
  function supportedPids(base, b) {
    const list = []; // supported PIDs
    for (let i = 0; i < 32; i++) if ((b[i >> 3] >> (7 - (i & 7))) & 1) list.push(hex2(base + i + 1)); // bit 31 (MSB of byte A) = base + 1
    return 'PIDs supported: ' + (list.length ? list.join(' ') : 'none'); // text
  }

  /**
   * Decodes the PID data blocks of a Mode 01/02 response.
   * @param {object} c cursor
   * @param {object} ctx context
   * @param {boolean} freeze true for Mode 02 (frame number after each PID)
   */
  function obdPidBlocks(c, ctx, freeze) {
    while (c.left() > 0) { // one PID per loop
      const pb = c.take(1, 'id', 'PID', (x) => hex2(x[0]) + ' ' + (OBD_PIDS[x[0]] ? OBD_PIDS[x[0]].name : 'unknown PID')); // PID
      const pid = pb[0]; // PID value
      if (freeze && !c.take(1, 'meta', 'frameNumber', (x) => String(x[0]))) return; // Mode 02 frame number
      const def = OBD_PIDS[pid]; // known PID?
      if (!def) { c.rest('data', 'PID ' + hex2(pid) + ' data'); ctx.parts.push('PID ' + hex2(pid)); return; } // unknown: rest raw
      const d = c.take(def.len, 'data', def.name, (x) => ((pid & 0x1F) === 0 ? supportedPids(pid, x) : def.fn(x))); // value
      if (!d) return; // truncated
      ctx.parts.push((pid & 0x1F) === 0 ? def.name : def.name + ' ' + def.fn(d)); // summary
    }
  }

  /**
   * Decodes an OBD-II request or positive response.
   * @param {number[]} p payload
   * @param {object} res decode result
   * @param {object} ctx context
   * @param {object} c cursor (already past the SID byte)
   */
  function decodeObd(p, res, ctx, c) {
    const mode = ctx.sid; // request mode 0x01..0x0A
    if (ctx.isReq) { // requests
      if (mode === 0x01 || mode === 0x02) { // PID list (Mode 02 with a frame number per PID)
        while (c.left() > 0) { // PIDs
          const pb = c.take(1, 'id', 'PID', (x) => hex2(x[0]) + ' ' + (OBD_PIDS[x[0]] ? OBD_PIDS[x[0]].name : 'unknown PID')); // PID
          ctx.parts.push('PID ' + hex2(pb[0]) + (OBD_PIDS[pb[0]] ? ' ' + OBD_PIDS[pb[0]].name : '')); // summary
          if (mode === 0x02) c.take(1, 'meta', 'frameNumber', (x) => String(x[0])); // freeze frame number
        }
      } else if (mode === 0x09) { // info type
        const t = c.take(1, 'id', 'infoType', (x) => hex2(x[0]) + ' ' + (OBD_INFOTYPES[x[0]] || 'info type')); // info type
        if (t) ctx.parts.push(OBD_INFOTYPES[t[0]] || 'info type ' + hex2(t[0])); // summary
      }
      c.rest('data', 'parameters'); // anything else stays raw
      return; // done with requests
    }
    if (mode === 0x01 || mode === 0x02) obdPidBlocks(c, ctx, mode === 0x02); // PID data
    else if (mode === 0x03 || mode === 0x07 || mode === 0x0A) { // DTC lists
      const n = c.take(1, 'meta', 'numberOfDTCs', (x) => String(x[0])); // count byte
      const codes = []; // decoded DTCs
      let k = 0; // DTC counter
      while (c.left() >= 2) { k++; const d = c.take(2, 'id', 'DTC ' + k, dtcText); codes.push(dtcText(d)); } // two bytes per DTC
      c.rest('data', 'unexpected trailing byte'); // odd byte at the end
      if (n && n[0] !== codes.length) res.notes.push({ level: 'warn', text: 'Count byte says ' + n[0] + ' DTCs but ' + codes.length + ' are present' }); // mismatch
      ctx.parts.push(plural(codes.length, 'DTC') + (codes.length ? ': ' + codes.slice(0, 6).join(', ') + (codes.length > 6 ? ', …' : '') : '')); // summary
    } else if (mode === 0x09) { // vehicle information
      const t = c.take(1, 'id', 'infoType', (x) => hex2(x[0]) + ' ' + (OBD_INFOTYPES[x[0]] || 'info type')); // info type
      if (!t) return; // truncated
      if (t[0] !== 0x00) c.take(1, 'meta', 'numberOfDataItems', (x) => String(x[0])); // item count (not sent for the supported mask)
      const d = c.rest('data', OBD_INFOTYPES[t[0]] || 'data', (x) => (t[0] === 0x00 ? supportedPids(0, x).replace('PIDs', 'Info types') : asText(x) || hexBytes(x))); // data
      ctx.parts.push((OBD_INFOTYPES[t[0]] || 'info type ' + hex2(t[0])) + (t[0] === 0x02 && asText(d) ? ' ' + asText(d) : '')); // summary
    } else c.rest('data', 'data'); // Modes 04, 05, 06, 08: raw
  }

  // ---------------------------------------------------------------------------------------------------------------
  // UDS decoding entry point
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Returns the display name of a request SID (UDS or OBD-II).
   * @param {number} sid request service ID
   * @returns {string} name
   */
  function serviceName(sid) {
    if (UDS_SERVICES[sid]) return UDS_SERVICES[sid].name; // UDS service
    if (OBD_MODES[sid]) return 'OBD-II Mode ' + hex2(sid) + ' ' + OBD_MODES[sid]; // OBD-II mode
    return 'Service 0x' + hex2(sid); // unknown
  }

  /**
   * Decodes one UDS or OBD-II message. Never throws.
   * @param {number[]} payload message bytes
   * @param {{dir?: string, request?: number[]}} [opts] direction hint and the paired request (for 0x22 splitting)
   * @returns {object} {kind, sid, name, detail, summary, fields, notes, level, pending}
   */
  function decodeUds(payload, opts) {
    const o = opts || {}; // optional settings
    const p = toBytes(payload); // sanitise
    const res = { kind: 'request', sid: null, name: '', detail: '', summary: '', fields: [], notes: [], level: 'ok', pending: false }; // result
    if (!p.length) { // nothing to decode
      res.kind = o.dir === 'rsp' ? 'positive' : 'request'; // best guess
      res.summary = 'empty message'; // spec wording
      res.notes.push({ level: 'error', text: 'The message has no bytes.' }); // explain
      res.level = 'error'; // worst level
      return res; // done
    }
    const c = cursor(p, res); // field cursor
    const ctx = { sid: 0, isReq: true, parts: [], notes: res.notes, res, request: toBytes(o.request), raw: false }; // decoder context
    try {
      const b0 = p[0]; // first byte decides the message kind
      const isKnownReq = !!(UDS_SERVICES[b0] || OBD_MODES[b0]); // a request SID we know
      const isKnownRsp = !!(UDS_SERVICES[b0 - 0x40] || OBD_MODES[b0 - 0x40]); // a positive response SID we know
      if (b0 === 0x7F) { // negative response
        res.kind = 'negative'; // kind
        c.take(1, 'sid', 'negativeResponseSID', () => '0x7F negative response'); // marker byte
        const s = c.take(1, 'sid', 'requestSID', (x) => '0x' + hex2(x[0]) + ' ' + serviceName(x[0])); // rejected service
        res.sid = s ? s[0] : null; // the service that was rejected
        res.name = s ? serviceName(s[0]) : 'Negative response'; // its name
        const n = s ? c.take(1, 'nrc', 'negativeResponseCode', (x) => nrcName(x[0]) + ' (0x' + hex2(x[0]) + ')') : null; // NRC
        if (n) { // complete negative response
          const code = n[0]; // NRC value
          ctx.parts.push(nrcName(code) + ' (0x' + hex2(code) + ')'); // summary detail
          if (code === 0x78) { // response pending is not a failure
            res.pending = true; // the request stays open
            res.notes.push({ level: 'info', text: 'Response pending: the ECU needs more time; the final response follows.' }); // explain
          } else res.notes.push({ level: 'warn', text: 'Negative response: ' + nrcName(code) + '.' + (NRC_HINTS[code] ? ' ' + NRC_HINTS[code] : '') }); // explain
        }
        if (c.left()) { res.notes.push({ level: 'warn', text: 'Negative response longer than 3 bytes' }); c.rest('data', 'unexpected extra bytes'); } // keep coverage
      } else if (isKnownReq || (!isKnownRsp && o.dir !== 'rsp') || (o.dir === 'rsp' && b0 < 0x40)) { // a request
        res.kind = 'request'; // kind
        ctx.sid = b0; ctx.isReq = true; // context
        res.sid = b0; res.name = serviceName(b0); // service
        c.take(1, 'sid', 'serviceId', () => '0x' + hex2(b0) + ' ' + res.name + ' request'); // SID field
        decodeBody(p, res, ctx, c, 'req'); // parameters
      } else { // a positive response
        res.kind = 'positive'; // kind
        ctx.sid = b0 - 0x40; ctx.isReq = false; // context: the request SID
        res.sid = ctx.sid; res.name = serviceName(ctx.sid); // service
        c.take(1, 'sid', 'responseServiceId', () => '0x' + hex2(b0) + ' positive response to ' + res.name); // SID field
        decodeBody(p, res, ctx, c, 'rsp'); // parameters
      }
    } catch (e) { // safety net: a decoder bug must not break the page
      res.notes.push({ level: 'error', text: 'Decoder error: ' + (e && e.message ? e.message : String(e)) }); // report it
    }
    c.rest('data', 'undecoded bytes'); // anything left over stays visible as raw data
    res.detail = ctx.parts.filter(Boolean).join(' · '); // detail text
    const prefix = res.kind === 'positive' ? '+ ' : res.kind === 'negative' ? '− ' : ''; // + or − marks the response kind
    res.summary = prefix + res.name + (res.detail ? ' · ' + res.detail : ''); // one-line summary
    res.level = res.notes.reduce((lv, n) => worse(lv, n.level), 'ok'); // worst note
    return res; // decoded message
  }

  /**
   * Decodes the parameters after the SID of a request or positive response.
   * @param {number[]} p payload
   * @param {object} res decode result
   * @param {object} ctx context
   * @param {object} c cursor
   * @param {'req'|'rsp'} which request or response decoder
   */
  function decodeBody(p, res, ctx, c, which) {
    const sid = ctx.sid; // request SID
    if (OBD_MODES[sid]) { // OBD-II
      res.notes.push({ level: 'info', text: 'OBD-II (SAE J1979 / ISO 15031-5) message, not UDS.' }); // spec requirement
      decodeObd(p, res, ctx, c); // OBD decoder
      return; // done
    }
    const dec = DECODERS[sid]; // UDS decoder for this service
    if (dec) { // fully decoded service
      dec[which](c, ctx, p); // run it
      if (ctx.raw) { c.rest('data', 'parameters'); res.notes.push({ level: 'info', text: 'Field decoding not implemented for this sub-function; bytes shown raw.' }); } // partially decoded
      return; // done
    }
    if (UDS_SERVICES[sid]) { // known service without a detailed decoder
      if (UDS_SERVICES[sid].sub && c.left()) takeSub(c, ctx); // sub-function name where the service has one
      c.rest('data', 'parameters'); // the rest raw
      res.notes.push({ level: 'info', text: 'Field decoding not implemented for ' + UDS_SERVICES[sid].name + '; bytes shown raw.' }); // honesty
      return; // done
    }
    res.notes.push({ level: 'warn', text: 'Unknown service 0x' + hex2(sid) + (which === 'rsp' ? ' (response 0x' + hex2(sid + 0x40) + ')' : '') + ': not defined in ISO 14229-1 or SAE J1979.' }); // unknown
    c.rest('data', 'parameters'); // raw bytes
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Pairing and whole-log decoding
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Decodes every message and pairs responses with requests (spec section 6, "Pairing").
   * Adds msg.uds, msg.reqNo, msg.rspNos and msg.latencyMs.
   * @param {object[]} messages messages in log order
   * @returns {object[]} the same array
   */
  function annotate(messages) {
    const list = Array.isArray(messages) ? messages : []; // tolerate bad input
    const open = []; // unanswered requests, oldest first
    for (const m of list) { // log order
      m.reqNo = null; m.rspNos = []; m.latencyMs = null; // reset pairing fields
      const p = toBytes(m.payload); // bytes
      const dir = m.dir || inferDir(p); // direction for decoding
      const isRsp = p.length > 0 && (p[0] === 0x7F || inferDir(p) === 'rsp') && dir === 'rsp'; // response by ID and by content
      let req = null; // paired request
      if (isRsp) { // find the request this answers
        const sid = p[0] === 0x7F ? p[1] : p[0] - 0x40; // request SID
        for (let k = open.length - 1; k >= 0; k--) { // most recent first
          if (toBytes(open[k].payload)[0] === sid) { req = open[k]; break; } // SID matches
        }
      }
      m.uds = decodeUds(p, { dir, request: req ? req.payload : null }); // decode with the request for 0x22 splitting
      if (req) { // pair them
        m.reqNo = req.no; req.rspNos.push(m.no); // cross references
        if (typeof m.time === 'number' && typeof req.endTime === 'number') m.latencyMs = (m.time - req.endTime) * 1000; // response first frame − request last frame
        if (!m.uds.pending) open.splice(open.indexOf(req), 1); // 0x78 keeps the request open
      }
      if (m.uds.kind === 'request' && !m.partial && p.length) open.push(m); // complete requests wait for an answer
    }
    return list; // annotated
  }

  /**
   * Parses, reassembles, decodes and pairs a whole log. Never throws.
   * @param {string} text log text
   * @param {{addressing?: string, reqIds?: number[], rspIds?: number[]}} [cfg] options
   * @returns {object} {frames, raws, ignored, messages, timeline, events, stats}
   */
  function decodeAll(text, cfg) {
    const c = cfg || {}; // optional settings
    const parsed = parseLog(text); // frames, raw payloads, ignored lines
    const r = reassemble(parsed.frames, c); // ISO-TP
    for (const raw of parsed.raws) { // ready-made payloads become messages directly
      r.messages.push({ no: 0, id: null, ext: false, addr: null, dir: inferDir(raw.data), time: null, endTime: null, frameIdx: [], kind: 'RAW', payload: raw.data, partial: false, error: null, level: 'ok', line: raw.line, total: raw.data.length, fd: false, dirHint: null }); // RAW message
    }
    numberMessages(r.messages, r.timeline); // renumber with the raw messages included
    annotate(r.messages); // decode and pair
    const decodeErrors = r.messages.filter((m) => m.uds.level === 'error').length; // malformed UDS content
    return { // everything the UI needs
      frames: parsed.frames, raws: parsed.raws, ignored: parsed.ignored, messages: r.messages, timeline: r.timeline, events: r.events, // data
      stats: { frames: parsed.frames.length, messages: r.messages.length, problems: r.events.filter((e) => e.level !== 'info').length + decodeErrors, ignored: parsed.ignored.length }, // summary line
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------------------------------------------

  const EGUDS = { // the one global
    version: '0.1.0', // matches package.json
    parseLog, classifyId, inferDir, reassemble, segment, flowControl, formatCandump, // spec sections 3-5
    stminText, stminMs, encodeStmin, decodeUds, annotate, decodeAll, // spec sections 5-6
    dtcText, dtcStatusText, didName, ridName, nrcName, serviceName, subName, // naming helpers
    hex2, hexBytes, hexId, parseHexBytes, parseIdList, // formatting and input helpers
    tables: { UDS_SERVICES, SUBFUNCTIONS, NRC_NAMES, DTC_STATUS_BITS, DTC_FORMATS, DID_NAMES, OBD_MODES, OBD_PIDS, OBD_INFOTYPES, DLC_SIZES, FC_STATUS }, // for the Reference tab
  };

  root.EGUDS = EGUDS; // browser global
  if (typeof module !== 'undefined' && module.exports) module.exports = EGUDS; // Node / tests
})(typeof globalThis !== 'undefined' ? globalThis : this); // the global object in any environment
