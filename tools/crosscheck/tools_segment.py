"""Segments several payloads with the UDS Bench core in one bridge call (helper for check_isotp_fuzz.py)."""  # module purpose
from jsbridge import js_batch  # our core, called through Node


def segment_many(payloads, fd, pad):
    """Returns our ISO-TP frames for each payload (CAN FD uses 64-byte frames)."""  # doc
    return js_batch([["segment", [p, {"fd": fd, "canDl": 64 if fd else 8, "pad": pad}]] for p in payloads])  # one call per payload
