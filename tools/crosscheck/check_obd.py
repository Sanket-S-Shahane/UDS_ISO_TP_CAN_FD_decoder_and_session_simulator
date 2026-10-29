"""Check 1: OBD-II PID formulas, supported-PID masks and DTC text, UDS Bench core vs python-OBD (dev-only)."""  # module purpose
import random  # generated test inputs (no real vehicle data)
import sys  # exit status
import types  # light stand-in for python-OBD message objects

import obd  # oracle: python-OBD
from obd.decoders import dtc as dtc_list, parse_dtc, pid as pid_mask  # oracle DTC formatter and supported-PID mask decoder

from jsbridge import js_batch, versions  # our core, called through Node

RNG = random.Random(20261028)  # fixed seed so every run checks the same inputs
PIDS = {  # SPEC section 7 PIDs: data length and the decimals our text keeps (display rounding)
    0x04: (1, 1), 0x05: (1, 0), 0x0C: (2, 2), 0x0D: (1, 0), 0x0F: (1, 0), 0x10: (2, 2),  # load .. MAF
    0x11: (1, 1), 0x1F: (2, 0), 0x2F: (1, 1), 0x42: (2, 3), 0x46: (1, 0), 0x5C: (1, 0),  # throttle .. oil
}
MASKS = (0x00, 0x20, 0x40, 0x60)  # supported-PID mask PIDs


def oracle_value(pid, data):
    """Decodes Mode 01 PID data with python-OBD and returns the magnitude (number) or the decoder's raw value."""  # doc
    msg = types.SimpleNamespace(data=bytearray([0x41, pid] + data))  # python-OBD decoders read message.data
    value = obd.commands[1][pid].decode([msg])  # call the command's decoder directly (no ECU or serial port)
    return getattr(value, "magnitude", value)  # pint quantity -> number


def inputs_for(length):
    """Returns the data-byte inputs to test for a PID length: exhaustive for 1 byte, edges plus random for 2."""  # doc
    if length == 1:  # 256 values cover everything
        return [[a] for a in range(256)]  # all single bytes
    edges = [[a, b] for a in (0, 1, 0x7F, 0x80, 0xFE, 0xFF) for b in (0, 1, 0x7F, 0x80, 0xFE, 0xFF)]  # boundary pairs
    return edges + [[RNG.randrange(256), RNG.randrange(256)] for _ in range(20000)]  # plus 20,000 random pairs


def check_pids():
    """Compares every SPEC PID formula; returns (cases, mismatches)."""  # doc
    cases, bad = 0, []  # counters
    for pid, (length, decimals) in PIDS.items():  # each PID
        datas = inputs_for(length)  # test inputs
        ours = js_batch([["fieldsOf", [[0x41, pid] + d, {"dir": "rsp"}]] for d in datas])  # our decodes
        tol = 0.5 * 10 ** -decimals + 1e-9  # our text is rounded to `decimals`; allow exactly that rounding
        for d, fields in zip(datas, ours):  # compare one by one
            cases += 1  # count
            text = [f for f in fields if f[0] == "data"][0][3]  # our value field text, e.g. "1726 rpm"
            mine = float(text.split()[0])  # the number in it
            theirs = float(oracle_value(pid, d))  # the oracle's number
            if abs(mine - theirs) > tol:  # outside rounding
                bad.append(("PID %02X" % pid, d, text, theirs))  # record the disagreement
    return cases, bad  # results


def check_masks():
    """Compares supported-PID masks over random and edge masks; returns (cases, mismatches)."""  # doc
    masks = [[0, 0, 0, 0], [0xFF] * 4, [0x80, 0, 0, 0], [0, 0, 0, 1], [0xBE, 0x1F, 0xA8, 0x13]]  # edges + vector 4
    masks += [[RNG.randrange(256) for _ in range(4)] for _ in range(5000)]  # random masks
    calls = [["fieldsOf", [[0x41, base] + m, {"dir": "rsp"}]] for base in MASKS for m in masks]  # every base x mask
    ours = iter(js_batch(calls))  # our decodes in call order
    cases, bad = 0, []  # counters
    for base in MASKS:  # each mask PID
        for m in masks:  # each mask
            cases += 1  # count
            text = [f for f in next(ours) if f[0] == "data"][0][3]  # "PIDs supported: 01 03 ..."
            listed = text.split(":", 1)[1].split()  # the PID list
            mine = [] if listed == ["none"] else [int(x, 16) for x in listed]  # as numbers
            bits = pid_mask([types.SimpleNamespace(data=bytearray([0x41, base] + m))])  # python-OBD mask decoder (its PIDS_A..C commands use it; 0.7.3 has no PID 60 command)
            theirs = [base + i + 1 for i in range(32) if bits[i]]  # how python-OBD maps bit i to a PID (obd.py __load_commands)
            if mine != theirs:  # different PID sets
                bad.append(("mask %02X" % base, m, mine, theirs))  # record
    return cases, bad  # results


def check_dtcs():
    """Compares 2-byte DTC text for all 65,536 byte pairs; returns (cases, mismatches, padding_pairs)."""  # doc
    pairs = [[a, b] for a in range(256) for b in range(256)]  # exhaustive
    ours = js_batch([["dtcText", [p]] for p in pairs])  # our texts
    cases, bad, padding = 0, [], 0  # counters
    for p, mine in zip(pairs, ours):  # compare
        cases += 1  # count
        theirs = parse_dtc(tuple(p))  # oracle: (code, description) or None
        if theirs is None:  # python-OBD treats 00 00 as padding and returns no code
            padding += 1  # recorded as a behaviour difference, not a mismatch
            continue  # nothing to compare
        if mine != theirs[0].upper():  # python-OBD prints hex digits in lower case; compare case-insensitively
            bad.append(("DTC", p, mine, theirs[0]))  # record
    return cases, bad, padding  # results


def check_dtc_lists():
    """Compares Mode 03 responses (count byte + 2-byte DTCs) for random lists; returns (cases, mismatches)."""  # doc
    lists = []  # generated responses
    for _ in range(3000):  # random lists
        n = RNG.randrange(0, 7)  # 0..6 DTCs
        codes = []  # DTC bytes
        while len(codes) < 2 * n:  # avoid 00 00, which python-OBD drops as padding
            pair = [RNG.randrange(256), RNG.randrange(256)]  # one DTC
            if pair != [0, 0]:  # skip the padding pair
                codes += pair  # keep it
        lists.append([0x43, n] + codes)  # mode, count, DTCs
    ours = js_batch([["fieldsOf", [p, {"dir": "rsp"}]] for p in lists])  # our decodes
    cases, bad = 0, []  # counters
    for p, fields in zip(lists, ours):  # compare
        cases += 1  # count
        mine = [f[3] for f in fields if f[1].startswith("DTC ")]  # our DTC texts in order
        theirs = [c[0].upper() for c in dtc_list([types.SimpleNamespace(data=bytearray(p))])]  # oracle codes
        if mine != theirs:  # different lists
            bad.append(("Mode 03", p, mine, theirs))  # record
    return cases, bad  # results


def main():
    """Runs check 1 and prints a report; exits non-zero on any mismatch."""  # doc
    print("oracle versions:", versions())  # exact versions for the report
    total_bad = []  # all mismatches
    n, bad = check_pids()  # PID formulas
    print("PID formulas: %d cases, %d mismatches" % (n, len(bad)))  # summary line
    total_bad += bad  # collect
    n, bad = check_masks()  # supported-PID masks
    print("supported-PID masks: %d cases, %d mismatches" % (n, len(bad)))  # summary line
    total_bad += bad  # collect
    n, bad, pad = check_dtcs()  # DTC text
    print("DTC text: %d cases, %d mismatches, %d pair(s) treated as padding by the oracle" % (n, len(bad), pad))  # summary line
    total_bad += bad  # collect
    n, bad = check_dtc_lists()  # Mode 03 lists
    print("Mode 03 DTC lists: %d cases, %d mismatches" % (n, len(bad)))  # summary line
    total_bad += bad  # collect
    for b in total_bad[:40]:  # show the first disagreements
        print("  MISMATCH", b)  # one line each
    sys.exit(1 if total_bad else 0)  # non-zero when anything disagrees


if __name__ == "__main__":  # run as a script
    main()  # go
