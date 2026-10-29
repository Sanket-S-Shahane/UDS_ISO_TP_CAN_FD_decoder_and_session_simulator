"""Check 4: log parsing, UDS Bench parseLog() vs python-can's candump -L and Vector ASC readers (dev-only)."""  # module purpose
import collections  # counters
import io  # in-memory files for the readers
import random  # generated log lines (no real vehicle data)
import sys  # exit status

import can  # oracle: python-can
from can.io.asc import ASCReader  # Vector ASC reader
from can.io.canutils import CanutilsLogReader  # candump -L reader

from jsbridge import js_batch, versions  # our core, called through Node

RNG = random.Random(4)  # fixed seed so every run checks the same inputs
FD_SIZES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64]  # legal CAN FD data lengths
ASC_HEADER = "date Wed Oct 28 12:00:00.000 pm 2026\nbase hex  timestamps absolute\nno internal events logged\n"  # generated header


def case(s):
    """Randomly changes the letter case of hex text (both parsers must accept either)."""  # doc
    return s.upper() if RNG.random() < 0.5 else s.lower()  # upper or lower


def hexs(data):
    """Bytes to contiguous hex."""  # doc
    return "".join("%02X" % b for b in data)  # two digits per byte


def candump_lines():
    """Yields (kind, line): canonical candump -L lines plus edge cases."""  # doc
    for _ in range(4000):  # canonical lines
        ext = RNG.random() < 0.4  # 29-bit?
        cid = RNG.randrange(1 << 29) if ext else RNG.randrange(1 << 11)  # identifier
        sid = "%08X" % cid if ext else "%03X" % cid  # candump ID width
        fd = RNG.random() < 0.4  # CAN FD?
        data = bytes(RNG.randrange(256) for _ in range(RNG.choice(FD_SIZES) if fd else RNG.randint(0, 8)))  # payload
        body = "#" + "%X" % RNG.randint(0, 3) + hexs(data) if fd else hexs(data)  # FD: flags digit (BRS, ESI) then data
        t = "%.6f" % (RNG.randrange(10 ** 10) / 1e6)  # timestamp text
        ch = RNG.choice(["can0", "can1", "vcan0", "can10"])  # interface
        suffix = RNG.choice(["", "", " R", " T"])  # newer candump direction marker
        yield "canonical", "(%s) %s %s#%s%s" % (t, ch, case(sid), case(body), suffix)  # line
    for n in range(4, 8):  # IDs with 4..7 digits (candump never writes them; tests decision D6)
        yield "id width %d" % n, "(1.000000) can0 %s#0102" % ("7E0".rjust(n, "0"))  # small value, wide text
    yield "remote", "(1.000000) can0 7E0#R"  # remote frame
    yield "fd flags A", "(1.000000) can0 7E0##A0102"  # flags digit above 9
    yield "classic > 8 bytes", "(1.000000) can0 7E0#000102030405060708090A0B"  # 12 bytes after a single #
    yield "odd digits", "(1.000000) can0 7E0#021003000000000"  # malformed data


def asc_lines():
    """Yields (kind, line): canonical Vector ASC classic lines plus edge cases."""  # doc
    for _ in range(4000):  # canonical lines
        ext = RNG.random() < 0.4  # 29-bit?
        cid = RNG.randrange(1 << 29) if ext else RNG.randrange(1 << 11)  # identifier
        sid = "%X" % cid + ("x" if ext else "")  # ASC writes the ID without padding, x marks 29-bit
        data = [RNG.randrange(256) for _ in range(RNG.randint(0, 8))]  # payload
        tail = RNG.choice(["", "  Length = 0 BitCount = 0 ID = %d%s" % (cid, "x" if ext else "")])  # optional trailing fields
        line = "%11.6f %d  %-15s %s   d %d %s%s" % (RNG.randrange(10 ** 9) / 1e6, RNG.randint(1, 4), case(sid[:-1] if ext else sid) + ("x" if ext else ""), RNG.choice(["Rx", "Tx"]), len(data), " ".join(case("%02X" % b) for b in data), tail)  # one line
        yield "canonical", line  # line
    yield "dlc above data", "   1.000000 1  7E0             Rx   d 8 02 10 03"  # fewer bytes than the DLC
    yield "small id with x", "   1.000000 1  7E0x            Rx   d 2 02 10"  # 29-bit flag on a small value


def oracle_candump(line):
    """Parses one candump -L line with python-can; returns a dict or an error string."""  # doc
    try:  # the reader raises on lines it cannot parse
        msgs = list(CanutilsLogReader(io.StringIO(line + "\n")))  # read
    except Exception as e:  # malformed for python-can
        return "error: %s" % type(e).__name__  # describe
    if not msgs:  # nothing read
        return "no message"  # describe
    m = msgs[0]  # the message
    return {"time": m.timestamp, "iface": m.channel, "id": m.arbitration_id, "ext": m.is_extended_id, "fd": m.is_fd, "brs": m.bitrate_switch, "data": list(m.data), "remote": m.is_remote_frame}  # fields


def oracle_asc(line):
    """Parses one ASC line (after a generated header) with python-can; returns a dict or an error string."""  # doc
    try:  # the reader raises on lines it cannot parse
        msgs = list(ASCReader(io.StringIO(ASC_HEADER + line + "\n")))  # read
    except Exception as e:  # malformed for python-can
        return "error: %s" % type(e).__name__  # describe
    if not msgs:  # nothing read
        return "no message"  # describe
    m = msgs[0]  # the message
    return {"time": m.timestamp, "channel": m.channel, "id": m.arbitration_id, "ext": m.is_extended_id, "data": list(m.data), "rx": m.is_rx}  # fields


def ours_of(parsed):
    """Returns our only frame from a parseLog result, or a short description of what happened instead."""  # doc
    if parsed["frames"]:  # a frame was parsed
        return parsed["frames"][0]  # the frame
    if parsed["ignored"]:  # the line was rejected
        return "ignored: " + parsed["ignored"][0]["reason"]  # with our reason
    return "no frame"  # nothing at all


def compare_candump(stats, bad, notes):
    """Compares candump -L parsing."""  # doc
    lines = list(candump_lines())  # inputs
    ours = js_batch([["parseLog", [l]] for _, l in lines])  # our parses
    for (kind, line), parsed in zip(lines, ours):  # compare
        stats["candump " + ("canonical" if kind == "canonical" else "edge")] += 1  # count
        mine, theirs = ours_of(parsed), oracle_candump(line)  # both results
        if isinstance(mine, dict) and isinstance(theirs, dict):  # both parsed a frame
            same = (mine["time"] == theirs["time"] and mine["iface"] == str(theirs["iface"]) and mine["id"] == theirs["id"] and mine["ext"] == theirs["ext"]  # identity
                    and mine["fd"] == theirs["fd"] and mine["brs"] == theirs["brs"] and mine["data"] == theirs["data"] and not theirs["remote"])  # content
            if not same:  # disagreement
                (notes if kind != "canonical" else bad).append(("candump", kind, line, {k: mine[k] for k in ("id", "ext", "fd", "brs", "data")}, {k: theirs[k] for k in ("id", "ext", "fd", "brs", "data", "remote")}))  # edge cases are classified by hand
        elif kind == "canonical" or isinstance(mine, dict) != isinstance(theirs, dict):  # one side refused the line
            (bad if kind == "canonical" else notes).append(("candump", kind, line, mine if isinstance(mine, str) else "frame", theirs if isinstance(theirs, str) else {k: theirs[k] for k in ("id", "ext", "fd", "data", "remote")}))  # record


def compare_asc(stats, bad, notes):
    """Compares Vector ASC parsing."""  # doc
    lines = list(asc_lines())  # inputs
    ours = js_batch([["parseLog", [l]] for _, l in lines])  # our parses
    for (kind, line), parsed in zip(lines, ours):  # compare
        stats["asc " + ("canonical" if kind == "canonical" else "edge")] += 1  # count
        mine, theirs = ours_of(parsed), oracle_asc(line)  # both results
        if isinstance(mine, dict) and isinstance(theirs, dict):  # both parsed a frame
            same = (abs(mine["time"] - theirs["time"]) < 1e-9 and int(mine["iface"]) - 1 == theirs["channel"] and mine["id"] == theirs["id"]  # identity (python-can stores channel − 1)
                    and mine["ext"] == theirs["ext"] and mine["data"] == theirs["data"] and (mine["dirHint"] == "rsp") == theirs["rx"])  # content and direction
            if not same:  # disagreement
                (notes if kind != "canonical" else bad).append(("asc", kind, line, {k: mine[k] for k in ("time", "id", "ext", "data", "dirHint")}, theirs))  # record
        elif kind == "canonical" or isinstance(mine, dict) != isinstance(theirs, dict):  # one side refused the line
            (bad if kind == "canonical" else notes).append(("asc", kind, line, mine if isinstance(mine, str) else "frame", theirs))  # record


def main():
    """Runs check 4 and prints a report; exits non-zero on any mismatch on canonical lines."""  # doc
    print("oracle versions:", versions())  # exact versions for the report
    stats, bad, notes = collections.Counter(), [], []  # counters
    compare_candump(stats, bad, notes)  # candump -L
    compare_asc(stats, bad, notes)  # Vector ASC
    for k in sorted(stats):  # case counts
        print("%-20s %d" % (k, stats[k]))  # one line each
    print("edge-case differences (classified in docs/CROSSCHECK.md): %d" % len(notes))  # headline
    for n in notes:  # all of them, they are few
        print("  EDGE", n)  # details
    print("mismatches on canonical lines: %d" % len(bad))  # headline
    for b in bad[:30]:  # details
        print("  MISMATCH", b)  # one line each
    sys.exit(1 if bad else 0)  # non-zero when a canonical line disagrees


if __name__ == "__main__":  # run as a script
    main()  # go
