"""Calls the UDS Bench JavaScript core from Python through bridge.js (dev-only cross-check helper)."""  # module purpose
import json  # JSON encoding of calls and results
import os  # paths
import subprocess  # runs Node

BRIDGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bridge.js")  # bridge script next to this file


def js_batch(calls):
    """Runs a list of (function name, argument list) pairs in one Node process and returns their results."""  # doc
    proc = subprocess.run(["node", BRIDGE], input=json.dumps(calls), capture_output=True, text=True, check=True)  # one Node run per batch
    results = json.loads(proc.stdout)  # parsed results, same order as the calls
    for call, res in zip(calls, results):  # every call must succeed
        if "error" in res:  # the core threw or the name was wrong
            raise RuntimeError("JS call %s%r failed: %s" % (call[0], call[1][:1], res["error"]))  # surface it loudly
    return [r["result"] for r in results]  # plain results


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
