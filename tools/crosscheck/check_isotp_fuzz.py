"""Check 2 (part D): differential receive fuzz, our reassemble() vs can-isotp's receiver on mutated frame sequences (dev-only)."""  # module purpose
import collections  # counters
import random  # generated payloads and mutations (no real vehicle data)
import sys  # exit status

from check_isotp import frame_objs, oracle_receive  # shared helpers from the main ISO-TP check
from jsbridge import js_batch, versions  # our core, called through Node
from tools_segment import segment_many  # our segmenter for several payloads

RNG = random.Random(2016)  # fixed seed so every run checks the same inputs
MUTATIONS = ["none", "drop", "duplicate", "swap", "bad_sn", "truncate", "pci", "inject_sf", "inject_ff", "interleave"]  # mutation kinds


def mutate(frames, kind, other):
    """Returns a mutated copy of a frame list (byte lists)."""  # doc
    f = [list(x) for x in frames]  # deep copy
    i = RNG.randrange(len(f))  # position to mutate
    if kind == "drop" and len(f) > 1:  # lose one frame
        del f[i]  # remove it
    elif kind == "duplicate":  # repeat one frame
        f.insert(i, list(f[i]))  # duplicate in place
    elif kind == "swap" and len(f) > 1:  # reorder two neighbours
        j = min(i, len(f) - 2)  # left index
        f[j], f[j + 1] = f[j + 1], f[j]  # swap
    elif kind == "bad_sn":  # change the low nibble of a frame's PCI byte
        f[i][0] = (f[i][0] & 0xF0) | RNG.randrange(16)  # random nibble
    elif kind == "truncate" and len(f[i]) > 1:  # cut a frame short
        f[i] = f[i][:RNG.randrange(1, len(f[i]))]  # keep at least the PCI byte
    elif kind == "pci":  # change the frame type
        f[i][0] = (RNG.randrange(4) << 4) | (f[i][0] & 0x0F)  # type 0..3
    elif kind == "inject_sf":  # a stray single frame in the middle
        f.insert(i, [0x02, 0x3E, 0x00] + ([0xAA] * 5 if len(f[0]) == 8 else []))  # TesterPresent
    elif kind == "inject_ff":  # a second message starts before the first ends
        f.insert(i, list(other[0]))  # the other message's First Frame
    elif kind == "interleave":  # two messages' frames mixed together
        f = [x for pair in zip(f, other) for x in pair] + f[len(other):] + other[len(f):]  # alternate
    return f  # mutated frames


LEGAL = {0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64}  # CAN FD frame sizes a DLC can express


def explain(frames, fd):
    """Names the known policy difference present in a frame list, or None when there is none (see docs/CROSSCHECK.md)."""  # doc
    ff_len = next((len(x) for x in frames if x and x[0] >> 4 == 1), None)  # size of the first First Frame
    for x in frames:  # look for the patterns, most specific first
        if not x:  # empty frame
            continue  # both sides reject it
        t = x[0] >> 4  # frame type
        if len(x) > 8 and len(x) not in LEGAL:  # F3: impossible CAN FD length (we warn and keep the data; can-isotp drops it)
            return "F3 illegal FD frame length"  # explained
        if t == 0 and len(x) > 8 and x[0] & 0x0F:  # F1: 4-bit SF_DL above 8 bytes (spec vector 2.4: we warn and decode)
            return "F1 4-bit SF_DL in a frame over 8 bytes"  # explained
        if t == 0 and len(x) <= 8 and x[0] & 0x0F == 0:  # F5: escape SF in a short frame (spec vector 2.1: we reject; can-isotp accepts)
            return "F5 SF_DL 0 in a frame of 8 bytes or fewer"  # explained
        if t == 1 and len(x) >= 2 and ((x[0] & 0x0F) << 8 | x[1]) and ((x[0] & 0x0F) << 8 | x[1]) <= len(x) - 2:  # F2: FF_DL fits in the FF (decision D8)
            return "F2 FF_DL fits in the First Frame"  # explained
        if fd and t == 2 and ff_len and len(x) < ff_len:  # F4: short CAN FD CF (we warn and keep the data; can-isotp ignores the frame)
            return "F4 short CAN FD Consecutive Frame"  # explained
    return None  # nothing known


def main():
    """Runs the differential fuzz and prints a report; exits non-zero on any unexplained difference."""  # doc
    print("oracle versions:", versions())  # exact versions for the report
    cases = []  # (kind, fd, frames)
    for _ in range(3000):  # generated sequences
        fd = RNG.random() < 0.5  # classic or CAN FD (64-byte frames)
        pad = RNG.choice([None, 0xAA])  # padding on or off
        a, b = [RNG.randrange(256) for _ in range(RNG.randint(1, 200))], [RNG.randrange(256) for _ in range(RNG.randint(8, 200))]  # two payloads
        fa, fb = segment_many([a, b], fd, pad)  # their frames (our segmenter, already cross-checked in part A)
        kind = RNG.choice(MUTATIONS)  # mutation
        cases.append((kind, fd, mutate(fa, kind, fb)))  # mutated sequence
    ours = js_batch(chunk=500, calls=[["reassemble", [frame_objs(f, fd), {}]] for _, fd, f in cases])  # our receiver
    stats, diffs, explained = collections.Counter(), collections.defaultdict(list), collections.Counter()  # counters, unexplained, explained
    for (kind, fd, frames), r in zip(cases, ours):  # compare
        stats[kind] += 1  # count
        mine = [m["payload"] for m in r["messages"] if not m["partial"]]  # complete messages only (the library has no partial output)
        theirs, _ = oracle_receive(frames, fd, False)  # oracle messages
        if mine != theirs:  # different outcome
            why = explain(frames, fd)  # known policy difference?
            if why:  # explained
                explained[why] += 1  # count it
            else:  # unexplained
                diffs[kind].append((fd, [bytes(x).hex() for x in frames][:6], [bytes(x).hex()[:16] for x in mine], [bytes(x).hex()[:16] for x in theirs]))  # record
    for k in MUTATIONS:  # report per mutation
        print("%-11s %5d cases, %4d unexplained" % (k, stats[k], len(diffs[k])))  # one line
    for k in sorted(explained):  # explained differences
        print("explained: %-45s %d" % (k, explained[k]))  # one line
    for k, v in diffs.items():  # examples
        for d in v[:4]:  # a few each
            print("  DIFF %s fd=%s frames=%s\n       ours=%s\n       theirs=%s" % (k, d[0], d[1], d[2], d[3]))  # details
    sys.exit(1 if diffs else 0)  # every difference must be classified by hand


if __name__ == "__main__":  # run as a script
    main()  # go
