// Cross-check bridge by Embedded Garage: lets the Python oracle scripts call the UDS Bench core and simulator.
// Dev-only. Reads one JSON batch from stdin, runs each call and writes one JSON array of results to stdout.
'use strict'; // strict mode
const path = require('node:path'); // path helpers
const E = require(path.join(__dirname, '..', '..', 'src', 'core.js')); // decoder under test
const S = require(path.join(__dirname, '..', '..', 'src', 'sim.js')); // simulator under test
const ALLOWED = { // functions the scripts may call, by name
  parseLog: E.parseLog, reassemble: E.reassemble, segment: E.segment, flowControl: E.flowControl, // parsing and ISO-TP
  decodeUds: E.decodeUds, decodeAll: E.decodeAll, dtcText: E.dtcText, nrcName: E.nrcName, // decoding
  serviceName: E.serviceName, subName: E.subName, didName: E.didName, ridName: E.ridName, // naming
  demoKey: S.demoKey, // simulator helper
  fieldsOf: (payload, opts) => E.decodeUds(payload, opts).fields.map((f) => [f.role, f.label, f.bytes, f.text]), // compact decode: fields only
  summaryOf: (payload, opts) => { const r = E.decodeUds(payload, opts); return [r.kind, r.sid, r.name, r.summary, r.level]; }, // compact decode: headline only
};
let input = ''; // collected stdin
process.stdin.setEncoding('utf8'); // text input
process.stdin.on('data', (chunk) => { input += chunk; }); // collect
process.stdin.on('end', () => { // run the whole batch
  const calls = JSON.parse(input); // [[name, args], ...]
  const out = calls.map(([name, args]) => { // one result per call
    const fn = ALLOWED[name]; // look up the function
    if (!fn) return { error: 'unknown function ' + name }; // refuse anything else
    try { return { result: fn(...args) }; } catch (e) { return { error: String(e && e.message ? e.message : e) }; } // a throw is itself a finding
  });
  process.stdout.write(JSON.stringify(out)); // results in call order
});
