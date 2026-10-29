# UDS Bench user guide

UDS Bench is a free workbench for automotive diagnostics, made by Embedded Garage. It runs entirely in your browser:
nothing you paste or send is uploaded, and the page makes no network requests apart from loading its fonts.

## What it is for

Diagnostic traffic on a vehicle bus is hard to read by eye. A single request such as "read the VIN" can be split over
several CAN frames by the transport layer (ISO-TP, ISO 15765-2), and the bytes only make sense once they are put back
together and interpreted as UDS (ISO 14229-1) or OBD-II (SAE J1979). UDS Bench does that work for you.

We built it for three jobs:

- **Reading logs.** Paste a CAN or CAN FD log and see each diagnostic message reassembled, named and explained byte
  by byte, with transport errors and negative responses flagged.
- **Learning and experimenting.** Talk to a virtual ECU, try sessions, security access, DTCs and a flash download,
  and watch exactly which frames go on the bus.
- **Quick lookup.** Service IDs, negative response codes, ISO-TP frame types, DTC status bits and OBD-II formulas in
  one place.

It is a teaching and analysis tool. It does not connect to hardware, and the virtual ECU is a made-up model, not any
manufacturer's ECU.

## Opening the tool

- **Hosted:** open the published page in any current browser (desktop or phone).
- **Locally:** open `dist/index.html` from this repository directly in a browser. It is a single self-contained file;
  no server or installation is needed.
- **From source:** with Node 20 or newer, run `npm run build` to regenerate `dist/index.html`, and `npm test` to run
  the tests.

The page has three tabs: **Decode**, **Simulate** and **Reference**. You can link to a tab directly with
`#decode`, `#simulate` or `#reference` at the end of the address. The **Theme** button in the top right switches
between automatic, dark and light colours.

## Decode tab

The Decode tab opens with an example session already decoded, so you can see what the output looks like straight away.

### 1. Put a log in

Paste your log into the **Log input** box, or pick one from **Example**:

- *Basic session*: a classic CAN session (session change, VIN read, security access, DTC read, a write).
- *CAN FD multi-frame*: a CAN FD programming flow with large transfers.
- *Error cases*: logs with deliberate problems, to show how each one is reported.

Supported formats (you can mix them in one log):

| Format | Example line |
|---|---|
| candump `-L` | `(1698484800.123456) can0 7E0#0210030000000000` |
| candump `-L`, CAN FD | `(1698484800.123456) can0 7E0##1000922F190F186F187F189AA` |
| candump default | `can0  7E0   [8]  02 10 03 00 00 00 00 00` |
| Vector ASC (classic CAN) | `0.016000 1  7E0   Tx   d 8 02 10 03 00 00 00 00 00` |
| Vector ASC (CAN FD) | `0.016000 CANFD 1 Tx 7E0 1 0 9 12 00 09 22 F1 90 F1 86 F1 87 F1 89 AA` |
| PCAN-View `.trc` 1.0 to 1.3 | `1)  1.5  Tx  07E0  8  02 10 03 00 00 00 00 00` |
| PCAN-View `.trc` 2.0 / 2.1 (with its header) | `1  0.750  FB  1  07E0  Tx  -  9  00 09 22 F1 90 F1 86 F1 87 F1 89 AA` |
| ID and data | `7E0#0210030000000000` |
| ID and bytes | `7E0 02 10 03` or `7E0: 02 10 03` |
| Raw UDS payload | `22 F1 90` (decoded directly, without CAN framing) |

Blank lines and lines starting with `#` or `//` are skipped, and so are `;` lines in PCAN-View traces (their
`;$FILEVERSION`, `;$STARTTIME` and `;$COLUMNS` headers are read first, so paste the whole file). Lines that match no format are listed under
**ignored lines** with their line number and the reason, so nothing disappears silently.

Decoding runs as you type. The **Decode** button runs it immediately, and **Clear** empties the box.

### 2. Tell it about your IDs (only if needed)

By default we recognise the standard diagnostic IDs: `7DF` and `7E0`–`7E7` for requests and `7E8`–`7EF` for
responses (11-bit), and `18DA…` / `18DB33F1` (29-bit). If your ECU uses other IDs, enter them in **Request IDs** and
**Response IDs** as comma-separated hex, for example `714, 18DA10F1`.

When the log contains diagnostic IDs, frames on other IDs (normal application traffic) are shown in the timeline as
skipped instead of being misread as diagnostics.

While both lists are empty, a line under the summary lists the CAN IDs outside the standard diagnostic ranges with
their frame counts, and says whether their frames were decoded or skipped. Press **req** or **rsp** next to an ID to
add it to the matching list; the log is decoded again straight away.

Set **Addressing** to *Extended (address byte)* if your network puts an address byte in front of every ISO-TP frame.

### 3. Read the results

- **Summary line:** the number of frames, messages, problems and ignored lines, plus the decode time.
  **Copy summary** copies a plain-text list of all messages and problems.
- **Problems list:** every transport-level warning or error (wrong sequence number, orphan frame, incomplete
  transfer, buffer overflow, invalid frame), with the frame number.
- **Messages:** one row per reassembled message, showing its number, direction (*Tester → ECU* or *ECU → Tester*),
  CAN ID, time and a one-line summary such as `+ ReadDataByIdentifier · F190 "EGTEST12345678901"`. Responses show
  how long after their request they arrived. Badges mark negative responses (**NRC**), response-pending
  (**pending**), incomplete transfers (**partial**) and errors.
- Click a message to expand it:
  - **Bytes:** every byte as a coloured chip. Colours show the byte's role (service ID, sub-function, identifier,
    format, data, NRC); hover or focus a chip to see its field name. **Copy bytes** copies the payload.
  - **Fields:** a table of every field with its bytes and meaning. Each field also has a **Copy** button.
  - **Notes:** explanations, hints for negative responses (for example "Unlock with SecurityAccess (0x27) first"), and
    which request a response answers.
  - **ISO-TP frames:** the CAN frames that formed the message, with the transport bytes underlined.
- **Frame timeline:** every frame in the log with its time, ID, length, data and ISO-TP meaning (for example
  `FF · total 20 bytes` or `FC · ContinueToSend, BS 0 (no limit), STmin 0 ms`). Click a row to jump to its message.
  Very long logs show the first 1,000 frames, with a button to show the rest.
- Tick **Only problems** to hide everything that decoded cleanly.

## Simulate tab

The Simulate tab gives you a virtual ECU to talk to. Its data, DTCs and security algorithm are invented for teaching.

### Sending requests

Type a request in hex under **Send a request** (spaces are optional, for example `22 F190`) and press Enter or
**Send**. Or use the quick buttons, which cover the common services: session changes (`10 01`, `10 02`, `10 03`),
TesterPresent, DID reads and writes, security access, DTC read and clear, routines, the download sequence
(`34 …`, `36 next block`, `37`), ECU reset, communication control and DTC setting.

Each exchange appears in the **Session log** as a card: the decoded request, every response in time order (including
response-pending answers), and a collapsed list of the frames on the bus. Events such as a session change, an S3
timeout or a security lockout appear as separator lines.

### ECU status and the security helper

**ECU status** shows the active session, the security state (locked, unlocked, or locked out with the seconds left),
wrong-key attempts, communication and DTC-setting state, stored DTCs, flash state, the demo LED and the simulated time.
The **S3 timer** bar shows how long until a non-default session falls back to default; tick
**Keep-alive (3E 80 every 2 s)** to keep it alive. **Reset ECU** restores the power-on state.

To unlock security: change to the extended (`10 03`) or programming (`10 02`) session, send `27 01` for a seed, then
press **27 02 + key** (or **Put 27 02 + key in the composer**). The **Security helper** shows the pending seed, the
matching key and the made-up algorithm used to compute it. Three wrong keys lock security out for 10 seconds.

### A full programming flow

Press these quick buttons in order: `10 02`, `27 01`, `27 02 + key`, `31 01 FF00` (erase; the ECU answers "response
pending" twice before finishing), `34 …` (request download), `36 next block` (twice), `37`. The status panel shows
the download progress as it goes.

### Bus settings

Change the **Request ID** and **Response ID**, the **Padding byte** (empty for none) and **STmin**, tick **CAN FD**
(with **BRS** and an **FD frame size**) or **Functional (7DF)** addressing. The frames in the session log and frame
log follow these settings.

### Taking a session to the decoder

The **Frame log (candump -L)** box holds every frame of the session in candump format. **Copy** copies it, and
**Open in Decode** sends it to the Decode tab and decodes it there.

## Reference tab

Tables generated from the same data the decoder uses: UDS services with their request and response IDs and which ones
the simulator supports, negative response codes, ISO-TP frame types and STmin values, DTC status bits, diagnostic
sessions, the decoded OBD-II PIDs with their formulas, the simulator's demo data, and a legend of the byte colours.

## Good to know

- **Privacy:** everything runs in your browser. Logs are never uploaded or stored.
- **Large logs:** a 10,000-frame log decodes in well under a second; long result lists fill in progressively.
- **Accuracy:** names and rules follow the public standards. A few table entries we have not yet confirmed against
  the current editions are listed in `docs/VERIFY.md`. Check the standard before relying on a detail in a product.
- **Limits of version 0.1:** no hardware access, no DBC/ODX files, and no J1939, LIN or DoIP. Read-by-identifier responses that ask for several DIDs are split by searching for the requested DIDs,
  because UDS messages carry no data lengths; the decoder says so in a note when it does this.

## Where to find more

- `README.md`: overview and how to build and test.
- `docs/SPEC.md`: the full specification of the decoder, simulator and interface.
- `docs/DECISIONS.md`: choices we made where the specification was silent.
- `docs/VERIFY.md`: items still to check against the standards.
