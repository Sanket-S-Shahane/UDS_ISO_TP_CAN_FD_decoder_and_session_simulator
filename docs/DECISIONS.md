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
