// UDS Bench build script by Embedded Garage: inlines styles and scripts into one self-contained HTML file.
// It has no dependencies and fails loudly (non-zero exit) when any input is missing or a placeholder is unused.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'; // file access from the standard library
import { dirname, join } from 'node:path'; // path helpers to resolve files relative to the repository
import { fileURLToPath } from 'node:url'; // converts this module's URL into a file path

const root = join(dirname(fileURLToPath(import.meta.url)), '..'); // repository root, one level above scripts/

/**
 * Reads one input file as UTF-8 and stops the build with a clear message when it does not exist.
 * @param {string} rel path relative to the repository root
 * @returns {string} file contents
 */
function readInput(rel) {
  const abs = join(root, rel); // absolute path of the input
  if (!existsSync(abs)) { // a missing input must never produce a half-built page
    console.error(`build: missing input ${rel}`); // say exactly which file is missing
    process.exit(1); // non-zero exit so CI and hosting builds fail
  }
  return readFileSync(abs, 'utf8'); // the file text
}

/**
 * Makes inlined script text safe inside a <script> element by breaking any closing-tag sequence.
 * @param {string} js script source
 * @returns {string} escaped source
 */
function safeScript(js) {
  return js.replace(/<\/script/gi, '<\\/script'); // "</script" would end the element early
}

const template = readInput('src/index.template.html'); // page markup with placeholders
const parts = { // placeholder name → replacement text
  STYLE: readInput('src/style.css'), // all styling
  CORE: safeScript(readInput('src/core.js')), // decoder (global EGUDS)
  SIM: safeScript(readInput('src/sim.js')), // simulator (global EGSIM)
  UI: safeScript(readInput('src/ui.js')), // DOM code
};

let html = template; // output text, filled step by step
for (const [name, text] of Object.entries(parts)) { // replace each placeholder exactly once
  const token = `{{${name}}}`; // placeholder as written in the template
  if (!html.includes(token)) { // a missing placeholder means the template and build disagree
    console.error(`build: placeholder ${token} not found in src/index.template.html`); // explain the failure
    process.exit(1); // stop the build
  }
  html = html.split(token).join(text); // split/join avoids special "$" handling of String.replace
}

mkdirSync(join(root, 'dist'), { recursive: true }); // make sure the output folder exists
writeFileSync(join(root, 'dist', 'index.html'), html); // write the single-file page
console.log(`build: wrote dist/index.html (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`); // report the size against the 300 KB budget
