"""Check 6: Vector ASC CAN FD records and PCAN-View .trc files, UDS Bench parseLog() vs python-can's readers (dev-only)."""  # module purpose
import collections  # counters
import io  # in-memory files
import logging  # used only to silence the readers' per-line messages
import os  # temporary files for the writers
import random  # generated frames (no real vehicle data)
import sys  # exit status
import tempfile  # TRCWriter needs a real file
from datetime import datetime, timedelta, timezone  # TRC start-time header

import can  # oracle: python-can
from can.io.asc import ASCReader, ASCWriter  # Vector ASC
from can.io.trc import TRCFileVersion, TRCReader, TRCWriter  # PCAN-View trace

from jsbridge import js_batch, versions  # our core, called through Node

logging.disable(logging.CRITICAL)  # the readers log every skipped line; the report below is enough
RNG = random.Random(2026)  # fixed seed so every run checks the same inputs
FD_SIZES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64]  # legal CAN FD data lengths
START = 1761652800.0  # generated start time (seconds since 1970) for the trace headers


def random_message(t, allow_fd=True):
    """Returns a random python-can Message at time t (classic, or CAN FD with or without BRS)."""  # doc
    ext = RNG.random() < 0.4  # 29-bit?
    fd = allow_fd and RNG.random() < 0.5  # CAN FD?
    n = RNG.choice(FD_SIZES[1:]) if fd else RNG.randint(1, 8)  # data length (at least one byte)
    return can.Message(  # the message
        timestamp=t, arbitration_id=RNG.randrange(1 << 29) if ext else RNG.randrange(1 << 11), is_extended_id=ext,  # identity
        is_fd=fd, bitrate_switch=fd and RNG.random() < 0.5, data=bytes(RNG.randrange(256) for _ in range(n)),  # content
        is_rx=RNG.random() < 0.5, channel=RNG.randint(0, 3),  # direction and channel
    )


def oracle_fields(m):
    """The fields we compare, from a python-can Message."""  # doc
    return {"time": m.timestamp, "id": m.arbitration_id, "ext": m.is_extended_id, "fd": m.is_fd, "brs": m.bitrate_switch, "data": list(m.data)}  # fields


def our_fields(f):
    """The same fields from one of our frames."""  # doc
    return {"time": f["time"], "id": f["id"], "ext": f["ext"], "fd": f["fd"], "brs": f["brs"], "data": f["data"]}  # fields


def compare(name, text, reader, stats, bad):
    """Parses the same file text with python-can and with our parseLog(), frame by frame."""  # doc
    theirs = [oracle_fields(m) for m in reader(io.StringIO(text))]  # oracle frames, in order
    parsed = js_batch([["parseLog", [text]]])[0]  # our parse
    ours = [our_fields(f) for f in parsed["frames"]]  # our frames, in order
    stats[name + " frames"] += len(theirs)  # count
    if len(ours) != len(theirs):  # different number of frames
        bad.append((name, "frame count", len(ours), len(theirs), [i["text"][:60] + " | " + i["reason"] for i in parsed["ignored"]][:3]))  # record
        return  # nothing more to compare
    for a, b in zip(ours, theirs):  # frame by frame
        same = all(a[k] == b[k] for k in ("id", "ext", "fd", "brs", "data")) and abs(a["time"] - b["time"]) < 1e-6  # time within a microsecond
        if not same:  # disagreement
            bad.append((name, a, b))  # record
            return  # one report per file is enough


def asc_files():
    """Yields (name, text): ASC files written by python-can's ASCWriter, plus a base-dec file written to its reader's split."""  # doc
    for k in range(20):  # 20 files of 200 frames, classic and CAN FD mixed
        path = tempfile.mktemp(suffix=".asc")  # the writer wants a path or file
        with ASCWriter(path) as w:  # python-can's own writer
            for i in range(200):  # frames
                w.on_message_received(random_message(i * 0.001 + k))  # write
        with open(path) as fh:  # read the text back
            yield "asc writer", fh.read()  # file text
        os.remove(path)  # clean up
    lines = ["date Wed Oct 28 12:00:00.000 pm 2026", "base dec  timestamps absolute", "no internal events logged"]  # decimal-base header
    for i in range(300):  # hand-written lines in decimal, split exactly as ASCReader splits them
        m = random_message(i * 0.002)  # frame
        sid = str(m.arbitration_id) + ("x" if m.is_extended_id else "")  # decimal ID
        data = " ".join(str(b) for b in m.data)  # decimal bytes
        if m.is_fd:  # CANFD record: channel dir id brs esi dlc len data
            dlc = FD_SIZES.index(len(m.data))  # DLC code for the length
            lines.append("%f CANFD %d %s %s %d 0 %d %d %s" % (m.timestamp, m.channel + 1, "Rx" if m.is_rx else "Tx", sid, int(m.bitrate_switch), dlc, len(m.data), data))  # line
        else:  # classic record
            lines.append("%f %d %s %s d %d %s" % (m.timestamp, m.channel + 1, sid, "Rx" if m.is_rx else "Tx", len(m.data), data))  # line
    yield "asc base dec (hand-written)", "\n".join(lines) + "\n"  # file text


def trc_files():
    """Yields (name, text): TRC files from python-can's TRCWriter (1.0 and 2.1, classic) and hand-written 1.1 / 2.0 / 2.1 CAN FD files."""  # doc
    for version in (TRCFileVersion.V1_0, TRCFileVersion.V2_1):  # the two versions the writer supports
        for k in range(10):  # 10 files each
            path = tempfile.mktemp(suffix=".trc")  # the writer needs a real file
            with TRCWriter(path) as w:  # python-can's own writer
                w.file_version = version  # choose the format
                for i in range(200):  # frames (the writer cannot write CAN FD types)
                    w.on_message_received(random_message(START + k + i * 0.001, allow_fd=False))  # write
            with open(path) as fh:  # read the text back
                yield "trc writer %s" % version.name, fh.read()  # file text
            os.remove(path)  # clean up
    days = (datetime.fromtimestamp(START, timezone.utc) - datetime(1899, 12, 30, tzinfo=timezone.utc)) / timedelta(days=1)  # start time in days, as the header stores it
    v11 = [";$FILEVERSION=1.1", ";$STARTTIME=%r" % days, ";   Message Number", ";   |         Time Offset (ms)"]  # 1.1 header
    for i in range(300):  # hand-written 1.1 lines, split as TRCReader._parse_msg_v1_1 reads them
        m = random_message(i * 1.5, allow_fd=False)  # classic only (1.1 has no CAN FD)
        sid = "%08X" % m.arbitration_id if m.is_extended_id else "%04X" % m.arbitration_id  # ID width decides 11/29 bit
        v11.append("%6d) %11.1f  %s %8s  %d  %s" % (i + 1, m.timestamp, "Rx" if m.is_rx else "Tx", sid, len(m.data), " ".join("%02X" % b for b in m.data)))  # line
    yield "trc 1.1 (hand-written)", "\n".join(v11) + "\n"  # file text
    v13 = [";$FILEVERSION=1.3", ";$STARTTIME=%r" % days]  # 1.3 header
    for i in range(300):  # hand-written 1.3 lines, split as TRCReader._parse_msg_v1_3 reads them
        m = random_message(i * 2.0, allow_fd=False)  # classic only
        sid = "%08X" % m.arbitration_id if m.is_extended_id else "%04X" % m.arbitration_id  # ID width decides 11/29 bit
        v13.append("%6d) %11.1f %d  %s %8s -  %d  %s" % (i + 1, m.timestamp, m.channel + 1, "Rx" if m.is_rx else "Tx", sid, len(m.data), " ".join("%02X" % b for b in m.data)))  # line
    yield "trc 1.3 (hand-written)", "\n".join(v13) + "\n"  # file text
    for ver, cols in (("2.0", "N,O,T,I,d,l,D"), ("2.1", "N,O,T,B,I,d,R,L,D")):  # the 2.0 default columns and the 2.1 columns the writer uses
        lines = [";$FILEVERSION=" + ver, ";$STARTTIME=%r" % days, ";$COLUMNS=" + cols, ";"]  # header
        names = cols.split(",")  # column letters
        for i in range(400):  # hand-written lines with CAN FD types, split as TRCReader._parse_msg_v2_x reads them
            m = random_message(i * 0.25)  # classic or FD
            typ = ("FB" if m.bitrate_switch else "FD") if m.is_fd else "DT"  # record type
            val = {"N": str(i + 1), "O": "%.3f" % m.timestamp, "T": typ, "B": str(m.channel + 1), "I": "%08X" % m.arbitration_id if m.is_extended_id else "%04X" % m.arbitration_id,  # columns
                   "d": "Rx" if m.is_rx else "Tx", "R": "-", "L": str(FD_SIZES.index(len(m.data))), "l": str(len(m.data)), "D": " ".join("%02X" % b for b in m.data)}  # columns
            lines.append(" ".join(val[c] for c in names))  # line
        lines.append("%d %.3f ER 0300 Rx 4 00 00 00 00" % (999, 999.0) if ver == "2.0" else "999 999.000 ST 1 Rx - 0")  # a non-data record both readers must skip
        yield "trc %s FD (hand-written)" % ver, "\n".join(lines) + "\n"  # file text


def main():
    """Runs the format check and prints a report; exits non-zero on any mismatch."""  # doc
    print("oracle versions:", versions())  # exact versions for the report
    stats, bad = collections.Counter(), []  # counters and mismatches
    for name, text in asc_files():  # ASC
        compare(name, text, ASCReader, stats, bad)  # compare
    for name, text in trc_files():  # TRC
        compare(name, text, TRCReader, stats, bad)  # compare
    for k in sorted(stats):  # counts
        print("%-36s %d" % (k, stats[k]))  # one line each
    print("mismatches: %d" % len(bad))  # headline
    for b in bad[:20]:  # details
        print("  MISMATCH", b)  # one line each
    sys.exit(1 if bad else 0)  # non-zero on any mismatch


if __name__ == "__main__":  # run as a script
    main()  # go
