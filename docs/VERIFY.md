# Items to verify against the standard

Every table value, bit position or rule that was not certain gets a line here and a `// VERIFY` marker in the code.
Format: item, what was assumed, why it is uncertain.

## Status after the cross-check

`docs/CROSSCHECK.md` compares these items with independent libraries. Status values: **confirmed by** a package (the
`// VERIFY` marker was removed), **disagrees** (marker kept or added; the library has a different name or meaning), or
**no independent evidence** (marker kept). A library agreeing is evidence, not the standard: these rows are still not
checked against the ISO text itself.

## src/core.js

| Item | What we assumed | Why we are unsure | Cross-check status |
|---|---|---|---|
| 0x19 sub-function 0x16 | `reportDTCExtDataRecordByRecordNumber` | Recalled from memory | confirmed by udsoncan 1.26.1 (marker removed) |
| 0x19 sub-functions 0x17..0x19 | `reportUserDefMemoryDTC...` names | Recalled from memory | confirmed by udsoncan 1.26.1 (marker removed) |
| 0x19 sub-function 0x1A | `reportSupportedDTCExtDataRecord` | Believed new in the 2020 edition | confirmed by udsoncan 1.26.1 (name only; marker removed) |
| 0x19 sub-functions 0x42, 0x55 | WWH-OBD report types | Recalled from memory | confirmed by udsoncan 1.26.1 (marker removed) |
| 0x19 sub-function 0x56 | `reportDTCInformationByDTCReadinessGroupIdentifier` | Believed new in the 2020 edition | confirmed by udsoncan 1.26.1 (name only; marker removed) |
| 0x19 sub-function 0x05 | `reportDTCStoredDataByRecordNumber` | Name changed between editions (as we recall) | **disagrees**: udsoncan 1.26.1 has `reportDTCSnapshotRecordByRecordNumber`; possibly the older name. Marker added |
| 0x19 sub-functions 0x06, 0x10 | `...ExtDataRecord...` | Spelling | **disagrees**: udsoncan 1.26.1 spells `...ExtendedDataRecord...`. Marker added |
| 0x19 sub-function 0x0A | `reportSupportedDTC` | Spelling | **disagrees**: udsoncan 1.26.1 has `reportSupportedDTCs`. Marker added |
| 0x19 sub-functions 0x0F, 0x11 | mirror-memory names (were missing; added in the cross-check) | Recalled from memory | confirmed by udsoncan 1.26.1 (no marker) |
| 0x19 sub-functions 0x12, 0x13 | `...EmissionsOBDDTC...` (were missing; added) | Recalled from memory | **disagrees**: udsoncan 1.26.1 has `...EmissionsRelatedOBDDTC...`. Marker added |
| 0x29 Authentication sub-functions 0x00..0x08 | names as in the code | 2020 edition service | confirmed by udsoncan 1.26.1 (all nine; marker removed) |
| 0x87 LinkControl sub-functions 0x01..0x03 | `verifyModeTransitionWith...`, `transitionMode` | Not marked before | **disagrees**: udsoncan 1.26.1 has the `...BaudrateTransition...` names, which we believe are the older edition's. Marker added |
| 0x86 ResponseOnEvent event types | 00, 01, 03..07 named; 02 omitted | Edition changes | no independent evidence (udsoncan 1.26.1 has no event-type table) |
| NRC 0x34 | `authenticationRequired` | 2020 edition | confirmed by udsoncan 1.26.1, which dates it to 2020 (marker removed) |
| NRC 0x50..0x5D except 0x57 | certificate / ownership / authentication failures | Spellings recalled | confirmed by udsoncan 1.26.1, dated 2020 (marker removed) |
| NRC 0x57 | `certificateVerificationFailedInvalidCertificateRevoked` | Spelling | **disagrees**: udsoncan 1.26.1 has `..._InvalidCertificate`. Marker kept |
| NRC 0x94 | `resourceTemporarilyNotAvailable` | 2020 edition | confirmed by udsoncan 1.26.1, dated 2020 (marker removed) |
| NRC 0x36 | `exceededNumberOfAttempts` | Not marked before | **disagrees**: udsoncan 1.26.1 spells `ExceedNumberOfAttempts`. Marker added |
| NRC 0x8F | `brakeSwitchesNotClosed` | Not marked before | **disagrees**: udsoncan 1.26.1 spells `BrakeSwitchNotClosed`. Marker added |
| NRC 0x38..0x4F | one range name, `reservedByExtendedDataLinkSecurityDocument` | Not marked before | **disagrees** in part: udsoncan 1.26.1 names 0x38..0x40 after ISO 15764 and also gives 0x38..0x3A 2020 "secure data transmission" names (it defines two names for those three values). Marker added |
| NRC 0x95..0xEF | `reservedForSpecificConditionsNotCorrect` | Range boundaries | no independent evidence |
| NRC 0xF0..0xFE | `vehicleManufacturerSpecificConditionsNotCorrect` | 2020 edition range | no independent evidence |
| DTCFormatIdentifier 0x00..0x04 | names as in the code | 0x04 recalled | confirmed by udsoncan 1.26.1 (marker removed) |
| DID 0xF18F | `ISOSAEReservedStandardized` | Edition differences | no independent evidence (no oracle has a DID name table) |
| DIDs 0xF400..0xF8FF | one generic OBD name | Sub-ranges | no independent evidence |
| DID 0xFF00 | `UDSVersionDataIdentifier` | Recalled | no independent evidence |
| RIDs 0xE000..0xE1FF, 0xF000..0xFEFF | range names | Boundaries | no independent evidence |
| Session types 0x40..0x7E | manufacturer / supplier ranges | Recalled | no independent evidence (udsoncan only names 0x01..0x04, which agree) |
| SecurityAccess 0x5F..0x7E | ISO 26021-2 value, supplier specific | Recalled | no independent evidence (udsoncan validates levels 0x01..0x7E but names none) |
| CommunicationControl subnet nibble 0 and F | 0 = all networks, F = network the request was received on | Recalled | no independent evidence: udsoncan 1.26.1 labels 0 `node` and F `network` without defining them; inconclusive |

## src/sim.js

| Item | What we assumed | Why we are unsure | Cross-check status |
|---|---|---|---|
| Suppress bit with response pending | Final positive response is still sent after `0x78` | Recalled from ISO 14229-1 | no independent evidence (no oracle simulates a server) |
| S3 restart after pending | S3 restarts at the final response | ISO 14229-2 timing recalled (DECISIONS D15) | no independent evidence |

## Also confirmed (never marked VERIFY)

- OBD-II PID formulas, supported-PID bit order, 2-byte DTC letters and digits, Mode 03 count byte: python-OBD 0.7.3.
- Service names for every SID udsoncan implements; session, reset, communication-control, DynamicallyDefineDataIdentifier,
  routine-control, timing-parameter and DTC-setting sub-function names; DTC status bits in every 0x59 record:
  udsoncan 1.26.1.
- ISO-TP framing rules (SF/FF/CF/FC layout, 12-bit and escaped 32-bit lengths, CAN FD escape SF, padding to legal DLC
  sizes): can-isotp 2.0.7, apart from the policy differences P1 and F1–F5 in CROSSCHECK.md.

## Spec and vector questions

If a vector in `TEST_VECTORS.md` or a statement in `SPEC.md` looks wrong, record it here with the reasoning. Do not edit the vector silently.

**S2. Vector 5.2.3 (lockout) needs keep-alives.** "After 10 000 ms the seed request works again": the flow runs in the
extended session (SecurityAccess is refused in the default session), and S3 is 5000 ms, so without TesterPresent the
session would expire before the lockout ends and `27 01` would return `7F 27 7F`. Our test sends `3E 80` at 4000 ms and
8000 ms. The vector itself is fine; it just leaves this out.

**S1. Reserved NRC range `0x94..0xFE` (SPEC section 6).** The spec lists `0x94..0xFE` as a reserved range. In the 2020
edition of ISO 14229-1 we believe `0x94` is `resourceTemporarilyNotAvailable`, `0x95..0xEF` are reserved for specific
conditions and `0xF0..0xFE` are manufacturer specific. We implemented the 2020 reading; every value still gets a name,
which is what the spec asks for. No test depends on it. Cross-check: udsoncan 1.26.1 also dates 0x94
`ResourceTemporarilyNotAvailable` to the 2020 edition, which supports this reading (evidence, not the standard).

**S3. A 4-bit SF_DL in a CAN FD frame longer than 8 bytes (TEST_VECTORS 2.4).** The vector asks us to decode the payload
and warn. can-isotp 2.0.7 drops such a frame, and its error text says the length must use the escape form when CAN_DL > 8.
If ISO 15765-2 requires the receiver to ignore the frame, the vector is more lenient than the standard. We kept the
vector (a decoder that shows the bytes with a warning is still useful) and record the question here.
