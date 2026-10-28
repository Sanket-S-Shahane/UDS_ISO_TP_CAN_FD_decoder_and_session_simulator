# Decisions

One entry per decision the spec did not cover. Format: decision, alternatives considered, reason.

## Tooling

**D1. Test script is `node --test test/*.test.js`.**
Alternatives: `node --test test/` as written in PROMPT.md. Reason: Node 22 treats a directory argument as a module path and
fails with MODULE_NOT_FOUND. The unquoted glob is expanded by the shell that npm uses, so it works on Node 20 and 22.

**D2. Data tables share one comment per table.**
Alternatives: a trailing comment on every table row. Reason: rows such as `0x11: 'ECUReset'` explain themselves; a comment
per row would double the table size without adding information. Every code line still has its own comment, and rows we
are unsure of carry a `// VERIFY` marker.

## Parsing and ISO-TP

**D3. Frame `index` is 0-based (array position).**
Alternatives: 1-based like line numbers. Reason: it indexes `frames[]` and `timeline[]` directly. The UI shows `index + 1`.
Vector 2.2 says "frames 2, 4 and 5" in 1-based terms; the test checks `frameIdx` `[1, 3, 4]`.

**D4. Direction priority: user ID lists → known diagnostic IDs → ASC Tx/Rx hint → payload inference.**
Alternatives: let the ASC hint win over the ID. Reason: the spec puts `classifyId` first; the ASC hint depends on which side
recorded the log, so it is a weaker signal than a well-known ID.

**D5. Non-diagnostic traffic is skipped when the log contains diagnostic IDs.**
Alternatives: treat every frame as ISO-TP. Reason: real logs carry cyclic application frames; interpreting them as ISO-TP
produces pages of false errors. When at least one frame has a known request/response ID (or a user-listed ID), frames on
other IDs get timeline kind `--`, level `info`, text "not a diagnostic ID, skipped". When no frame has a known ID, every
frame is decoded (useful for logs on unusual IDs before the user enters their ID lists).

**D6. ID width.** 8 hex digits, or any value above `0x7FF`, is 29-bit; otherwise 11-bit. Reason: the spec only defines 3 and
8 digits; this keeps other widths usable instead of rejecting them. IDs above `0x1FFFFFFF` are ignored as malformed.

**D7. A Single Frame on an ID with an open multi-frame transfer discards the transfer with a warning.**
Alternatives: emit the open transfer as partial. Reason: ISO 15765-2 has the receiver abandon the reception; this mirrors
the spec's rule for a new First Frame.

**D8. A First Frame whose FF_DL fits inside the FF itself is emitted as a complete message with a warning.**
Alternatives: treat as error and drop. Reason: the bytes are all there and decodable; the warning tells the user the
sender should have used a Single Frame.

**D9. Lines in the ASC header (`date`, `base hex`, `Begin Triggerblock`, ...) are listed as ignored.**
Alternatives: silently skip known ASC keywords. Reason: the spec says every non-matching line goes to `ignored`; the list is
collapsed by default in the UI, so it costs nothing.

## UDS decoding

**D10. Summary style for DID services: DID numbers in the summary, names in the fields.**
Vector 3 gives `WriteDataByIdentifier · F198` exactly, so `0x22`/`0x2E` summaries list DID numbers (plus the text value for
text DIDs in a response) and the DID names appear in the field table.

**D11. `0x22` record splitting uses the earliest position of any later requested DID (at least one data byte after the
current DID).** Alternatives: look only for the immediately next requested DID. Reason: ECUs (including our simulator)
omit unsupported DIDs, so the next record may belong to any later DID in the request.

**D12. Message kind is decided by the first byte when the byte is a known SID** (request SIDs and response SIDs never
overlap); the direction is only used for unknown bytes. Reason: robust against wrong ID lists.

**D13. NRC names follow the 2020 edition of ISO 14229-1** (authentication codes `0x34`, `0x50..0x5D`, `0x94`
resourceTemporarilyNotAvailable, `0xF0..0xFE` manufacturer specific). The spec groups `0x94..0xFE` as reserved, which is
the 2013 wording; see `docs/VERIFY.md`.

## Simulator

**D14. Ordinary responses are scheduled 2 ms after the request (`responseMs`).** Alternatives: 0 ms. Reason: a zero
latency looks wrong in the decoder; 2 ms is well inside P2 (50 ms). The pending-response times (50 / 4050 / 7000 ms) are
exact as the spec gives them.

**D15. The S3 timer restarts when a request is received; after a response-pending sequence it restarts at the final
response.** Alternatives: always at request time. Reason: the erase routine answers after 7000 ms, longer than S3
(5000 ms); without this the programming session would expire while the ECU is still busy, and ISO 14229-2 starts S3 after
the response is complete. Vector 5.3 is unaffected (no pending responses there).

**D16. Check order for `0x2E` follows the table (length, DID, session, data length, security)**, as SPEC section 8 says
the table wins over the generic order. For services whose table row starts with the session (0x27, 0x28, 0x34, 0x36,
0x37, 0x85) the session is checked first.

**D17. A second `0x34` while a download is active returns `0x22` conditionsNotCorrect**, checked last so vector 5.4.5
(address out of range → `0x31`) still holds. The spec does not cover it.

**D18. Leaving the programming session discards the download; entering the default session (by request, S3 or reset)
restores communication control, turns DTC setting back on and returns the demo LED to ECU control.** The spec only says
"restore communication control" for S3; ISO 14229-1 resets these on a transition to the default session.

**D19. DID `0300` (the demo LED driven by `0x2F`) is also readable with `0x22`.** Reason: lets users see the effect of
the IO control. All other DIDs are exactly the spec list.

**D20. With the suppress bit set on `31 01 FF 00` the final positive response is still sent**, because response-pending
was sent first (ISO 14229-1 behaviour as we understand it; see VERIFY).

**D21. Exchange driver timing:** the receiver's Flow Control comes 1 ms after a First Frame; Consecutive Frames are spaced
by STmin (at least 0.2 ms); the ECU's responses start at the last request frame time + `delayMs`. A functional request
that does not fit in one Single Frame is refused with an event (ISO-TP functional addressing allows single frames only).
A request on ID `0x7DF` (or `0x18DB33F1`) counts as functional. The tester's flow control for a response always goes to
the physical request ID. Default padding is `0xAA`. With extended addressing the ECU's frames use address byte `F1`
unless `rspExtAddr` is given.

## Interface and build

**D22. Example logs live only in `examples/*.log`; the build injects them through an extra `{{EXAMPLES}}` placeholder**
(JSON in a `<script type="application/json">`, with `<` escaped). Alternatives: copy the logs into `ui.js`. Reason: one
source for the files and the picker, as Phase 4 asks. The basic and CAN FD examples were recorded from our own simulator.

**D23. Quick buttons send immediately**; "27 02 + key" uses the pending seed (zeros when there is none, which the ECU
rejects with `0x24`, a useful lesson), and "36 next block" builds the next TransferData block of the active download.
The "Put 27 02 + key in the composer" button fills the input instead of sending.

**D24. Keep-alive traffic is logged compactly**: one separator line per run ("3E 80 sent ×N") instead of a card every
2 s. Its frames still go to the frame log, because they are real bus traffic.

**D25. The timeline renders the first 1,000 rows and offers "Show all N frames"; messages render in chunks of 200 per
animation frame.** Reason: 10,000-row tables block the main thread; the decode itself stays under the 1 s budget.

**D26. Theme toggle cycles auto → dark → light** and is remembered in `localStorage` when storage is available. Auto
follows `prefers-color-scheme`; the CSS keeps the dark values on bare `:root` as the spec asks.

**D27. Below 560 px the field table stacks each field** (role, label, copy on one line; bytes and meaning below), so the
meaning is readable on phones without scrolling the table sideways.
