"""Calls the UDS Bench JavaScript core from Python through bridge.js (dev-only cross-check helper)."""  # module purpose
import json  # JSON encoding of calls and results
import os  # paths
import subprocess  # runs Node

BRIDGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bridge.js")  # bridge script next to this file


def js_batch(calls, chunk=2000):
    """Runs a list of (function name, argument list) pairs in Node, `chunk` calls per process, and returns their results."""  # doc
    out = []  # results in call order
    for start in range(0, len(calls), chunk):  # bounded batches keep Node's memory and the JSON strings small
        part = calls[start:start + chunk]  # this batch
        proc = subprocess.run(["node", BRIDGE], input=json.dumps(part), capture_output=True, text=True)  # one Node run per batch
        if proc.returncode != 0:  # Node itself failed
            raise RuntimeError("bridge failed (exit %d): %s" % (proc.returncode, proc.stderr[-2000:]))  # show why
        results = json.loads(proc.stdout)  # parsed results, same order as the calls
        for call, res in zip(part, results):  # every call must succeed
            if "error" in res:  # the core threw or the name was wrong
                raise RuntimeError("JS call %s%r failed: %s" % (call[0], call[1][:1], res["error"]))  # surface it loudly
        out.extend(r["result"] for r in results)  # plain results
    return out  # all results


def versions():
    """Returns the installed versions of the oracle packages, read from package metadata."""  # doc
    from importlib.metadata import version, PackageNotFoundError  # standard-library metadata access
    out = {}  # name -> version
    for name in ("can-isotp", "udsoncan", "python-can", "obd"):  # the four oracles
        try:  # a missing package is reported, not fatal
            out[name] = version(name)  # installed version
        except PackageNotFoundError:  # not installed
            out[name] = "NOT INSTALLED"  # say so
    return out  # versions
