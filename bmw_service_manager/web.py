"""Local web UI and JSON API."""

from __future__ import annotations

import datetime as dt
import threading
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

from . import __version__, hsfz, transfer
from .cbs import BRAKE_FLUID, DME, OIL, owner, read_cbs, read_dme_status, read_item, reset_cbs
from .headunit import SESSION_PATHS, HeadUnit, write_plan
from .records import (
    ITEM_STATUSES,
    ITEM_TYPES,
    MAX_ITEMS,
    RECORD_STATUSES,
    RecordError,
    ServiceRecord,
    dump_tst,
    known_entry_patterns,
    parse_tst,
)

STATIC = Path(__file__).parent / "static"


def create_app(default_host: str = "", default_port: int = hsfz.DIAG_PORT, simulated: bool = False) -> Flask:
    app = Flask(__name__, static_folder=None)

    def records_from_body(body: dict) -> list[ServiceRecord]:
        records = [ServiceRecord.from_dict(r) for r in body.get("records", [])]
        for r in records:
            r.validate()
        return records

    def connection(body: dict) -> hsfz.HsfzClient:
        host = (body.get("host") or default_host).strip()
        if not host:
            raise hsfz.HsfzError("no vehicle IP address set")
        return hsfz.HsfzClient(host, int(body.get("port") or default_port))

    @app.errorhandler(RecordError)
    @app.errorhandler(hsfz.HsfzError)
    @app.errorhandler(OSError)
    @app.errorhandler(ValueError)
    @app.errorhandler(KeyError)
    def bad_request(e):
        return jsonify(error=str(e)), 400

    @app.get("/")
    def index():
        return send_from_directory(STATIC, "index.html")

    @app.get("/static/<path:name>")
    def static_file(name):
        return send_from_directory(STATIC, name)

    @app.get("/api/meta")
    def meta():
        return jsonify(
            item_types=ITEM_TYPES,
            record_statuses=RECORD_STATUSES,
            item_statuses=ITEM_STATUSES,
            max_items=MAX_ITEMS,
            version=__version__,
            simulated=simulated,
            default_host=default_host,
            default_port=default_port,
        )

    @app.get("/api/status")
    def status():
        """Whether the car answers right now, for the header's connection light."""
        host = (request.args.get("host") or "").strip()
        port = request.args.get("port", default_port, type=int)
        if not host:
            return jsonify(state="not_set")
        if simulated and host == default_host and port == default_port:
            return jsonify(state="simulator", ip=host)
        vehicle = hsfz.identify(host)
        if vehicle:
            return jsonify(state="connected", ip=host, vin=vehicle.vin)
        if hsfz.reachable(host, port):
            return jsonify(state="connected", ip=host, vin="")
        return jsonify(state="no_answer", ip=host)

    @app.post("/api/discover")
    def discover():
        return jsonify(vehicles=[v.to_dict() for v in hsfz.discover()])

    @app.post("/api/plan")
    def plan():
        body = request.get_json(force=True)
        steps = write_plan(records_from_body(body), bool(body.get("erase")), bool(body.get("reset")))
        return jsonify(steps=[{"label": label, "request": req.hex(" ")} for label, req in steps])

    @app.post("/api/write")
    def write():
        body = request.get_json(force=True)
        records = records_from_body(body)
        erase, reset = bool(body.get("erase")), bool(body.get("reset"))
        if not records and not erase:
            raise RecordError("nothing to write")
        client = connection(body)
        with client:
            results = HeadUnit(client).write_history(records, erase=erase, reset=reset)
        return jsonify(results=[r.to_dict() for r in results], frames=client.log)

    def hex_or_none(data: bytes | None) -> str | None:
        return data.hex(" ") if data is not None else None

    @app.post("/api/cbs")
    def cbs():
        client = connection(request.get_json(force=True))
        with client:
            items = read_cbs(client)
            dme = read_dme_status(client)
        return jsonify(items=[i.to_dict() for i in items], dme_status=hex_or_none(dme))

    reset_names = {"oil": OIL, "brake_fluid": BRAKE_FLUID}

    @app.post("/api/cbs/reset")
    def cbs_reset():
        body = request.get_json(force=True)
        item = body.get("item")
        if item is None or item == "":
            item = "oil"
        # An item code (any item the cluster lists), or one of the older names.
        item = reset_names[item] if isinstance(item, str) else int(item)
        if not 0 < item <= 0xFF:
            raise ValueError("CBS item code must be within 01-FF")

        def status(client):
            # DME items show in its raw DID 0x1001; the rest in their cluster slot 0x41xx.
            if owner(item) == DME:
                return {"raw": hex_or_none(read_dme_status(client))}
            found = read_item(client, item)
            return found.to_dict() if found else None

        client = connection(body)
        with client:
            before = status(client)
            reset_cbs(client, item)
            after = status(client)
            items = read_cbs(client)
        return jsonify(items=[i.to_dict() for i in items], before=before, after=after, frames=client.log)

    @app.post("/api/probe/routines")
    def probe_routines():
        client = connection(request.get_json(force=True))
        with client:
            results = HeadUnit(client).probe_routine_results()
        return jsonify(results=[r.to_dict() for r in results], frames=client.log)

    scans: dict[int, dict] = {}
    scan_lock = threading.Lock()

    @app.post("/api/probe/dids")
    def probe_dids():
        body = request.get_json(force=True)
        start, end = int(body["start"], 16), int(body["end"], 16)
        if not 0 <= start <= end <= 0xFFFF:
            raise ValueError("DID range must be within 0000-FFFF")
        ecu = int(body.get("ecu") or "63", 16)
        if not 0 <= ecu <= 0xFF:
            raise ValueError("ECU address must be within 00-FF")
        session = int(body.get("session") or "01", 16)
        if session not in SESSION_PATHS:
            raise ValueError("session must be 01, 03 or 42")
        patterns = {}
        if body.get("known_date"):
            km = body.get("known_km")
            patterns = known_entry_patterns(
                dt.date.fromisoformat(body["known_date"]), int(km) if km not in (None, "") else None
            )
        client = connection(body)
        client.connect()
        unit = HeadUnit(client, ecu)
        if session != 0x01:
            try:
                unit.enter_session(session)
            except Exception:
                client.close()
                raise
        with scan_lock:
            scan_id = max(scans, default=0) + 1
            scan = scans[scan_id] = {
                "ecu": ecu, "session": session, "start": start, "end": end, "current": start, "hits": [], "done": False, "stop": False,
            }

        def run():
            try:
                unit.probe_dids(
                    start,
                    end,
                    patterns,
                    on_hit=scan["hits"].append,
                    on_progress=lambda did: scan.__setitem__("current", did),
                    should_stop=lambda: scan["stop"],
                    keep_alive=2.0 if session != 0x01 else None,
                )
            finally:
                if session != 0x01:
                    try:
                        unit.enter_session(0x01)
                    except (hsfz.HsfzError, OSError):
                        pass
                client.close()
                scan["done"] = True

        threading.Thread(target=run, daemon=True).start()
        return jsonify(id=scan_id)

    @app.get("/api/probe/dids/<int:scan_id>")
    def probe_dids_status(scan_id):
        scan = scans[scan_id]
        since = request.args.get("since", 0, type=int)
        return jsonify(
            ecu=scan["ecu"], session=scan["session"], start=scan["start"], end=scan["end"], current=scan["current"], done=scan["done"],
            total_hits=len(scan["hits"]), hits=scan["hits"][since:],
        )

    @app.post("/api/probe/dids/<int:scan_id>/stop")
    def probe_dids_stop(scan_id):
        scans[scan_id]["stop"] = True
        return jsonify(ok=True)

    @app.post("/api/qr")
    def qr():
        """The history as QR codes for Stampbook to scan: the records themselves, no URL."""
        body = request.get_json(force=True)
        records = records_from_body(body)
        if not records:
            raise RecordError("add a record first")
        vin = (body.get("vin") or "").strip().upper()
        if vin and (len(vin) != 17 or not vin.isalnum() or not vin.isascii()):
            raise RecordError("a VIN is 17 letters and digits")
        parts = transfer.to_parts(records, vin, body.get("name") or "")
        return jsonify(parts=parts, svgs=transfer.qr_svgs(parts))

    @app.post("/api/import/tst")
    def import_tst():
        erase, records = parse_tst(request.get_data(as_text=True))
        return jsonify(erase=erase, records=[r.to_dict() for r in records])

    @app.post("/api/export/tst")
    def export_tst():
        body = request.get_json(force=True)
        return dump_tst(records_from_body(body), bool(body.get("erase"))), 200, {"Content-Type": "text/plain"}

    return app
