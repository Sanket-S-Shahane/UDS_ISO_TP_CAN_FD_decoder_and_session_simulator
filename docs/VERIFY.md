# Items to verify against the standard

Every table value, bit position or rule that was not certain gets a line here and a `// VERIFY` marker in the code.
Format: item, what was assumed, why it is uncertain.

## src/core.js

| Item | What we assumed | Why we are unsure |
|---|---|---|
| 0x19 sub-function 0x16 | `reportDTCExtDataRecordByRecordNumber` | Name and edition from memory of the 2013 and 2020 editions |
| 0x19 sub-functions 0x17..0x19 | `reportUserDefMemoryDTC...` names | Long names recalled from memory, not checked against the text |
| 0x19 sub-function 0x1A | `reportSupportedDTCExtDataRecord` | Believed to be new in the 2020 edition |
| 0x19 sub-functions 0x42, 0x55 | WWH-OBD report types | Names recalled from memory |
| 0x19 sub-function 0x56 | `reportDTCInformationByDTCReadinessGroupIdentifier` | Believed to be new in the 2020 edition |
| 0x29 Authentication sub-functions 0x00..0x08 | names as in the code | 2020 edition service; names recalled from memory |
| 0x86 ResponseOnEvent event types | 00, 01, 03..07 named; 02 omitted | Event type list changed between 2013 and 2020 |
| NRC 0x34 | `authenticationRequired` | Added in the 2020 edition |
| NRC 0x50..0x5D | certificate / ownership / authentication failures | 2020 edition; exact spellings recalled from memory |
| NRC 0x94 | `resourceTemporarilyNotAvailable` | 2020 edition; older editions reserve it (see spec question S1) |
| NRC 0x95..0xEF | `reservedForSpecificConditionsNotCorrect` | Range boundaries depend on the edition |
| NRC 0xF0..0xFE | `vehicleManufacturerSpecificConditionsNotCorrect` | 2020 edition range |
| DTCFormatIdentifier 0x04 | `SAE J2012-DA DTC format 04` | Name recalled from memory |
| DID 0xF18F | `ISOSAEReservedStandardized` | The 2020 edition may assign a meaning |
| DIDs 0xF400..0xF8FF | one generic "OBD / emissions-related" name | The standard splits this range into several OBD sub-ranges |
| DID 0xFF00 | `UDSVersionDataIdentifier` | Recalled from memory |
| RIDs 0xE000..0xE1FF | "OBD test identifier" | Range boundary recalled from memory |
| RIDs 0xF000..0xFEFF | "system-supplier specific" | Range boundary recalled from memory |
| Session types 0x40..0x5F / 0x60..0x7E | vehicle-manufacturer / system-supplier specific | Ranges recalled from memory |
| SecurityAccess 0x5F / 0x60 | "ISO 26021-2 value" | Recalled from memory |
| SecurityAccess 0x61..0x7E | system-supplier specific | Recalled from memory |
| CommunicationControl subnet nibble 0 and F | 0 = all networks, F = network the request was received on | Recalled from memory |

## Spec and vector questions

If a vector in `TEST_VECTORS.md` or a statement in `SPEC.md` looks wrong, record it here with the reasoning. Do not edit the vector silently.

**S1. Reserved NRC range `0x94..0xFE` (SPEC section 6).** The spec lists `0x94..0xFE` as a reserved range. In the 2020
edition of ISO 14229-1 we believe `0x94` is `resourceTemporarilyNotAvailable`, `0x95..0xEF` are reserved for specific
conditions and `0xF0..0xFE` are manufacturer specific. We implemented the 2020 reading; every value still gets a name,
which is what the spec asks for. No test depends on it.
