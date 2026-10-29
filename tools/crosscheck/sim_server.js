// Simulator bridge by Embedded Garage: keeps one virtual ECU alive and answers one JSON request per stdin line (dev-only).
'use strict'; // strict mode
const path = require('node:path'); // path helpers
const readline = require('node:readline'); // line-by-line stdin
const S = require(path.join(__dirname, '..', '..', 'src', 'sim.js')); // simulator under test
const ecu = S.createEcu(); // one ECU for the whole session, so state carries over between requests
const rl = readline.createInterface({ input: process.stdin }); // read requests
rl.on('line', (line) => { // one request per line
  const msg = JSON.parse(line); // {op, ...}
  let out; // reply
  if (msg.op === 'handle') out = ecu.handle(msg.req, msg.now, { functional: !!msg.functional }); // run a request
  else if (msg.op === 'demoKey') out = S.demoKey(msg.seed); // made-up key algorithm
  else if (msg.op === 'snapshot') out = ecu.snapshot(msg.now); // ECU state
  else if (msg.op === 'reset') { ecu.reset(); out = true; } // power-on state
  else out = { error: 'unknown op ' + msg.op }; // refuse anything else
  process.stdout.write(JSON.stringify(out) + '\n'); // one reply line
});
