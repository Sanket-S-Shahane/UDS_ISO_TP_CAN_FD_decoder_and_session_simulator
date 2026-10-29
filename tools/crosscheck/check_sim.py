"""Check 5: the UDS Bench virtual ECU driven by udsoncan's client, which validates every response it receives (dev-only)."""  # module purpose
import collections  # response queue
import json  # bridge protocol
import logging  # used only to silence the client's request log
import os  # paths
import subprocess  # runs the Node simulator
import sys  # exit status

import udsoncan  # oracle: udsoncan's client and response parsers
from udsoncan import DataFormatIdentifier, MemoryLocation  # helper types
from udsoncan.client import Client  # UDS client
from udsoncan.common.DidCodec import AsciiCodec  # ASCII DID values
from udsoncan.connections import BaseConnection  # connection interface
from udsoncan.exceptions import NegativeResponseException, TimeoutException  # expected outcomes

from check_uds import RawCodec  # passthrough codec for raw DID values
from jsbridge import versions  # oracle versions

logging.disable(logging.CRITICAL)  # the client logs every request; the report below is enough


class SimBridge:
    """Talks to tools/crosscheck/sim_server.js over stdin/stdout lines."""  # doc

    def __init__(self):
        """Starts the Node simulator."""  # doc
        server = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sim_server.js")  # bridge script
        self.proc = subprocess.Popen(["node", server], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)  # long-lived process

    def call(self, **msg):
        """Sends one request and returns the reply."""  # doc
        self.proc.stdin.write(json.dumps(msg) + "\n")  # one line out
        self.proc.stdin.flush()  # send now
        return json.loads(self.proc.stdout.readline())  # one line back

    def close(self):
        """Stops the simulator."""  # doc
        self.proc.stdin.close()  # end of input ends the process
        self.proc.wait()  # reap it


class SimConnection(BaseConnection):
    """udsoncan connection whose 'bus' is the simulator: each sent request is handled 100 ms after the previous one."""  # doc

    def __init__(self, sim):
        """Wires the connection to a running simulator."""  # doc
        super().__init__("sim")  # base class setup
        self.sim, self.now, self.rx, self.opened = sim, 0, collections.deque(), False  # bridge, virtual clock (ms), responses, state

    def open(self):
        """Opens the connection."""  # doc
        self.opened = True  # nothing to set up
        return self  # chainable

    def close(self):
        """Closes the connection."""  # doc
        self.opened = False  # nothing to tear down

    def is_open(self):
        """Reports whether the connection is open."""  # doc
        return self.opened  # state

    def empty_rxqueue(self):
        """Drops unread responses."""  # doc
        self.rx.clear()  # forget them

    def specific_send(self, payload, timeout=None):
        """Lets the ECU handle the request and queues its responses in time order."""  # doc
        self.now += 100  # requests 100 ms apart, as in TEST_VECTORS section 5
        out = self.sim.call(op="handle", req=list(payload), now=self.now)  # run it
        for r in out["responses"]:  # pending responses first, final last
            self.rx.append(bytes(r["bytes"]))  # deliver
        if out["responses"]:  # move the clock past the last response, like the UI's virtual clock
            self.now += out["responses"][-1]["delayMs"]  # e.g. 7000 ms after an erase

    def specific_wait_frame(self, timeout=None):
        """Returns the next queued response or reports a timeout when there is none."""  # doc
        if self.rx:  # a response is waiting
            return self.rx.popleft()  # deliver it
        raise TimeoutException("no response from the simulator")  # nothing was sent back


def one(v):
    """Unwraps the 1-tuples that udsoncan's pack-string codecs return."""  # doc
    return v[0] if isinstance(v, tuple) and len(v) == 1 else v  # value


def make_client(conn, sim):
    """Creates a udsoncan client configured with codecs for the demo DIDs and the demo key algorithm."""  # doc
    config = dict(udsoncan.configs.default_client_config)  # library defaults
    config["data_identifiers"] = {  # demo DIDs from SPEC section 8 (codecs give udsoncan the lengths)
        0xF190: AsciiCodec(17), 0xF187: AsciiCodec(12), 0xF189: AsciiCodec(5), 0xF18A: AsciiCodec(15), 0xF18C: AsciiCodec(7),  # text DIDs
        0xF191: AsciiCodec(5), 0xF195: AsciiCodec(8), 0xF186: ">B", 0xF198: RawCodec(6), 0x0100: ">H", 0x0101: ">B", 0x0300: ">B",  # numeric and raw DIDs
        0xDEAD: RawCodec(1),  # unknown to the ECU; the client still needs a codec before it sends the request
    }
    config["input_output"] = {0x0300: ">B"}  # demo LED
    config["security_algo"] = lambda level, seed, params: bytes(sim.call(op="demoKey", seed=list(seed)))  # made-up key, computed by our simulator
    config["request_timeout"], config["p2_timeout"], config["p2_star_timeout"] = 2, 1, 10  # generous; the fake bus answers at once
    return Client(conn, config=config)  # client


def main():
    """Runs a full diagnostic and programming session through the client and reports every failed step."""  # doc
    print("oracle versions:", versions())  # exact versions for the report
    sim = SimBridge()  # simulator
    conn = SimConnection(sim)  # fake bus
    results = []  # (step, ok, detail)

    def step(name, fn, expect_nrc=None):
        """Runs one client call; with expect_nrc, the call must fail with that negative response code."""  # doc
        try:  # the client raises on negative, invalid or unexpected responses
            value = fn()  # run it
            ok = expect_nrc is None  # success was expected
            results.append((name, ok, "ok" if ok else "expected NRC 0x%02X, got a positive response" % expect_nrc))  # record
            return value  # for further checks
        except NegativeResponseException as e:  # the ECU said no
            ok = expect_nrc == e.response.code  # was that the plan?
            results.append((name, ok, "NRC 0x%02X %s" % (e.response.code, e.response.code_name)))  # record
        except Exception as e:  # invalid or unexpected response, timeout, codec problem: a finding
            results.append((name, False, "%s: %s" % (type(e).__name__, e)))  # record
        return None  # no value

    def check(name, cond, detail):
        """Records a value check."""  # doc
        results.append((name, bool(cond), detail))  # record

    with make_client(conn, sim) as c:  # opens and closes the connection
        step("22 in default session", lambda: c.read_data_by_identifier([0xF190, 0xF186]))  # basic read
        step("27 01 in default session", lambda: c.request_seed(1), expect_nrc=0x7F)  # refused
        r = step("10 03", lambda: c.change_session(3))  # extended session (client parses P2 / P2*)
        if r:  # timing values
            check("10 03 timing", r.service_data.p2_server_max == 0.05 and r.service_data.p2_star_server_max == 5.0, "P2 %s s, P2* %s s" % (r.service_data.p2_server_max, r.service_data.p2_star_server_max))  # 50 ms and 5000 ms
        r = step("22 all demo DIDs", lambda: c.read_data_by_identifier([0xF190, 0xF187, 0xF189, 0xF18A, 0xF18C, 0xF191, 0xF195, 0xF186, 0xF198, 0x0100, 0x0101]))  # every DID
        if r:  # values
            v = r.service_data.values  # decoded by the client's codecs
            check("22 values", v[0xF190] == "EGTEST12345678901" and v[0xF187] == "EG-DEMO-0001" and one(v[0xF186]) == 3 and one(v[0x0101]) == 0x5A and 12480 <= one(v[0x0100]) < 12540, repr({k: v[k] for k in (0xF190, 0xF186, 0x0100)}))  # spec values
        step("22 unknown DID", lambda: c.read_data_by_identifier([0xDEAD]), expect_nrc=0x31)  # out of range
        step("2E F198 while locked", lambda: c.write_data_by_identifier(0xF198, b"\x01\x02\x03\x04\x05\x06"), expect_nrc=0x33)  # security
        step("27 unlock level 1", lambda: c.unlock_security_access(1))  # seed + key with the demo algorithm
        step("2E F198", lambda: c.write_data_by_identifier(0xF198, b"\x01\x02\x03\x04\x05\x06"))  # write
        r = step("22 F198 read back", lambda: c.read_data_by_identifier([0xF198]))  # read back
        if r:  # value
            check("F198 value", r.service_data.values[0xF198] == b"\x01\x02\x03\x04\x05\x06", repr(r.service_data.values[0xF198]))  # same bytes
        step("2F LED short-term adjustment", lambda: c.io_control(0x0300, control_param=3, values=[1]))  # IO control (client checks the echo)
        step("2F LED return control", lambda: c.io_control(0x0300, control_param=0))  # back to the ECU
        r = step("19 01 FF", lambda: c.get_number_of_dtc_by_status_mask(0xFF))  # count
        if r:  # count
            check("19 01 count", r.service_data.dtc_count == 3, "count %s" % r.service_data.dtc_count)  # three demo DTCs
        r = step("19 02 FF", lambda: c.get_dtc_by_status_mask(0xFF))  # list
        if r:  # records
            got = [(d.id, d.status.get_byte_as_int()) for d in r.service_data.dtcs]  # parsed by the client
            check("19 02 records", got == [(0x030000, 0x2F), (0x011300, 0x08), (0xC10087, 0x09)], repr(got))  # spec DTCs
        step("19 0A", lambda: c.get_supported_dtc())  # supported DTCs
        step("28 03 01", lambda: c.communication_control(3, 1))  # disable Rx and Tx, normal messages
        step("85 02", lambda: c.control_dtc_setting(2))  # DTC setting off
        step("3E 00", lambda: c.tester_present())  # keep alive
        step("31 01 0200 start", lambda: c.start_routine(0x0200))  # self-test
        r = step("31 03 0200 results", lambda: c.get_routine_result(0x0200))  # results
        if r:  # status record
            check("31 03 status", r.service_data.routine_status_record == b"\x01", repr(r.service_data.routine_status_record))  # passed
        step("31 02 0200 stop", lambda: c.stop_routine(0x0200))  # stop
        step("14 FFFFFF", lambda: c.clear_dtc(0xFFFFFF))  # clear all
        r = step("19 01 FF after clear", lambda: c.get_number_of_dtc_by_status_mask(0xFF))  # count again
        if r:  # count
            check("19 01 after clear", r.service_data.dtc_count == 0, "count %s" % r.service_data.dtc_count)  # none left
        step("10 02", lambda: c.change_session(2))  # programming session
        step("27 unlock in programming", lambda: c.unlock_security_access(1))  # unlock again (session change locked it)
        loc = MemoryLocation(0x08000000, 256, 32, 32)  # 256 bytes at the start of the demo flash
        step("34 before erase", lambda: c.request_download(loc), expect_nrc=0x24)  # sequence error
        step("31 01 FF00 erase (two 0x78 then the result)", lambda: c.start_routine(0xFF00))  # client must wait through response-pending
        r = step("34 download", lambda: c.request_download(loc, DataFormatIdentifier(0, 0)))  # accepted
        if r:  # block length
            check("74 max block", r.service_data.max_length == 256, "max_length %s" % r.service_data.max_length)  # 256 bytes
        step("36 01 (254 bytes)", lambda: c.transfer_data(1, bytes(range(254))))  # first block
        step("37 too early", lambda: c.request_transfer_exit(), expect_nrc=0x24)  # 2 bytes missing
        step("36 02 (2 bytes)", lambda: c.transfer_data(2, b"\xAA\xBB"))  # last block
        step("37 exit", lambda: c.request_transfer_exit())  # done
        step("11 01", lambda: c.ecu_reset(1))  # reset
        r = step("22 F186 after reset", lambda: c.read_data_by_identifier([0xF186]))  # session after reset
        if r:  # value
            check("F186 after reset", one(r.service_data.values[0xF186]) == 1, "session %s" % one(r.service_data.values[0xF186]))  # default
    sim.close()  # stop Node
    for name, ok, detail in results:  # report every step
        print("%-4s %-45s %s" % ("ok" if ok else "FAIL", name, detail))  # one line each
    failed = [r for r in results if not r[1]]  # failures
    print("steps: %d, failed: %d" % (len(results), len(failed)))  # headline
    sys.exit(1 if failed else 0)  # non-zero on any failure


if __name__ == "__main__":  # run as a script
    main()  # go
