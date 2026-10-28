/*
 * UDS Bench interface by Embedded Garage.
 * All DOM code lives here. User-derived text only ever reaches the page through textContent or DOM nodes.
 */
(function () { // keep every helper private
  'use strict'; // catch accidental globals and silent errors

  const E = window.EGUDS; // decoder
  const S = window.EGSIM; // simulator
  const $ = (id) => document.getElementById(id); // short element lookup

  // ---------------------------------------------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Creates an element with properties and children. Strings become text nodes, never HTML.
   * @param {string} tag element name
   * @param {object} [props] class, text, on<event> handlers or attributes
   * @param {Array|Node|string} [children] child nodes or strings
   * @returns {HTMLElement} the element
   */
  function el(tag, props, children) {
    const n = document.createElement(tag); // new element
    if (props) { // apply properties
      for (const k of Object.keys(props)) { // each property
        const v = props[k]; // its value
        if (v === null || v === undefined || v === false) continue; // skip empty values
        if (k === 'class') n.className = v; // CSS classes
        else if (k === 'text') n.textContent = v; // safe text
        else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); // event handler
        else n.setAttribute(k, v === true ? '' : String(v)); // plain attribute
      }
    }
    for (const c of [].concat(children === undefined ? [] : children)) { // children
      if (c === null || c === undefined || c === false) continue; // skip empty children
      n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c); // text or node
    }
    return n; // the element
  }

  /**
   * Removes all children of an element.
   * @param {HTMLElement} n element
   */
  function clear(n) {
    while (n.firstChild) n.removeChild(n.firstChild); // safe and fast for our sizes
  }

  /**
   * Returns "1 frame" / "2 frames".
   * @param {number} n count
   * @param {string} w singular word
   * @returns {string} count and word
   */
  function plural(n, w) {
    return n + ' ' + w + (n === 1 ? '' : 's'); // simple English plural
  }

  /**
   * Builds a level badge (text, so meaning never depends on colour alone).
   * @param {string} level ok, info, warn or error
   * @param {string} [text] badge text
   * @returns {HTMLElement} badge
   */
  function badge(level, text) {
    return el('span', { class: 'lv lv-' + level, text: text || (level === 'warn' ? 'warning' : level) }); // coloured outline + word
  }

  /**
   * Returns the more severe of two levels.
   * @param {string} a level
   * @param {string} b level
   * @returns {string} worse level
   */
  function worse(a, b) {
    const order = { ok: 0, info: 1, warn: 2, error: 3 }; // severity order
    return (order[b] || 0) > (order[a] || 0) ? b : a; // pick the higher
  }

  /**
   * Builds byte spans for a frame with the PCI bytes highlighted.
   * @param {number[]} data frame bytes
   * @param {number} pciLen number of leading address/PCI bytes
   * @returns {HTMLElement} span with the bytes
   */
  function frameBytes(data, pciLen) {
    const head = data.slice(0, pciLen).map(E.hex2).join(' '); // PCI part
    const tail = data.slice(pciLen).map(E.hex2).join(' '); // payload and padding
    return el('span', null, [head ? el('span', { class: 'pci', title: 'address / PCI bytes', text: head }) : null, head && tail ? ' ' : '', tail]); // combined
  }

  /**
   * Formats seconds for display.
   * @param {number|null} t time in seconds
   * @returns {string} e.g. "0.003500" or "—"
   */
  function fmtTime(t) {
    return typeof t === 'number' ? t.toFixed(6) : '—'; // six decimals like candump
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Clipboard
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Copies text, falling back to selecting it when the clipboard API is unavailable or refused.
   * @param {string} text text to copy
   * @param {HTMLElement} btn button to give feedback on
   * @param {HTMLElement} [selectEl] element whose content is selected on fallback
   */
  function copyText(text, btn, selectEl) {
    const original = btn.dataset.label || btn.textContent; // label to restore
    btn.dataset.label = original; // remember across rapid clicks
    const feedback = (msg) => { btn.textContent = msg; setTimeout(() => { btn.textContent = original; }, 1600); }; // temporary label
    const fallback = () => { // select the text so the user can press Ctrl+C
      try {
        if (selectEl && (selectEl.tagName === 'TEXTAREA' || selectEl.tagName === 'INPUT')) { selectEl.focus(); selectEl.select(); } // form fields
        else if (selectEl) { const r = document.createRange(); r.selectNodeContents(selectEl); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } // other elements
      } catch (e) { /* selection is best effort */ } // nothing else to do
      feedback(selectEl ? 'Selected: press Ctrl+C' : 'Copy not available'); // tell the user
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => feedback('Copied'), fallback); // async clipboard, inside the click handler
      else fallback(); // older browsers or blocked contexts
    } catch (e) { fallback(); } // some iframes throw synchronously
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------------------------------------------------

  const THEMES = ['auto', 'dark', 'light']; // theme cycle

  /**
   * Reads a stored preference without failing when storage is blocked.
   * @param {string} key storage key
   * @returns {string|null} value
   */
  function load(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; } // storage may be disabled in iframes
  }

  /**
   * Stores a preference without failing when storage is blocked.
   * @param {string} key storage key
   * @param {string} value value
   */
  function save(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* preference is optional */ } // ignore blocked storage
  }

  /**
   * Applies a theme mode and updates the toggle label.
   * @param {string} mode auto, dark or light
   */
  function applyTheme(mode) {
    const m = THEMES.includes(mode) ? mode : 'auto'; // validate
    if (m === 'auto') document.documentElement.removeAttribute('data-theme'); // follow the OS
    else document.documentElement.setAttribute('data-theme', m); // forced theme
    $('theme-toggle').textContent = 'Theme: ' + m; // visible state
    $('theme-toggle').setAttribute('aria-label', 'Colour theme: ' + m + '. Activate to switch.'); // spoken state
  }

  /** Sets up the theme toggle. */
  function initTheme() {
    let mode = load('eguds-theme') || 'auto'; // stored choice
    applyTheme(mode); // apply it
    $('theme-toggle').addEventListener('click', () => { // cycle on click
      mode = THEMES[(THEMES.indexOf(mode) + 1) % THEMES.length]; // next mode
      applyTheme(mode); save('eguds-theme', mode); // apply and remember
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Tabs and hash routing
  // ---------------------------------------------------------------------------------------------------------------

  const TABS = ['decode', 'simulate', 'reference']; // tab names = hash values

  /**
   * Shows one tab panel and updates the ARIA state.
   * @param {string} name tab name
   * @param {boolean} [focusTab] move focus to the tab button
   */
  function showTab(name, focusTab) {
    const n = TABS.includes(name) ? name : 'decode'; // default tab
    for (const t of TABS) { // every tab
      const on = t === n; // selected?
      const tab = $('tab-' + t); // tab button
      tab.setAttribute('aria-selected', on ? 'true' : 'false'); // ARIA state
      tab.tabIndex = on ? 0 : -1; // roving tabindex: only the selected tab is in the tab order
      $('panel-' + t).hidden = !on; // show one panel
    }
    if (n === 'reference') buildReference(); // built on first view
    if (focusTab) $('tab-' + n).focus(); // keyboard navigation keeps focus on tabs
  }

  /**
   * Reads the tab name from the URL hash.
   * @returns {string} tab name
   */
  function hashTab() {
    const h = (location.hash || '').replace(/^#/, ''); // hash without "#"
    return TABS.includes(h) ? h : 'decode'; // default
  }

  /**
   * Navigates to a tab by updating the hash (which triggers showTab).
   * @param {string} name tab name
   * @param {boolean} [focusTab] focus the tab button afterwards
   */
  function goTab(name, focusTab) {
    if (location.hash !== '#' + name) { try { history.replaceState(null, '', '#' + name); } catch (e) { location.hash = name; } } // update the hash without adding history entries per tab switch
    showTab(name, focusTab); // show immediately
  }

  /** Sets up tab clicks, arrow keys and hash changes. */
  function initTabs() {
    for (const t of TABS) $('tab-' + t).addEventListener('click', () => goTab(t)); // click selects
    document.querySelector('[role="tablist"]').addEventListener('keydown', (ev) => { // arrow-key navigation
      const cur = TABS.indexOf(hashTab()); // current index
      let next = -1; // target index
      if (ev.key === 'ArrowRight') next = (cur + 1) % TABS.length; // next tab
      else if (ev.key === 'ArrowLeft') next = (cur + TABS.length - 1) % TABS.length; // previous tab
      else if (ev.key === 'Home') next = 0; // first tab
      else if (ev.key === 'End') next = TABS.length - 1; // last tab
      if (next < 0) return; // other keys keep their default
      ev.preventDefault(); // no page scrolling
      goTab(TABS[next], true); // activate and focus
    });
    window.addEventListener('hashchange', () => showTab(hashTab())); // back/forward and links
    showTab(hashTab()); // initial tab from the URL
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Decode tab
  // ---------------------------------------------------------------------------------------------------------------

  const ROLE_NAMES = { sid: 'service ID', sub: 'sub-function', id: 'identifier', meta: 'format / meta', data: 'data', nrc: 'NRC' }; // field role names
  const DIR_TEXT = { req: 'Tester → ECU', rsp: 'ECU → Tester' }; // direction chip text
  const CHUNK = 200; // rows rendered per animation step
  const TIMELINE_LIMIT = 1000; // timeline rows rendered before asking

  let examples = []; // example logs from the build
  let lastResult = null; // most recent decode result
  let renderToken = 0; // cancels stale chunked rendering
  let pendingRender = null; // finishes chunked rendering on demand
  let debounceTimer = 0; // live-decode timer

  /** Loads the examples embedded by the build script. */
  function loadExamples() {
    try { examples = JSON.parse($('eg-examples').textContent); } catch (e) { examples = []; } // build-time JSON
    if (!Array.isArray(examples)) examples = []; // defensive
    const sel = $('dec-example'); // picker
    sel.appendChild(el('option', { value: '', text: 'Choose an example…' })); // neutral entry
    for (const ex of examples) sel.appendChild(el('option', { value: ex.id, text: ex.label })); // one option each
    if (examples.length) { sel.value = examples[0].id; $('dec-input').value = examples[0].text; } // open in a realistic state
  }

  /**
   * Reads the decode settings and validates the ID lists.
   * @returns {object} decodeAll configuration
   */
  function decodeConfig() {
    const req = E.parseIdList($('dec-req-ids').value); // request IDs
    const rsp = E.parseIdList($('dec-rsp-ids').value); // response IDs
    const hint = $('dec-id-hint'); // hint line
    const bad = req.bad.concat(rsp.bad); // invalid tokens
    hint.classList.toggle('bad', bad.length > 0); // error styling
    hint.textContent = bad.length ? 'Not a hex CAN ID: ' + bad.join(', ') + '. Use hex like 7E0 or 18DAF110, separated by commas.' : 'Leave the ID lists empty to use 7DF / 7E0–7E7 → 7E8–7EF and 18DA / 18DB33F1.'; // explain
    return { addressing: $('dec-addressing').value, reqIds: req.ids, rspIds: rsp.ids }; // settings
  }

  /** Decodes the textarea and renders the result. */
  function decodeNow() {
    const t0 = performance.now(); // timing for the summary
    const res = E.decodeAll($('dec-input').value, decodeConfig()); // never throws
    res.ms = performance.now() - t0; // elapsed time
    lastResult = res; // keep for copy and navigation
    renderDecode(res); // update the page
  }

  /** Schedules a live decode 250 ms after the last change. */
  function decodeSoon() {
    clearTimeout(debounceTimer); // restart the delay
    debounceTimer = setTimeout(decodeNow, 250); // debounce
  }

  /**
   * True when a message has a problem worth showing with "Only problems".
   * @param {object} m message
   * @returns {boolean} problem or not
   */
  function isProblem(m) {
    const lv = worse(m.uds.level, m.level); // decode level and transport level
    return lv === 'warn' || lv === 'error' || m.partial; // warnings, errors and partial transfers
  }

  /**
   * Renders the summary, problems, messages and timeline.
   * @param {object} res decodeAll result
   */
  function renderDecode(res) {
    const st = res.stats; // counts
    $('dec-summary').textContent = [plural(st.frames, 'frame'), plural(st.messages, 'message'), plural(st.problems, 'problem'), plural(st.ignored, 'ignored line')].join(' · ') + ' · ' + res.ms.toFixed(0) + ' ms'; // summary line
    const ign = $('dec-ignored'); // ignored-lines box
    ign.hidden = res.ignored.length === 0; // only when there are any
    ign.querySelector('summary').textContent = 'Show ' + plural(res.ignored.length, 'ignored line'); // toggle text
    const il = $('dec-ignored-list'); clear(il); // list
    for (const g of res.ignored.slice(0, 500)) il.appendChild(el('li', { text: 'line ' + g.line + ': ' + g.reason + ' — ' + g.text })); // user text via textContent
    if (res.ignored.length > 500) il.appendChild(el('li', { text: '… and ' + (res.ignored.length - 500) + ' more' })); // cap the list
    const ev = $('dec-events'); clear(ev); // problem list
    for (const e of res.events.slice(0, 50)) ev.appendChild(el('li', { class: 'row-' + e.level }, [badge(e.level), ' frame ' + (e.index + 1) + ' · ' + e.text])); // one line per problem
    if (res.events.length > 50) ev.appendChild(el('li', { text: '… and ' + (res.events.length - 50) + ' more problems in the timeline' })); // cap
    const only = $('dec-problems').checked; // filter
    const msgs = only ? res.messages.filter(isProblem) : res.messages; // messages to show
    const rows = only ? res.timeline.filter((t) => t.level === 'warn' || t.level === 'error') : res.timeline; // frames to show
    const ml = $('dec-messages'); clear(ml); // message list
    const tb = $('dec-timeline').querySelector('tbody'); clear(tb); // timeline body
    const empty = $('dec-messages-empty'); // empty state
    empty.hidden = msgs.length > 0; // shown when nothing to list
    empty.textContent = !res.messages.length ? (st.frames ? 'No complete messages: see the timeline and problems above.' : 'Paste a log on the left, or pick an example.') : 'No problems found.'; // helpful text
    const token = ++renderToken; // this render's identity
    let mi = 0, ti = 0; // progress through messages and timeline rows
    const tlMax = Math.min(rows.length, TIMELINE_LIMIT); // timeline rows before asking
    const step = () => { // render one chunk of each list
      if (token !== renderToken) return false; // a newer decode started
      const mf = document.createDocumentFragment(); // batch DOM inserts
      for (const end = Math.min(msgs.length, mi + CHUNK); mi < end; mi++) mf.appendChild(messageRow(msgs[mi], res)); // messages
      ml.appendChild(mf); // insert
      const tf = document.createDocumentFragment(); // batch DOM inserts
      for (const end = Math.min(tlMax, ti + CHUNK); ti < end; ti++) tf.appendChild(timelineRow(rows[ti], res)); // frames
      tb.appendChild(tf); // insert
      return mi < msgs.length || ti < tlMax; // more to do?
    };
    const finish = () => { // after everything up to the limit is rendered
      if (rows.length > tlMax) { // offer the rest instead of freezing the page
        const btn = el('button', { type: 'button', class: 'btn btn-small more', text: 'Show all ' + plural(rows.length, 'frame') }); // load-more button
        const tr = el('tr', null, el('td', { colspan: '6' }, btn)); // full-width row
        btn.addEventListener('click', () => { tr.remove(); const f = document.createDocumentFragment(); for (let k = tlMax; k < rows.length; k++) f.appendChild(timelineRow(rows[k], res)); tb.appendChild(f); }); // render the rest
        tb.appendChild(tr); // add the button row
      }
      pendingRender = null; // nothing left to finish
    };
    pendingRender = () => { while (step()); finish(); }; // finish synchronously when a click needs a row now
    if (step()) { // more than one chunk
      const loop = () => { if (token !== renderToken) return; if (step()) requestAnimationFrame(loop); else finish(); }; // keep the page responsive
      requestAnimationFrame(loop); // continue on the next frame
    } else finish(); // all done in one chunk
  }

  /**
   * Builds one collapsed message row.
   * @param {object} m message
   * @param {object} res decode result
   * @returns {HTMLElement} list item
   */
  function messageRow(m, res) {
    const lv = worse(m.uds.level, m.level); // overall level
    const li = el('li', { class: 'msg' + (lv === 'warn' ? ' row-warn' : lv === 'error' ? ' row-error' : ''), id: 'msg-' + m.no }); // row
    const bodyId = 'msg-body-' + m.no; // detail element ID
    const head = el('button', { type: 'button', class: 'msg-head', 'aria-expanded': 'false', 'aria-controls': bodyId }); // toggle
    head.appendChild(el('span', { class: 'msg-no', text: '#' + m.no })); // number
    head.appendChild(el('span', { class: 'chip-dir ' + (m.dir || ''), text: DIR_TEXT[m.dir] || 'unknown' })); // direction as text
    head.appendChild(el('span', { class: 'msg-meta', text: m.kind === 'RAW' ? 'raw · line ' + m.line : E.hexId(m.id, m.ext) + ' · ' + fmtTime(m.time) })); // ID and time
    const sum = el('span', { class: 'msg-sum', text: m.uds.summary }); // summary
    if (m.latencyMs !== null && m.latencyMs !== undefined) sum.appendChild(el('span', { class: 'lat', text: ' · ' + m.latencyMs.toFixed(1) + ' ms after #' + m.reqNo })); // latency to the request
    if (m.partial) sum.appendChild(badge(m.level === 'error' ? 'error' : 'warn', 'partial')); // incomplete transfer
    else if (m.uds.level === 'error') sum.appendChild(badge('error')); // malformed
    else if (m.uds.kind === 'negative' && !m.uds.pending) sum.appendChild(badge('warn', 'NRC')); // negative response
    else if (m.uds.pending) sum.appendChild(badge('info', 'pending')); // response pending
    else if (m.uds.level === 'warn') sum.appendChild(badge('warn')); // other warnings
    head.appendChild(sum); // summary last
    const body = el('div', { class: 'msg-body', id: bodyId, hidden: true }); // detail, built on first open
    head.addEventListener('click', () => toggleMessage(li, m, res)); // expand / collapse
    li.appendChild(head); li.appendChild(body); // assemble
    return li; // row
  }

  /**
   * Expands or collapses a message row, building its detail on first open.
   * @param {HTMLElement} li row
   * @param {object} m message
   * @param {object} res decode result
   * @param {boolean} [forceOpen] always open
   */
  function toggleMessage(li, m, res, forceOpen) {
    const head = li.querySelector('.msg-head'); // toggle button
    const body = li.querySelector('.msg-body'); // detail
    const open = forceOpen || head.getAttribute('aria-expanded') !== 'true'; // new state
    if (open && !body.firstChild) buildDetail(body, m, res); // lazy build keeps large logs fast
    head.setAttribute('aria-expanded', open ? 'true' : 'false'); // ARIA state
    body.hidden = !open; // show or hide
  }

  /**
   * Builds the expanded detail of a message.
   * @param {HTMLElement} body container
   * @param {object} m message
   * @param {object} res decode result
   */
  function buildDetail(body, m, res) {
    const u = m.uds; // decoded content
    const chips = el('div', { class: 'chips', role: 'list', 'aria-label': 'Payload bytes coloured by role' }); // byte chips
    u.fields.forEach((f) => { // each field
      f.bytes.forEach((b, k) => { // each byte
        const label = f.label + ' (' + ROLE_NAMES[f.role] + '): ' + f.text; // tooltip and spoken label
        chips.appendChild(el('span', { class: 'chip role-' + f.role + (k === 0 ? ' fs' : ''), role: 'listitem', tabindex: '0', 'data-label': label.length > 90 ? label.slice(0, 89) + '…' : label, 'aria-label': E.hex2(b) + ', ' + label, text: E.hex2(b) })); // one chip
      });
    });
    const payloadHex = E.hexBytes(m.payload); // for copying
    const copyBytes = el('button', { type: 'button', class: 'btn btn-tiny', text: 'Copy bytes' }); // copy button
    copyBytes.addEventListener('click', () => copyText(payloadHex, copyBytes, chips)); // copy the payload
    body.appendChild(el('div', null, [el('div', { class: 'summary-row' }, [el('p', { class: 'sub-label', text: 'Bytes (' + m.payload.length + ')' }), copyBytes]), chips])); // bytes section
    const tbody = el('tbody'); // field rows
    for (const f of u.fields) { // each field
      const hex = E.hexBytes(f.bytes); // field bytes
      const cb = el('button', { type: 'button', class: 'btn btn-tiny', text: 'Copy', 'aria-label': 'Copy bytes of ' + f.label }); // copy button
      const bytesCell = el('td', { class: 'bytes', text: hex.length > 60 ? hex.slice(0, 59) + '…' : hex }); // bytes cell
      cb.addEventListener('click', () => copyText(hex, cb, bytesCell)); // copy this group
      tbody.appendChild(el('tr', null, [el('td', null, el('span', { class: 'role-tag role-' + f.role, text: ROLE_NAMES[f.role] })), el('td', { text: f.label }), bytesCell, el('td', { class: 'meaning', text: f.text }), el('td', null, cb)])); // row
    }
    body.appendChild(el('div', null, [el('p', { class: 'sub-label', text: 'Fields' }), el('div', { class: 'table-scroll' }, el('table', { class: 'fields' }, [el('thead', null, el('tr', null, ['Role', 'Field', 'Bytes', 'Meaning', ''].map((h) => el('th', { scope: 'col', text: h })))), tbody]))])); // field table
    const notes = el('ul', { class: 'notes' }); // notes
    if (m.error) notes.appendChild(el('li', null, [badge(m.level === 'error' ? 'error' : 'warn'), el('span', { text: 'ISO-TP: ' + m.error })])); // transport problem
    for (const n of u.notes) notes.appendChild(el('li', null, [badge(n.level), el('span', { text: n.text })])); // decoder notes
    if (m.reqNo) notes.appendChild(el('li', null, [badge('info', 'pair'), el('span', { text: 'Answers request #' + m.reqNo + (m.latencyMs !== null ? ', ' + m.latencyMs.toFixed(1) + ' ms after its last frame' : '') + '.' })])); // pairing
    if (m.rspNos && m.rspNos.length) notes.appendChild(el('li', null, [badge('info', 'pair'), el('span', { text: 'Answered by ' + m.rspNos.map((n) => '#' + n).join(', ') + '.' })])); // pairing
    if (m.addr !== null && m.addr !== undefined) notes.appendChild(el('li', null, [badge('info'), el('span', { text: 'Extended addressing: address byte ' + E.hex2(m.addr) + '.' })])); // address byte
    if (notes.firstChild) body.appendChild(el('div', null, [el('p', { class: 'sub-label', text: 'Notes' }), notes])); // notes section
    if (m.frameIdx.length) { // frames that formed the message
      const fl = el('ul', { class: 'frames-list' }); // list
      for (const fi of m.frameIdx) { // each frame
        const f = res.frames[fi], t = res.timeline[fi]; // frame and its timeline row
        fl.appendChild(el('li', null, ['#' + (fi + 1) + '  ' + fmtTime(f.time) + '  ' + E.hexId(f.id, f.ext) + '  ', frameBytes(f.data, t.pciLen), '  ' + t.text])); // one line
      }
      body.appendChild(el('div', null, [el('p', { class: 'sub-label', text: 'ISO-TP frames' }), fl])); // frames section
    }
  }

  /**
   * Builds one timeline table row.
   * @param {object} t timeline entry
   * @param {object} res decode result
   * @returns {HTMLElement} table row
   */
  function timelineRow(t, res) {
    const f = res.frames[t.index]; // source frame
    const cls = []; // row classes
    if (t.level === 'warn') cls.push('row-warn'); else if (t.level === 'error') cls.push('row-error'); // problem tint
    if (t.kind === '--') cls.push('skipped'); // non-diagnostic frame
    if (t.msgNo) cls.push('clickable'); // linked to a message
    const meaning = el('td', { class: 'meaning' }, [t.level === 'warn' || t.level === 'error' ? badge(t.level) : null, t.level === 'warn' || t.level === 'error' ? ' ' : '', t.text + (t.msgNo ? ' → #' + t.msgNo : '')]); // meaning with badge
    const tr = el('tr', { class: cls.join(' ') || null }, [el('td', { text: String(t.index + 1) }), el('td', { text: fmtTime(f.time) }), el('td', { text: E.hexId(f.id, f.ext) + (f.fd ? ' FD' : '') }), el('td', { text: String(f.data.length) }), el('td', { class: 'mono' }, frameBytes(f.data, t.pciLen)), meaning]); // cells
    if (t.msgNo) { // navigation to the message
      tr.tabIndex = 0; // keyboard reachable
      tr.setAttribute('aria-label', 'Frame ' + (t.index + 1) + ': ' + t.text + '. Go to message ' + t.msgNo); // spoken text
      tr.addEventListener('click', () => goToMessage(t.msgNo)); // mouse
      tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); goToMessage(t.msgNo); } }); // keyboard
    }
    return tr; // row
  }

  /**
   * Scrolls to a message, expands it and briefly highlights it.
   * @param {number} no message number
   */
  function goToMessage(no) {
    if (pendingRender) pendingRender(); // make sure the row exists
    const li = $('msg-' + no); // row
    if (!li || !lastResult) return; // filtered out by "Only problems"
    const m = lastResult.messages.find((x) => x.no === no); // message object
    toggleMessage(li, m, lastResult, true); // open it
    li.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); // bring into view
    li.classList.add('flash'); setTimeout(() => li.classList.remove('flash'), 1200); // brief outline
    li.querySelector('.msg-head').focus({ preventScroll: true }); // keyboard users continue from here
  }

  /**
   * Builds the plain-text summary of all messages for copying.
   * @returns {string} text
   */
  function summaryText() {
    if (!lastResult) return ''; // nothing decoded
    const lines = [$('dec-summary').textContent]; // header line
    for (const m of lastResult.messages) { // one line per message
      lines.push('#' + m.no + '  ' + (m.kind === 'RAW' ? 'raw' : E.hexId(m.id, m.ext) + '  ' + fmtTime(m.time)) + '  ' + (DIR_TEXT[m.dir] || 'unknown') + '  ' + m.uds.summary + (m.latencyMs !== null ? '  (' + m.latencyMs.toFixed(1) + ' ms)' : '') + (m.partial ? '  [partial]' : '')); // message line
    }
    for (const e of lastResult.events) lines.push('frame ' + (e.index + 1) + ' ' + e.level + ': ' + e.text); // problems
    return lines.join('\n'); // text
  }

  /** Sets up the Decode tab. */
  function initDecode() {
    loadExamples(); // picker and initial text
    $('dec-example').addEventListener('change', (ev) => { // pick an example
      const ex = examples.find((x) => x.id === ev.target.value); // chosen example
      if (ex) { $('dec-input').value = ex.text; decodeNow(); } // load and decode
    });
    $('dec-input').addEventListener('input', () => { $('dec-example').value = ''; decodeSoon(); }); // live decode; the text is no longer the example
    for (const id of ['dec-req-ids', 'dec-rsp-ids']) $(id).addEventListener('input', decodeSoon); // ID lists
    $('dec-addressing').addEventListener('change', decodeNow); // addressing
    $('dec-problems').addEventListener('change', () => { if (lastResult) renderDecode(lastResult); }); // filter without re-decoding
    $('dec-run').addEventListener('click', decodeNow); // explicit decode
    $('dec-clear').addEventListener('click', () => { $('dec-input').value = ''; $('dec-example').value = ''; decodeNow(); $('dec-input').focus(); }); // empty
    $('dec-copy-all').addEventListener('click', (ev) => copyText(summaryText(), ev.currentTarget, $('dec-messages'))); // copy summary
    decodeNow(); // decode the example on load
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Simulate tab
  // ---------------------------------------------------------------------------------------------------------------

  const ecu = S.createEcu(); // the virtual ECU
  const clockStart = performance.now(); // real-time origin
  let offsetMs = 0; // virtual offset added after delayed responses
  let frameLines = []; // candump -L lines of everything on the bus
  let keepAliveTimer = 0; // TesterPresent interval
  let keepAliveItem = null; // log entry that counts keep-alives
  let keepAliveCount = 0; // keep-alives in the current run

  /** @returns {number} simulated time in ms */
  function simNow() {
    return performance.now() - clockStart + offsetMs; // real elapsed time + virtual offset
  }

  /**
   * Reads and validates the bus settings.
   * @returns {object|null} exchange configuration, or null with the problem shown
   */
  function busConfig() {
    const hint = $('sim-bus-hint'); // problem line
    const id = (v) => (/^(0x)?[0-9A-Fa-f]{1,8}$/.test(v.trim()) ? parseInt(v.trim().replace(/^0x/i, ''), 16) : NaN); // hex ID parser
    const reqId = id($('sim-req-id').value), rspId = id($('sim-rsp-id').value); // IDs
    const padText = $('sim-pad').value.trim(); // padding byte text
    const pad = padText === '' ? null : (/^(0x)?[0-9A-Fa-f]{1,2}$/.test(padText) ? parseInt(padText.replace(/^0x/i, ''), 16) : NaN); // byte or none
    const stMin = Number($('sim-stmin').value); // separation time
    let problem = ''; // first problem found
    if (!(reqId >= 0 && reqId <= 0x1FFFFFFF)) problem = 'Request ID must be hex, for example 7E0.'; // bad request ID
    else if (!(rspId >= 0 && rspId <= 0x1FFFFFFF)) problem = 'Response ID must be hex, for example 7E8.'; // bad response ID
    else if (Number.isNaN(pad)) problem = 'Padding must be one hex byte (for example AA) or empty for none.'; // bad padding
    else if (!(stMin >= 0 && stMin <= 127)) problem = 'STmin must be between 0 and 127 ms.'; // bad STmin
    hint.textContent = problem; hint.classList.toggle('bad', !!problem); // show or clear
    if (problem) return null; // refuse to send
    const ext = reqId > 0x7FF || rspId > 0x7FF; // 29-bit IDs
    const fd = $('sim-fd').checked; // CAN FD
    return { reqId, rspId, ext, fd, canDl: fd ? Number($('sim-candl').value) : 8, brs: fd && $('sim-brs').checked, pad, stMinMs: stMin, functional: $('sim-functional').checked, iface: 'can0' }; // configuration
  }

  /**
   * Appends an event separator to the session log.
   * @param {string} text event text
   */
  function logEvent(text) {
    addLog(el('li', { class: 'sep' }, el('span', { text }))); // dashed separator
    keepAliveItem = null; // later keep-alives start a new counter
  }

  /**
   * Adds an entry to the session log and keeps it bounded and scrolled.
   * @param {HTMLElement} li entry
   */
  function addLog(li) {
    const log = $('sim-log'); // log list
    const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40; // follow the end only if the user is there
    log.appendChild(li); // append
    while (log.childNodes.length > 400) log.removeChild(log.firstChild); // bound memory
    if (atEnd) log.scrollTop = log.scrollHeight; // follow new entries
  }

  /**
   * Builds one line of an exchange card.
   * @param {string} time time text
   * @param {Array} main content nodes
   * @returns {HTMLElement} line
   */
  function cardLine(time, main) {
    return el('div', { class: 'card-line' }, [el('span', { class: 'card-time', text: time }), el('div', { class: 'card-main' }, main)]); // time + content
  }

  /**
   * Sends a request through the exchange driver and logs the result.
   * @param {number[]} bytes request bytes
   * @param {{keepAlive?: boolean}} [opts] keep-alive requests are logged compactly
   * @returns {boolean} true when sent
   */
  function simSend(bytes, opts) {
    const o = opts || {}; // optional
    const cfg = busConfig(); // bus settings
    if (!cfg) return false; // invalid settings are explained in the hint
    const t = simNow() / 1000; // request time in seconds
    const x = S.exchange(ecu, bytes, t, cfg); // run the exchange
    offsetMs += Math.max(0, x.tEnd - t) * 1000; // later requests come after the last scheduled response
    frameLines.push(...x.frames.map((f) => E.formatCandump(f))); // bus log
    const fr = $('sim-frames'); // frame log box
    fr.value = frameLines.join('\n'); // show it
    fr.scrollTop = fr.scrollHeight; // newest at the bottom
    for (const e of x.events) logEvent(e); // ECU events first, as they happen on receipt
    if (o.keepAlive && x.responses.length === 0 && x.frames.length) { // quiet keep-alive
      keepAliveCount = keepAliveItem ? keepAliveCount + 1 : 1; // count in this run
      if (!keepAliveItem) { keepAliveItem = el('li', { class: 'sep' }, el('span')); addLog(keepAliveItem); } // one entry per run
      keepAliveItem.firstChild.textContent = 'Keep-alive: 3E 80 sent ×' + keepAliveCount + ', last at ' + t.toFixed(3) + ' s'; // update it
      refreshStatus(); // timer reset is visible
      return true; // done
    }
    keepAliveItem = null; // a normal exchange ends the keep-alive run
    const reqDec = E.decodeUds(bytes, { dir: 'req' }); // decoded request
    const card = el('li', { class: 'card' }); // exchange card
    card.appendChild(cardLine(t.toFixed(3) + ' s', [el('strong', { text: '→ ' }), reqDec.summary, reqDec.level === 'error' || reqDec.level === 'warn' ? badge(reqDec.level) : null, el('span', { class: 'card-hex', text: (x.functional ? 'functional · ' : '') + E.hexBytes(bytes) })])); // request line
    for (const r of x.responses) { // responses in time order
      const d = E.decodeUds(r.bytes, { dir: 'rsp', request: bytes }); // decoded response
      const b = d.kind === 'negative' ? (d.pending ? badge('info', 'pending') : badge('warn', 'NRC')) : null; // badge for negative responses
      card.appendChild(cardLine('+' + (r.t - t).toFixed(3) + ' s', [el('strong', { text: '← ' }), d.summary, b ? ' ' : null, b, el('span', { class: 'card-hex', text: E.hexBytes(r.bytes) })])); // response line
    }
    if (!x.responses.length) { // explain silence
      const why = x.frames.length === 0 ? x.events.join(' ') : bytes.length > 1 && (bytes[1] & 0x80) && [0x10, 0x11, 0x27, 0x28, 0x3E, 0x85, 0x31].includes(bytes[0]) ? 'No response: the suppressPosRspMsg bit is set.' : x.functional ? 'No response: functional requests get no serviceNotSupported / subFunctionNotSupported / requestOutOfRange / not-in-session NRCs.' : 'No response.'; // reason
      card.appendChild(cardLine('', [el('span', { class: 'card-hex', text: why })])); // note line
    }
    if (x.frames.length) { // frames on the bus
      const fl = el('ul', { class: 'frames-list' }); // list
      for (const f of x.frames) fl.appendChild(el('li', { text: (f.who === 'tester' ? 'tester  ' : 'ecu     ') + E.formatCandump(f) })); // one frame per line
      card.appendChild(el('details', null, [el('summary', { text: 'Frames on the bus (' + x.frames.length + ')' }), fl])); // collapsed list
    }
    addLog(card); // show
    refreshStatus(); // state changed
    return true; // sent
  }

  /**
   * Updates a progress bar.
   * @param {HTMLElement} bar bar element
   * @param {number} value current value
   * @param {number} max maximum
   * @param {string} text spoken value
   */
  function setBar(bar, value, max, text) {
    bar.firstChild.style.width = (max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0) + '%'; // fill width
    bar.setAttribute('aria-valuemax', String(max)); // range
    bar.setAttribute('aria-valuenow', String(Math.round(value))); // value
    bar.setAttribute('aria-valuetext', text); // readable value
  }

  /**
   * Fills a definition list with key/value rows.
   * @param {HTMLElement} dl list
   * @param {Array} rows [key, value, stateClass]
   */
  function fillStatus(dl, rows) {
    clear(dl); // rebuild (small list)
    for (const [k, v, c] of rows) { dl.appendChild(el('dt', { text: k })); dl.appendChild(el('dd', { class: c || null, text: v })); } // rows
  }

  /** Refreshes the status panel, bars and the security helper. */
  function refreshStatus() {
    const now = simNow(); // current simulated time
    const s = ecu.snapshot(now); // state
    const lock = s.lockoutRemainingMs > 0; // locked out?
    fillStatus($('sim-status'), [
      ['Session', s.sessionName + ' (0x0' + s.session + ')', s.session === 1 ? null : 'st-warn'], // session
      ['Security', lock ? 'locked out, ' + Math.ceil(s.lockoutRemainingMs / 1000) + ' s left' : s.unlocked ? 'unlocked (level 1)' : 'locked', lock ? 'st-error' : s.unlocked ? 'st-ok' : null], // security
      ['Wrong keys', s.attempts + ' of ' + s.maxAttempts], // attempts
      ['Communication', s.comm ? s.comm.text + ' (type 0x' + E.hex2(s.comm.type) + ')' : 'normal', s.comm ? 'st-warn' : null], // 0x28 state
      ['DTC setting', s.dtcSetting, s.dtcSetting === 'off' ? 'st-warn' : null], // 0x85 state
      ['DTCs stored', s.dtcCount ? s.dtcs.map((d) => d.text + ' (' + E.hex2(d.status) + ')').join(', ') : 'none'], // DTC list
      ['Flash', s.download ? 'download active' : s.erased ? 'erased, ready for download' : 'programmed'], // programming state
      ['Demo LED (0300)', (s.led ? 'on (0x' + E.hex2(s.led) + ')' : 'off') + (s.ledOverride ? ', tester control' : ', ECU control')], // IO control
      ['Sim time', (now / 1000).toFixed(1) + ' s'], // clock
    ]);
    const s3 = $('sim-s3-bar'); // S3 bar
    const s3Text = s.s3RemainingMs === null ? 'not running (default session)' : (s.s3RemainingMs / 1000).toFixed(1) + ' s left'; // readable
    $('sim-s3-label').textContent = 'S3 timer: ' + s3Text; // label shows the value as text
    setBar(s3, s.s3RemainingMs || 0, s.s3Ms, s3Text); // fill
    $('sim-dl-wrap').hidden = !s.download; // download bar only while active
    if (s.download) { // progress
      const t = s.download.received + ' of ' + s.download.size + ' bytes, next block ' + ((s.download.counter + 1) & 0xFF); // readable
      $('sim-dl-label').textContent = 'Download: ' + t; // label
      setBar($('sim-dl-bar'), s.download.received, s.download.size, t); // fill
    }
    fillStatus($('sim-seed'), [
      ['Pending seed', s.seed ? E.hexBytes(s.seed) : s.unlocked ? 'none (already unlocked)' : 'none: send 27 01 in the extended or programming session'], // seed
      ['Key', s.seed ? E.hexBytes(S.demoKey(s.seed)) : '—', s.seed ? 'st-ok' : null], // computed key
    ]);
  }

  /**
   * Returns the next TransferData request for the active download (or a first block when none is active).
   * @returns {number[]} request bytes
   */
  function nextBlock() {
    const d = ecu.snapshot(simNow()).download; // active download
    const counter = d ? (d.counter + 1) & 0xFF : 1; // next block number
    const n = d ? Math.max(1, Math.min(254, d.size - d.received)) : 254; // data bytes in this block
    return [0x36, counter].concat(Array.from({ length: n }, (_, i) => (i * 7 + counter) & 0xFF)); // demo data pattern
  }

  /**
   * Returns 27 02 with the key for the pending seed (zeros when there is none, which the ECU rejects with 0x24).
   * @returns {number[]} request bytes
   */
  function keyRequest() {
    const s = ecu.snapshot(simNow()); // state
    return [0x27, 0x02].concat(s.seed ? S.demoKey(s.seed) : [0, 0, 0, 0]); // key or zeros
  }

  const QUICK = [ // quick requests: label and bytes (functions compute dynamic requests)
    ['10 01', '10 01'], ['10 02', '10 02'], ['10 03', '10 03'], ['3E 00', '3E 00'], ['22 F190', '22 F1 90'], ['22 F186 F187', '22 F1 86 F1 87'],
    ['27 01', '27 01'], ['27 02 + key', keyRequest], ['2E F198 …', '2E F1 98 45 47 2D 30 30 31'], ['19 02 FF', '19 02 FF'], ['14 FFFFFF', '14 FF FF FF'],
    ['31 01 FF00', '31 01 FF 00'], ['34 …', '34 00 44 08 00 00 00 00 00 01 00'], ['36 next block', nextBlock], ['37', '37'], ['11 01', '11 01'],
    ['28 03 01', '28 03 01'], ['85 02', '85 02'],
  ];

  /** Sets up the Simulate tab. */
  function initSimulate() {
    const quick = $('sim-quick'); // quick button container
    for (const [label, req] of QUICK) { // one button each
      const title = typeof req === 'string' ? 'Send ' + req : label === '36 next block' ? 'Send the next TransferData block of the active download' : 'Send 27 02 with the key computed from the pending seed'; // tooltip
      quick.appendChild(el('button', { type: 'button', class: 'btn', title, text: label, onclick: () => simSend(typeof req === 'string' ? E.parseHexBytes(req).bytes : req()) })); // sends immediately
    }
    $('sim-form').addEventListener('submit', (ev) => { // composer (Enter or Send)
      ev.preventDefault(); // stay on the page
      const r = E.parseHexBytes($('sim-input').value); // parse
      const hint = $('sim-input-hint'); // hint line
      if (r.error || !r.bytes.length) { hint.textContent = r.error ? r.error + '. Type hex bytes, for example 22 F1 90.' : 'Type a request first, for example 22 F1 90.'; hint.classList.add('bad'); return; } // explain
      if (r.bytes.length > 4095) { hint.textContent = 'Requests longer than 4095 bytes are not supported here.'; hint.classList.add('bad'); return; } // keep exchanges small
      hint.textContent = 'Hex bytes, spaces optional. Enter sends.'; hint.classList.remove('bad'); // reset hint
      if (simSend(r.bytes)) $('sim-input').select(); // sent: select for quick editing
    });
    $('sim-use-key').addEventListener('click', () => { $('sim-input').value = E.hexBytes(keyRequest()); $('sim-input').focus(); }); // key into the composer
    $('sim-reset').addEventListener('click', () => { ecu.reset(); logEvent('ECU reset to its power-on state (DTCs and data restored)'); refreshStatus(); }); // power-on reset
    $('sim-clear-log').addEventListener('click', () => { clear($('sim-log')); frameLines = []; $('sim-frames').value = ''; keepAliveItem = null; }); // clear logs
    $('sim-copy-frames').addEventListener('click', (ev) => copyText(frameLines.join('\n'), ev.currentTarget, $('sim-frames'))); // copy frames
    $('sim-open-decode').addEventListener('click', () => { // send the frames to the Decode tab
      const cfg = busConfig(); // current IDs
      $('dec-input').value = frameLines.join('\n'); // frames as log text
      $('dec-example').value = ''; // not an example any more
      if (cfg && (E.classifyId(cfg.reqId, cfg.ext) !== 'req' || E.classifyId(cfg.rspId, cfg.ext) !== 'rsp')) { // non-standard IDs need the lists
        $('dec-req-ids').value = E.hexId(cfg.reqId, cfg.ext); $('dec-rsp-ids').value = E.hexId(cfg.rspId, cfg.ext); // fill them in
      }
      goTab('decode'); decodeNow(); // switch and decode
    });
    $('sim-keepalive').addEventListener('change', (ev) => { // TesterPresent every 2 s
      clearInterval(keepAliveTimer); keepAliveItem = null; // stop any previous timer
      if (ev.target.checked) keepAliveTimer = setInterval(() => simSend([0x3E, 0x80], { keepAlive: true }), 2000); // start
    });
    const syncFd = () => { $('sim-brs').disabled = !$('sim-fd').checked; $('sim-candl').disabled = !$('sim-fd').checked; }; // FD-only options
    $('sim-fd').addEventListener('change', syncFd); syncFd(); // initial state
    for (const id of ['sim-req-id', 'sim-rsp-id', 'sim-pad', 'sim-stmin']) $(id).addEventListener('input', busConfig); // validate as the user types
    setInterval(() => { for (const e of ecu.tick(simNow())) logEvent(e); refreshStatus(); }, 250); // S3 and lockout four times per second
    refreshStatus(); // initial state
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Reference tab
  // ---------------------------------------------------------------------------------------------------------------

  let referenceBuilt = false; // build once

  /**
   * Builds a reference card with a table.
   * @param {string} title heading
   * @param {string[]} cols column headings
   * @param {Array[]} rows cell texts
   * @param {string} [note] text under the heading
   * @returns {HTMLElement} panel
   */
  function refTable(title, cols, rows, note) {
    const tb = el('tbody'); // body
    for (const r of rows) tb.appendChild(el('tr', null, r.map((c, i) => el('td', { class: i === 0 ? 'mono' : null, text: String(c) })))); // rows
    return el('section', { class: 'panel' }, [el('h2', { class: 'label', text: title }), note ? el('p', { class: 'hint', text: note }) : null, el('div', { class: 'table-scroll' }, el('table', null, [el('thead', null, el('tr', null, cols.map((c) => el('th', { scope: 'col', text: c })))), tb]))]); // card
  }

  /** Builds the Reference tab from the decoder tables. */
  function buildReference() {
    if (referenceBuilt) return; // only once
    referenceBuilt = true; // mark
    const T = E.tables; // decoder tables
    const out = $('ref-content'); // container
    const legend = el('div', { class: 'legend' }); // byte colour legend
    for (const r of Object.keys(ROLE_NAMES)) legend.appendChild(el('span', { class: 'role-tag role-' + r, text: r + ' · ' + ROLE_NAMES[r] })); // swatch + text
    out.appendChild(el('section', { class: 'panel' }, [el('h2', { class: 'label', text: 'Byte colours' }), el('p', { class: 'hint', text: 'Every byte chip is coloured by its role and also names its field on hover or focus.' }), legend])); // legend card
    out.appendChild(refTable('UDS services (ISO 14229-1)', ['SID', 'Response', 'Service', 'Sub-function', 'Simulator'], Object.keys(T.UDS_SERVICES).map(Number).sort((a, b) => a - b).map((sid) => ['0x' + E.hex2(sid), '0x' + E.hex2(sid + 0x40), T.UDS_SERVICES[sid].name, T.UDS_SERVICES[sid].sub ? 'yes' : 'no', S.SUPPORTED.includes(sid) ? 'supported' : '—']), 'Negative responses are 7F <SID> <NRC> for every service.')); // services
    const nrcRows = Object.keys(T.NRC_NAMES).map(Number).sort((a, b) => a - b).map((c) => ['0x' + E.hex2(c), T.NRC_NAMES[c]]); // named codes
    nrcRows.push(['0x38–0x4F', E.nrcName(0x38)], ['0x95–0xEF', E.nrcName(0x95)], ['0xF0–0xFE', E.nrcName(0xF0)], ['others', 'ISOSAEReserved']); // ranges
    out.appendChild(refTable('Negative response codes', ['NRC', 'Name'], nrcRows, '0x78 is not a failure: the ECU needs more time and the request stays open.')); // NRCs
    out.appendChild(refTable('ISO-TP frame types (ISO 15765-2)', ['PCI', 'Frame', 'Layout'], [
      ['0x0_', 'Single Frame', 'low nibble = SF_DL 1..7; CAN FD: 00 then 1-byte SF_DL above 8 bytes'],
      ['0x1_', 'First Frame', '12-bit FF_DL; 00 00 then 32-bit FF_DL above 4095 bytes'],
      ['0x2_', 'Consecutive Frame', 'low nibble = sequence number, 1 after the FF, wraps 15 → 0'],
      ['0x3_', 'Flow Control', 'FS (0 ContinueToSend, 1 Wait, 2 Overflow), BS, STmin'],
      ['STmin', 'Separation time', '0x00–0x7F = 0–127 ms; 0xF1–0xF9 = 100–900 µs; others reserved (use 127 ms)'],
      ['DLC', 'CAN FD sizes', T.DLC_SIZES.join(', ') + ' bytes'],
    ])); // ISO-TP
    out.appendChild(refTable('DTC status bits', ['Bit', 'Mask', 'Name'], T.DTC_STATUS_BITS.map((n, i) => [String(i), '0x' + E.hex2(1 << i), n]))); // status bits
    out.appendChild(refTable('Diagnostic sessions', ['Value', 'Session', 'Simulator'], [1, 2, 3, 4].map((v) => ['0x0' + v, E.subName(0x10, v), S.SESSION_NAMES[v] ? 'supported' : '—']))); // sessions
    out.appendChild(refTable('OBD-II PIDs decoded (SAE J1979)', ['PID', 'Name', 'Bytes', 'Formula'], Object.keys(T.OBD_PIDS).map(Number).sort((a, b) => a - b).map((p) => ['0x' + E.hex2(p), T.OBD_PIDS[p].name, String(T.OBD_PIDS[p].len), T.OBD_PIDS[p].formula]), 'Modes 01–0A; responses are the mode + 0x40. DTCs use 2 bytes in OBD-II and 3 bytes (with failure type) in UDS.')); // PIDs
    out.appendChild(refTable('Simulator demo data (made up)', ['ID', 'Content'], [
      ['F190', 'VIN "EGTEST12345678901"'], ['F187', '"EG-DEMO-0001"'], ['F189', '"1.0.3"'], ['F18A', '"EMBEDDED GARAGE"'], ['F18C', '"0000042"'],
      ['F191', '"HW-A1"'], ['F195', '"SW-1.0.3"'], ['F186', 'active session (1 byte)'], ['F198', '6 bytes, writable (extended session, unlocked)'],
      ['0100', 'battery voltage in mV (2 bytes)'], ['0101', 'coolant raw 0x5A'], ['0300', 'demo LED, controlled with 0x2F'],
      ['DTCs', 'P0300-00 (2F), P0113-00 (08), U0100-87 (09)'], ['RID FF00', 'eraseMemory: programming session, unlocked; answers 78, 78, then 71 at 7 s'],
      ['RID 0200', 'self-test: extended session'], ['Download', '0x08000000–0x080FFFFF, max block 256 bytes'],
      ['Security', 'key = (ROL32(seed XOR 0xC0FFEE11, 5) + 0x1234ABCD) mod 2^32; 3 wrong keys → 10 s lockout'],
      ['Timing', 'P2 50 ms, P2* 5000 ms, S3 5000 ms'],
    ])); // demo data
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------------------------------------------

  /** Initialises every part of the page. */
  function start() {
    initTheme(); // colours first, so there is no flash later
    initTabs(); // tabs and routing
    initDecode(); // decode the example
    initSimulate(); // virtual ECU
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); // scripts run at the end of body, but be safe
  else start(); // DOM already parsed
})();
