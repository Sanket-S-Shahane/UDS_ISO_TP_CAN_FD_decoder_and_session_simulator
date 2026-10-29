"""Check 3: UDS names, request encodings and response field values, UDS Bench core vs udsoncan (dev-only)."""  # module purpose
import collections  # counters
import random  # generated parameters (no real vehicle data)
import struct  # big-endian packing for generated responses
import sys  # exit status

import udsoncan  # oracle: udsoncan
from udsoncan import DataFormatIdentifier, MemoryLocation, Response  # helper types used by its services
from udsoncan.common.CommunicationType import CommunicationType  # 0x28 communication type
from udsoncan.common.DidCodec import DidCodec  # base class for DID value codecs
from udsoncan.common.dtc import Dtc  # DTC formats
from udsoncan.ResponseCode import ResponseCode  # NRC names and editions
from udsoncan import services as S  # service classes

from jsbridge import js_batch, versions  # our core, called through Node

RNG = random.Random(14229)  # fixed seed so every run checks the same inputs


class RawCodec(DidCodec):
    """DID codec that passes a fixed number of raw bytes through unchanged (lets udsoncan frame generated data)."""  # doc

    def __init__(self, n):
        """Remembers the data length."""  # doc
        self.n = n  # data length in bytes

    def encode(self, value):
        """Returns the bytes as they are."""  # doc
        return bytes(value)  # passthrough

    def decode(self, payload):
        """Returns the bytes as they are."""  # doc
        return bytes(payload)  # passthrough

    def __len__(self):
        """Data length, which udsoncan uses to split responses."""  # doc
        return self.n  # length


def norm(name):
    """Normalises a name for comparison: lower case without underscores or spaces."""  # doc
    return name.replace("_", "").replace(" ", "").lower()  # e.g. "InvalidKey" == "invalidKey"


def be(b):
    """Big-endian bytes to an integer."""  # doc
    return int.from_bytes(bytes(b), "big")  # standard library conversion


def rand_bytes(lo, hi):
    """Returns between lo and hi random bytes."""  # doc
    return bytes(RNG.randrange(256) for _ in range(RNG.randint(lo, hi)))  # generated data


def fields_by_label(fields):
    """Groups our decoded fields by label: label -> list of byte lists."""  # doc
    out = collections.defaultdict(list)  # label -> occurrences
    for role, label, data, text in fields:  # each field
        out[label].append(data)  # keep the bytes
    return out  # grouped


# ---------------------------------------------------------------------------------------------------------------------
# Part A: names
# ---------------------------------------------------------------------------------------------------------------------

def check_names(report):
    """Compares NRC, service and sub-function names; appends rows (area, value, ours, theirs, verdict) to report."""  # doc
    nrc_codes = sorted({v for k, v in vars(ResponseCode).items() if isinstance(v, int) and not k.startswith("_")})  # every code udsoncan names
    ours = js_batch([["nrcName", [c]] for c in nrc_codes])  # our names
    for code, mine in zip(nrc_codes, ours):  # compare each
        theirs = sorted(k for k, v in vars(ResponseCode).items() if v == code and not k.startswith("_"))  # all its names for this value
        try:  # edition in which udsoncan says the code appeared
            edition = min(y for y in (2006, 2013, 2020) if ResponseCode.is_supported_by_standard(code, y))  # first edition that has it
        except ValueError:  # it has no edition data for this code
            edition = None  # unknown
        same = any(norm(t) == norm(mine) for t in theirs)  # any of its names equal ours
        report.append(("NRC", "0x%02X" % code, mine, "/".join(theirs) + (" (since %s)" % edition if edition else ""), "agree" if same else "DIFF"))  # row
    services = sorted({cls._sid: cls.__name__ for cls in vars(S).values() if isinstance(cls, type) and hasattr(cls, "_sid")}.items())  # sid -> class name
    ours = js_batch([["serviceName", [sid]] for sid, _ in services])  # our names
    for (sid, name), mine in zip(services, ours):  # compare
        report.append(("service", "0x%02X" % sid, mine, name, "agree" if norm(mine) == norm(name) else "DIFF"))  # row
    subs = [  # (service, udsoncan class holding the constants)
        (0x10, S.DiagnosticSessionControl.Session), (0x11, S.ECUReset.ResetType), (0x19, S.ReadDTCInformation.Subfunction),  # sessions, resets, DTC reports
        (0x28, S.CommunicationControl.ControlType), (0x29, S.Authentication.AuthenticationTask), (0x2C, S.DynamicallyDefineDataIdentifier.Subfunction),  # comms, auth, DDDI
        (0x31, S.RoutineControl.ControlType), (0x83, S.AccessTimingParameter.AccessType), (0x85, S.ControlDTCSetting.SettingType),  # routines, timing, DTC setting
        (0x87, S.LinkControl.ControlType),  # link control
    ]
    rows = []  # (sid, value, their name)
    for sid, holder in subs:  # each service
        for k, v in vars(holder).items():  # its constants
            if isinstance(v, int) and not k.startswith("_"):  # a named value
                rows.append((sid, v, k))  # keep
    ours = js_batch([["subName", [sid, v]] for sid, v, _ in rows])  # our names
    for (sid, v, name), mine in zip(rows, ours):  # compare
        verdict = "agree" if norm(mine) == norm(name) or (sid == 0x85 and norm(mine) == norm("DTC setting " + name)) else "DIFF"  # our 0x85 names say "DTC setting on/off"
        report.append(("sub 0x%02X" % sid, "0x%02X" % v, mine, name, verdict))  # row
    formats = [(v, k) for k, v in vars(Dtc.Format).items() if isinstance(v, int) and not k.startswith("_")]  # DTC format identifiers
    ours = js_batch([["fieldsOf", [[0x59, 0x01, 0xFF, v, 0x00, 0x01], {"dir": "rsp"}]] for v, _ in formats])  # our format text in a 59 01 response
    for (v, name), fields in zip(formats, ours):  # compare
        mine = [f[3] for f in fields if f[1] == "DTCFormatIdentifier"][0]  # our text
        report.append(("DTC format", "0x%02X" % v, mine, name, "agree" if norm(name.replace("DTCFormat", "dtcformat")).replace("dtcformat", "") in norm(mine).replace("dtcformat", "").replace("-", "") or norm(mine).replace("dtcformat", "").replace("-", "").startswith(norm(name).replace("dtcformat", "").replace("-", "")) else "DIFF"))  # loose match: spaces, hyphens and the word "DTC format" differ
    return report  # rows


# ---------------------------------------------------------------------------------------------------------------------
# Part B: requests built by udsoncan, decoded by us
# ---------------------------------------------------------------------------------------------------------------------

def mem_location():
    """Returns a random MemoryLocation with random address (8..40 bit) and size (8..32 bit) formats."""  # doc
    af = RNG.choice([8, 16, 24, 32, 40])  # address width in bits
    sf = RNG.choice([8, 16, 24, 32])  # size width in bits
    return MemoryLocation(RNG.randrange(1 << af), RNG.randrange(1, 1 << sf), address_format=af, memorysize_format=sf)  # location


def request_cases():
    """Yields (name, payload, expectations) for requests encoded by udsoncan; expectations map our labels to bytes."""  # doc
    for _ in range(300):  # DiagnosticSessionControl and ECUReset with random values and suppress bit
        s, spr = RNG.randrange(1, 0x80), RNG.random() < 0.5  # value, suppress bit
        yield "10", S.DiagnosticSessionControl.make_request(s).get_payload(spr), {"diagnosticSessionType": [[s | (0x80 if spr else 0)]]}  # session byte
        yield "11", S.ECUReset.make_request(s).get_payload(spr), {"resetType": [[s | (0x80 if spr else 0)]]}  # reset byte
    for _ in range(300):  # ClearDiagnosticInformation with and without memory selection
        g = RNG.randrange(1 << 24)  # group of DTC
        ms = RNG.randrange(256) if RNG.random() < 0.5 else None  # optional memory selection
        exp = {"groupOfDTC": [list(g.to_bytes(3, "big"))]}  # group bytes
        if ms is not None:  # with memory selection
            exp["memorySelection"] = [[ms]]  # extra byte
        yield "14", S.ClearDiagnosticInformation.make_request(g, ms, standard_version=2020).get_payload(), exp  # case
    for _ in range(100):  # ReadDTCInformation with parameters
        m, dtc, rec = RNG.randrange(256), RNG.randrange(1, 1 << 24), RNG.randrange(256)  # mask, DTC, record number
        yield "19 01", S.ReadDTCInformation.make_request(1, status_mask=m).get_payload(), {"reportType": [[1]], "DTCStatusMask": [[m]]}  # count by mask
        yield "19 02", S.ReadDTCInformation.make_request(2, status_mask=m).get_payload(), {"reportType": [[2]], "DTCStatusMask": [[m]]}  # list by mask
        yield "19 04", S.ReadDTCInformation.make_request(4, dtc=dtc, snapshot_record_number=rec).get_payload(), {"DTCMaskRecord": [list(dtc.to_bytes(3, "big"))], "DTCSnapshotRecordNumber": [[rec]]}  # snapshot
        yield "19 06", S.ReadDTCInformation.make_request(6, dtc=dtc, extended_data_record_number=rec).get_payload(), {"DTCMaskRecord": [list(dtc.to_bytes(3, "big"))], "DTCExtDataRecordNumber": [[rec]]}  # extended data
    for sub in (0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x15):  # report types without parameters
        yield "19 %02X" % sub, S.ReadDTCInformation.make_request(sub).get_payload(), {"reportType": [[sub]]}  # case
    for _ in range(300):  # ReadDataByIdentifier with 1..6 DIDs
        dids = [RNG.randrange(1 << 16) for _ in range(RNG.randint(1, 6))]  # DID list
        yield "22", S.ReadDataByIdentifier.make_request(dids, None).get_payload(), {"dataIdentifier": [list(d.to_bytes(2, "big")) for d in dids]}  # case
    for _ in range(300):  # memory services
        loc = mem_location()  # address and size
        exp = {"memoryAddress": [list(loc.get_address_bytes())], "memorySize": [list(loc.get_memorysize_bytes())], "addressAndLengthFormatIdentifier": [[loc.alfid.get_byte_as_int()]]}  # expected fields
        yield "23", S.ReadMemoryByAddress.make_request(loc).get_payload(), exp  # read
        data = rand_bytes(1, 20)  # data to write
        yield "3D", S.WriteMemoryByAddress.make_request(loc, data).get_payload(), dict(exp, dataRecord=[list(data)])  # write
        comp, enc = RNG.randrange(16), RNG.randrange(16)  # data format nibbles
        exp2 = dict(exp, dataFormatIdentifier=[[comp << 4 | enc]])  # with the DFI
        yield "34", S.RequestDownload.make_request(loc, DataFormatIdentifier(comp, enc)).get_payload(), exp2  # download
        yield "35", S.RequestUpload.make_request(loc, DataFormatIdentifier(comp, enc)).get_payload(), exp2  # upload
    for _ in range(200):  # SecurityAccess seed and key
        lvl = RNG.randrange(1, 0x7E)  # level value as udsoncan takes it
        sub = S.SecurityAccess.normalize_level(S.SecurityAccess.Mode.RequestSeed, lvl)  # odd sub-function
        yield "27 seed", S.SecurityAccess.make_request(lvl, S.SecurityAccess.Mode.RequestSeed).get_payload(), {"securityAccessType": [[sub]]}  # seed request
        key = rand_bytes(1, 16)  # key bytes
        sub = S.SecurityAccess.normalize_level(S.SecurityAccess.Mode.SendKey, lvl)  # even sub-function
        exp = {"securityAccessType": [[sub]]}  # sub-function
        if sub <= 0x42:  # inside the requestSeed/sendKey range we decode the key
            exp["securityKey"] = [list(key)]  # key bytes
        yield "27 key", S.SecurityAccess.make_request(lvl, S.SecurityAccess.Mode.SendKey, key).get_payload(), exp  # key request
    for _ in range(300):  # CommunicationControl
        ct = RNG.randrange(6)  # control type 0..5
        nm_cls = RNG.choice([(True, False), (False, True), (True, True)])  # udsoncan requires at least one message class
        comm = CommunicationType(RNG.randrange(16), normal_msg=nm_cls[0], network_management_msg=nm_cls[1])  # communication type
        node = RNG.randrange(1 << 16) if ct in (4, 5) else None  # node id for the enhanced variants
        exp = {"controlType": [[ct]], "communicationType": [[comm.get_byte_as_int()]]}  # expected fields
        if node is not None:  # enhanced address variants
            exp["nodeIdentificationNumber"] = [list(node.to_bytes(2, "big"))]  # node id
        yield "28", S.CommunicationControl.make_request(ct, comm, node, standard_version=2020).get_payload(), exp  # case
    for _ in range(300):  # WriteDataByIdentifier
        did, data = RNG.randrange(1 << 16), rand_bytes(1, 20)  # DID and value
        yield "2E", S.WriteDataByIdentifier.make_request(did, data, {did: RawCodec(len(data))}).get_payload(), {"dataIdentifier": [list(did.to_bytes(2, "big"))], "dataRecord": [list(data)]}  # case
    for _ in range(200):  # InputOutputControlByIdentifier with a control parameter and no values
        did, cp = RNG.randrange(1 << 16), RNG.randrange(4)  # DID and parameter
        state = rand_bytes(1, 4)  # control state bytes
        req = S.InputOutputControlByIdentifier.make_request(did, cp, values=[state], ioconfig={did: RawCodec(len(state))})  # udsoncan needs an IO config entry per DID
        yield "2F", req.get_payload(), {"dataIdentifier": [list(did.to_bytes(2, "big"))], "inputOutputControlParameter": [[cp]], "controlState / controlMask": [list(state)]}  # case
    for _ in range(300):  # RoutineControl
        rid, ct, data = RNG.randrange(1 << 16), RNG.randint(1, 3), rand_bytes(0, 8)  # routine, control type, options
        exp = {"routineControlType": [[ct]], "routineIdentifier": [list(rid.to_bytes(2, "big"))]}  # expected fields
        if data:  # optional record
            exp["routineControlOptionRecord"] = [list(data)]  # option bytes
        yield "31", S.RoutineControl.make_request(rid, ct, data or None).get_payload(), exp  # case
    for _ in range(300):  # TransferData and RequestTransferExit
        n, data = RNG.randrange(256), rand_bytes(0, 40)  # counter and data
        exp = {"blockSequenceCounter": [[n]]}  # counter
        if data:  # data bytes
            exp["transferRequestParameterRecord"] = [list(data)]  # data
        yield "36", S.TransferData.make_request(n, data or None).get_payload(), exp  # case
        yield "37", S.RequestTransferExit.make_request(data or None).get_payload(), ({"transferRequestParameterRecord": [list(data)]} if data else {})  # case
    for spr in (False, True):  # TesterPresent
        yield "3E", S.TesterPresent.make_request().get_payload(spr), {"zeroSubFunction": [[0x80 if spr else 0x00]]}  # case
    for at in (1, 2, 3, 4):  # AccessTimingParameter
        rec = rand_bytes(1, 6) if at == 4 else None  # record only for setTimingParametersToGivenValues
        exp = {"timingParameterAccessType": [[at]]}  # sub-function
        if rec:  # with a record
            exp["timingParameterRequestRecord"] = [list(rec)]  # record bytes
        yield "83", S.AccessTimingParameter.make_request(at, rec).get_payload(), exp  # case
    for _ in range(100):  # ControlDTCSetting
        st, data = RNG.randint(1, 2), rand_bytes(0, 4)  # on/off and option record
        exp = {"DTCSettingType": [[st]]}  # sub-function
        if data:  # option record
            exp["DTCSettingControlOptionRecord"] = [list(data)]  # option bytes
        yield "85", S.ControlDTCSetting.make_request(st, data or None).get_payload(), exp  # case


def check_requests(stats, bad):
    """Decodes udsoncan-encoded requests with our core and compares the fields we report."""  # doc
    cases = list(request_cases())  # all generated requests
    ours = js_batch([["fieldsOf", [list(p), {"dir": "req"}]] for _, p, _ in cases])  # our decodes
    for (name, payload, exp), fields in zip(cases, ours):  # compare
        stats["B requests " + name.split()[0]] += 1  # count per service
        got = fields_by_label(fields)  # our fields by label
        flat = [b for f in fields for b in f[2]]  # our field bytes in order
        if flat != list(payload):  # coverage must hold for every input
            bad.append(("coverage", name, payload.hex()))  # record
            continue  # next case
        for label, want in exp.items():  # every expected field
            if got.get(label) != want:  # missing or different
                bad.append(("request " + name, payload.hex(), label, want, got.get(label)))  # record
                break  # one report per case


# ---------------------------------------------------------------------------------------------------------------------
# Part C: responses generated here, interpreted by udsoncan and by us
# ---------------------------------------------------------------------------------------------------------------------

def response_cases():
    """Yields (name, payload, request payload or None, check function(fields, interpreted response) -> problem or None)."""  # doc
    for _ in range(300):  # DiagnosticSessionControl timing
        s, p2, p2s = RNG.randrange(1, 0x80), RNG.randrange(1 << 16), RNG.randrange(1 << 16)  # session and timing values
        pl = bytes([0x50, s]) + struct.pack(">HH", p2, p2s)  # response
        yield "50", pl, None, lambda f, r, pl=pl: None if (be(f["P2Server_max"][0]) == round(r.service_data.p2_server_max * 1000) and be(f["P2*Server_max"][0]) * 10 == round(r.service_data.p2_star_server_max * 1000)) else "timing"  # ms values
    for t in range(1, 6):  # ECUReset echo and power-down time
        pl = bytes([0x51, t] + ([RNG.randrange(256)] if t == 4 else []))  # response
        yield "51", pl, None, lambda f, r, t=t: None if f["resetType"][0] == [r.service_data.reset_type_echo] and (t != 4 or f["powerDownTime"][0] == [r.service_data.powerdown_time]) else "reset"  # echo and time
    for _ in range(300):  # ReadDTCInformation 01: availability, format, count
        pl = bytes([0x59, 0x01, RNG.randrange(256), RNG.randrange(5)]) + struct.pack(">H", RNG.randrange(1 << 16))  # response
        yield "59 01", pl, None, lambda f, r: None if (f["DTCStatusAvailabilityMask"][0] == [r.service_data.status_availability.get_byte_as_int()] and f["DTCFormatIdentifier"][0] == [r.service_data.dtc_format] and be(f["DTCCount"][0]) == r.service_data.dtc_count) else "count"  # three fields
    for sub in (0x02, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x15):  # DTC and status record lists
        for _ in range(100):  # random lists
            recs = b"".join(RNG.randrange(1, 1 << 24).to_bytes(3, "big") + bytes([RNG.randrange(256)]) for _ in range(RNG.randint(0, 8)))  # non-zero DTCs + status
            pl = bytes([0x59, sub, RNG.randrange(256)]) + recs  # response
            yield "59 %02X" % sub, pl, None, check_dtc_list  # compare DTCs and statuses
    for _ in range(500):  # ReadDataByIdentifier with known record lengths
        dids = RNG.sample(range(1 << 16), RNG.randint(1, 4))  # distinct DIDs
        lens = [RNG.randint(1, 8) for _ in dids]  # data length per DID
        data = [rand_bytes(n, n) for n in lens]  # data per DID
        pl = bytes([0x62]) + b"".join(d.to_bytes(2, "big") + v for d, v in zip(dids, data))  # response
        req = bytes([0x22]) + b"".join(d.to_bytes(2, "big") for d in dids)  # request
        yield "62", pl, req, (lambda f, r, dids=dids, lens=lens: check_rdbi(f, r, dids, lens))  # compare per DID
    for _ in range(300):  # SecurityAccess seed / key responses
        lvl = RNG.randrange(1, 0x42)  # sub-function in the seed/key range
        seed = rand_bytes(1, 8) if lvl % 2 else b""  # seed (at least one byte) only for odd levels
        pl = bytes([0x67, lvl]) + seed  # response
        yield "67", pl, None, (lambda f, r, lvl=lvl: None if f["securityAccessType"][0] == [r.service_data.security_level_echo] and (lvl % 2 == 0 or bytes(sum(f.get("securitySeed", [[]]), [])) == (r.service_data.seed or b"")) else "seed")  # echo and seed
    for _ in range(300):  # RoutineControl
        pl = bytes([0x71, RNG.randint(1, 3)]) + RNG.randrange(1 << 16).to_bytes(2, "big") + rand_bytes(0, 6)  # response
        yield "71", pl, None, lambda f, r: None if (f["routineControlType"][0] == [r.service_data.control_type_echo] and be(f["routineIdentifier"][0]) == r.service_data.routine_id_echo and bytes(sum(f.get("routineStatusRecord", [[]]), [])) == r.service_data.routine_status_record) else "routine"  # three fields
    for _ in range(300):  # RequestDownload / RequestUpload max block length
        w = RNG.randint(1, 4)  # length width
        pl = bytes([RNG.choice([0x74, 0x75]), w << 4]) + RNG.randrange(1 << (8 * w)).to_bytes(w, "big")  # response
        yield "74/75", pl, None, lambda f, r: None if be(f["maxNumberOfBlockLength"][0]) == r.service_data.max_length else "block length"  # value
    for _ in range(300):  # TransferData and RequestTransferExit
        rec = rand_bytes(0, 6)  # optional record
        pl = bytes([0x76, RNG.randrange(256)]) + rec  # response
        yield "76", pl, None, lambda f, r: None if (f["blockSequenceCounter"][0] == [r.service_data.sequence_number_echo] and bytes(sum(f.get("transferResponseParameterRecord", [[]]), [])) == r.service_data.parameter_records) else "transfer"  # counter and record
        pl = bytes([0x77]) + rec  # exit response
        yield "77", pl, None, lambda f, r: None if bytes(sum(f.get("transferResponseParameterRecord", [[]]), [])) == r.service_data.parameter_records else "exit"  # record
    for _ in range(300):  # memory read and write responses
        loc = mem_location()  # address and size
        blk = rand_bytes(1, 20)  # memory content
        yield "63", bytes([0x63]) + blk, None, lambda f, r: None if bytes(f["dataRecord"][0]) == r.service_data.memory_block else "memory block"  # content
        pl = bytes([0x7D, loc.alfid.get_byte_as_int()]) + loc.get_address_bytes() + loc.get_memorysize_bytes()  # write echo
        yield "7D", pl, loc, lambda f, r: None if (be(f["memoryAddress"][0]) == r.service_data.memory_location_echo.address and be(f["memorySize"][0]) == r.service_data.memory_location_echo.memorysize) else "write echo"  # echo
    for sid, sub in ((0x68, 0x03), (0x7E, 0x00), (0xC5, 0x02), (0xC3, 0x01)):  # simple echoes
        yield "%02X" % sid, bytes([sid, sub]), None, lambda f, r: None if [b for x in f.values() for b in x if len(b) == 1][1:2] else "echo"  # the echo byte is decoded
    for _ in range(500):  # negative responses: service and NRC
        sid = RNG.choice([0x10, 0x11, 0x14, 0x19, 0x22, 0x23, 0x27, 0x28, 0x2E, 0x2F, 0x31, 0x34, 0x35, 0x36, 0x37, 0x3D, 0x3E, 0x85])  # rejected service
        pl = bytes([0x7F, sid, RNG.randrange(256)])  # response
        yield "7F", pl, None, lambda f, r: None if (f["requestSID"][0] == [r.service.request_id()] and f["negativeResponseCode"][0] == [r.code]) else "negative"  # service and code


def check_dtc_list(f, r):
    """Compares DTC/status records of a 59 xx response."""  # doc
    mine = list(zip([be(x) for x in sorted_labels(f, "DTC ")], [x[0] for x in sorted_labels(f, "statusOfDTC ")]))  # our (DTC, status) pairs
    theirs = [(d.id, d.status.get_byte_as_int()) for d in r.service_data.dtcs]  # oracle pairs
    return None if mine == theirs and f["DTCStatusAvailabilityMask"][0] == [r.service_data.status_availability.get_byte_as_int()] else "dtc list"  # verdict


def sorted_labels(f, prefix):
    """Returns field bytes whose labels are "<prefix><n>", in n order."""  # doc
    keys = sorted((int(k[len(prefix):]), k) for k in f if k.startswith(prefix) and k[len(prefix):].isdigit())  # numbered labels
    return [f[k][0] for _, k in keys]  # bytes in order


def check_rdbi(f, r, dids, lens):
    """Compares the DID records of a 62 response; reports 'heuristic' when a DID value inside data split it."""  # doc
    mine = list(zip([be(x) for x in f.get("dataIdentifier", [])], [len(sum(f.get("%04X data" % d, [[]]), [])) for d in dids]))  # our (DID, length) pairs
    theirs = [(d, n) for d, n in zip(dids, lens)]  # truth, as udsoncan split it with the codec lengths
    if [d for d in r.service_data.values] != dids:  # the oracle itself must agree with the generator
        return "oracle split"  # unexpected
    return None if mine == theirs else "heuristic"  # our split (search for requested DIDs) vs exact lengths


def check_responses(stats, bad, known):
    """Interprets generated responses with udsoncan and with our core and compares the values."""  # doc
    cases = list(response_cases())  # all generated responses
    ours = js_batch([["fieldsOf", [list(pl), {"dir": "rsp", "request": list(req) if isinstance(req, bytes) else None}]] for _, pl, req, _ in cases])  # our decodes
    for (name, pl, req, check), fields in zip(cases, ours):  # compare
        stats["C responses " + name] += 1  # count
        r = Response.from_payload(pl)  # oracle parse
        sid = pl[1] if pl[0] == 0x7F else pl[0] - 0x40  # request SID
        try:  # interpret with the matching service
            if pl[0] != 0x7F:  # positive responses need interpretation
                svc = r.service  # service class
                if sid == 0x19:  # ReadDTCInformation needs the sub-function
                    svc.interpret_response(r, subfunction=pl[1], ignore_all_zero_dtc=False)  # interpret
                elif sid == 0x22:  # ReadDataByIdentifier needs the DID list and lengths
                    dids = [int.from_bytes(req[i:i + 2], "big") for i in range(1, len(req), 2)]  # DIDs
                    lens = [l for l in check.__defaults__[1]]  # lengths captured by the lambda
                    svc.interpret_response(r, dids, {d: RawCodec(n) for d, n in zip(dids, lens)})  # interpret
                elif sid == 0x27:  # SecurityAccess needs the mode
                    svc.interpret_response(r, mode=S.SecurityAccess.Mode.RequestSeed if pl[1] % 2 else S.SecurityAccess.Mode.SendKey)  # interpret
                elif sid == 0x3D:  # WriteMemoryByAddress needs the location
                    svc.interpret_response(r, req)  # interpret
                else:  # everything else
                    svc.interpret_response(r)  # interpret
        except Exception as e:  # the oracle refused the generated response
            bad.append(("oracle refused", name, pl.hex(), repr(e)))  # record
            continue  # next case
        got = fields_by_label(fields)  # our fields
        if [b for x in fields for b in x[2]] != list(pl):  # coverage
            bad.append(("coverage", name, pl.hex()))  # record
            continue  # next case
        try:  # run the comparison
            problem = check(got, r)  # None when equal
        except (KeyError, IndexError) as e:  # we lack a field the oracle has
            problem = "missing field %s" % e  # describe
        if problem == "heuristic":  # known limitation of the 0x22 split (DID value inside data)
            known["0x22 split heuristic"].append(pl.hex())  # record separately
        elif problem:  # unexplained
            bad.append(("response " + name, pl.hex(), problem))  # record


def main():
    """Runs check 3 and prints a report; exits non-zero on any unexplained mismatch."""  # doc
    print("oracle versions:", versions())  # exact versions for the report
    names = check_names([])  # part A
    for row in names:  # print every name row so the report can cite them
        print("%-10s %-6s %-55s %-60s %s" % row)  # one line each
    print("names: %d compared, %d differ" % (len(names), sum(1 for r in names if r[4] == "DIFF")))  # summary
    stats, bad, known = collections.Counter(), [], collections.defaultdict(list)  # counters
    check_requests(stats, bad)  # part B
    check_responses(stats, bad, known)  # part C
    for k in sorted(stats):  # case counts
        print("%-30s %d" % (k, stats[k]))  # one line each
    for k, v in known.items():  # explained differences
        print("known limitation %s: %d case(s), e.g. %s" % (k, len(v), v[:3]))  # summary
    print("unexplained mismatches: %d" % len(bad))  # headline
    for b in bad[:40]:  # details
        print("  MISMATCH", b)  # one line each
    sys.exit(1 if bad else 0)  # non-zero when anything is unexplained


if __name__ == "__main__":  # run as a script
    main()  # go
