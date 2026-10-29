"""Check 2: ISO-TP both ways, UDS Bench core vs can-isotp's pure-Python transport logic (dev-only)."""  # module purpose
import collections  # frame queues
import logging  # used only to silence the library's per-frame warnings
import random  # generated payloads (no real vehicle data)
import sys  # exit status

import isotp  # oracle: can-isotp
from isotp.can_message import CanMessage  # the library's CAN message type
from isotp.protocol import TransportLayerLogic  # the non-threaded core of isotp.TransportLayer (no sockets)

from jsbridge import js_batch, versions  # our core, called through Node

logging.disable(logging.CRITICAL)  # can-isotp logs every rejected frame; the results below report them instead
RNG = random.Random(15765)  # fixed seed so every run checks the same inputs
TESTER, ECU = 0x7E0, 0x7E8  # CAN IDs used for every case
ADDR_BYTE = 0xF1  # extended-addressing byte used in both directions
BIG = 1 << 20  # receiver max_frame_size large enough for the escaped-length cases
CONFIGS = [(False, 8)] + [(True, n) for n in (8, 12, 16, 20, 24, 32, 48, 64)]  # classic CAN, then every CAN FD size


def lengths():
    """Payload lengths to test: 1..300 exhaustive, 300 random up to 4095, the 12-bit boundary and escaped lengths."""  # doc
    out = list(range(1, 301))  # every short length (all SF/FF boundaries for every frame size are below 300)
    out += RNG.sample(range(301, 4094), 300)  # random longer messages
    out += [4094, 4095, 4096, 5000, 20000]  # 12-bit maximum and the 32-bit escape (can-isotp supports it)
    return out  # lengths


def payload(n):
    """Returns a generated payload of n bytes."""  # doc
    return [RNG.randrange(256) for _ in range(n)]  # random bytes


def make_address(ext, txid, rxid):
    """Builds a can-isotp address for normal or extended 11-bit addressing."""  # doc
    if ext:  # first data byte is an address byte
        return isotp.Address(isotp.AddressingMode.Extended_11bits, txid=txid, rxid=rxid, target_address=ADDR_BYTE, source_address=ADDR_BYTE)  # tx and rx prefix F1
    return isotp.Address(isotp.AddressingMode.Normal_11bits, txid=txid, rxid=rxid)  # no prefix


def make_layer(ext, fd, can_dl, pad, txid, rxid, out, rxq, errors):
    """Creates a can-isotp TransportLayerLogic wired to in-memory queues."""  # doc
    params = {  # library parameters (names read from isotp/protocol.py Params)
        "tx_data_length": can_dl, "can_fd": fd, "tx_padding": pad, "max_frame_size": BIG,  # framing
        "stmin": 0, "blocksize": 0, "blocking_send": False, "rate_limit_enable": False,  # no throttling
    }
    return TransportLayerLogic(rxfn=lambda: rxq.popleft() if rxq else None, txfn=out.append, address=make_address(ext, txid, rxid), error_handler=errors.append, params=params)  # zero-argument rxfn = non-blocking


def oracle_segment(data, fd, can_dl, pad, ext):
    """Lets can-isotp send `data` (answering its First Frame with a Flow Control) and returns the frames it sent."""  # doc
    out, rxq, errors = [], collections.deque(), []  # sent frames, frames to deliver to it, error reports
    layer = make_layer(ext, fd, can_dl, pad, TESTER, ECU, out, rxq, errors)  # sender on the tester ID
    layer.send(bytes(data))  # queue the message
    fc_sent = False  # one Flow Control (BS 0) is enough for the whole message
    idle = 0  # process() calls in a row that produced nothing
    while idle < 3:  # stop once the sender has gone quiet
        before = len(out)  # frames so far
        layer.process()  # run the state machines once
        if out and not fc_sent and ((out[0].data[1 if ext else 0] >> 4) == 1):  # it sent a First Frame
            prefix = [ADDR_BYTE] if ext else []  # address byte on the FC as well
            rxq.append(CanMessage(arbitration_id=ECU, data=bytes(prefix + [0x30, 0x00, 0x00]), is_fd=fd))  # ContinueToSend, BS 0, STmin 0
            fc_sent = True  # done
        idle = idle + 1 if len(out) == before else 0  # count quiet rounds
    return [list(m.data) for m in out], errors  # frames as byte lists


def oracle_receive(frames, fd, ext):
    """Feeds frames (sent on the tester ID) to a can-isotp receiver and returns the messages it completed."""  # doc
    out, rxq, errors = [], collections.deque(), []  # its flow controls, frames to deliver, error reports
    layer = make_layer(ext, fd, 64 if fd else 8, None, ECU, TESTER, out, rxq, errors)  # receiver listening on the tester ID
    got = []  # completed messages
    for f in frames:  # one frame at a time, like a bus
        rxq.append(CanMessage(arbitration_id=TESTER, data=bytes(f), is_fd=fd))  # deliver
        for _ in range(3):  # let it consume the frame and send any flow control
            layer.process()  # run the state machines
        while layer.available():  # collect finished messages
            got.append(list(layer.recv()))  # payload bytes
    return got, errors  # messages and errors


def frame_objs(frames, fd):
    """Wraps byte lists as UDS Bench frame objects on the tester ID."""  # doc
    return [{"index": i, "line": i + 1, "time": None, "id": TESTER, "ext": False, "fd": fd, "brs": False, "data": f} for i, f in enumerate(frames)]  # frame objects


def padding_only_difference(ours, theirs, fd, can_dl, pad):
    """True when the only difference is that we padded a frame of 8 bytes or fewer to 8 on CAN FD with frames above 8."""  # doc
    if not (fd and can_dl > 8 and pad is not None) or len(ours) != len(theirs):  # only this configuration
        return False  # a different kind of mismatch
    for a, b in zip(ours, theirs):  # frame by frame
        if a == b:  # identical frame
            continue  # fine
        if len(a) != 8 or len(b) >= 8 or a[:len(b)] != b or any(x != pad for x in a[len(b):]):  # not "b padded to 8"
            return False  # a real difference
    return True  # padding policy only


def main():
    """Runs check 2 and prints a report; exits non-zero on any unexplained mismatch."""  # doc
    print("oracle versions:", versions())  # exact versions for the report
    cases = [(n, fd, dl, ext, pad) for n in lengths() for fd, dl in CONFIGS for ext in (False, True) for pad in (None, 0xAA)]  # every combination
    datas = {n: payload(n) for n in set(c[0] for c in cases)}  # one payload per length
    ours = js_batch([["segment", [datas[n], {"fd": fd, "canDl": dl, "pad": pad, "extAddr": ADDR_BYTE if ext else None}]] for n, fd, dl, ext, pad in cases])  # our frames
    stats = collections.Counter()  # counters per category
    bad, examples = [], {}  # unexplained mismatches, one example per explained category
    oracle_frames = []  # can-isotp's frames, for direction C
    for (n, fd, dl, ext, pad), mine in zip(cases, ours):  # A and B: our segment vs its sender, and its receiver on our frames
        tag = "len=%d fd=%s canDl=%d ext=%s pad=%s" % (n, fd, dl, ext, pad)  # description
        theirs, errs = oracle_segment(datas[n], fd, dl, pad, ext)  # its frames
        oracle_frames.append(theirs)  # keep for C
        stats["A sender cases"] += 1  # count
        if errs:  # the oracle itself reported an error while sending
            bad.append(("A sender error", tag, [str(e) for e in errs]))  # unexplained
        elif mine == theirs:  # byte-identical frames
            stats["A identical"] += 1  # count
        elif padding_only_difference(mine, theirs, fd, dl, pad):  # known padding-policy difference
            stats["A padding policy (short FD frames)"] += 1  # count
            examples.setdefault("A padding", (tag, mine[-1], theirs[-1]))  # keep one example
        else:  # anything else
            bad.append(("A sender", tag, mine[:3], theirs[:3]))  # unexplained
        got, errs = oracle_receive(mine, fd, ext)  # B: its receiver on our frames
        stats["B receiver cases"] += 1  # count
        if got != [datas[n]] or errs:  # it must complete exactly our payload without errors
            bad.append(("B oracle receiver on our frames", tag, len(got), [str(e) for e in errs][:2]))  # unexplained
    results = js_batch(chunk=300, calls=[["reassemble", [frame_objs(f, c[1]), {"addressing": "extended" if c[3] else "normal"}]] for c, f in zip(cases, oracle_frames)])  # C: our receiver on its frames
    for c, r in zip(cases, results):  # compare
        stats["C our receiver cases"] += 1  # count
        msgs = [m["payload"] for m in r["messages"]]  # completed payloads
        if msgs != [datas[c[0]]] or r["events"]:  # exactly one message, identical, no events
            bad.append(("C our receiver on oracle frames", c, len(msgs), r["events"][:2]))  # unexplained
    for k in sorted(stats):  # report counts
        print("%-40s %d" % (k, stats[k]))  # one line each
    for k, v in examples.items():  # one example per explained difference
        print("example (%s): %s\n  ours:   %s\n  theirs: %s" % (k, v[0], v[1], v[2]))  # show it
    print("unexplained mismatches: %d" % len(bad))  # headline
    for b in bad[:30]:  # first few
        print("  MISMATCH", b)  # details
    sys.exit(1 if bad else 0)  # non-zero when anything is unexplained


if __name__ == "__main__":  # run as a script
    main()  # go
