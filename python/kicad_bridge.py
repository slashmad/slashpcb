"""Live bridge between SlashPCB and a running KiCad (IPC API via kicad-python / kipy).

JSON lines on stdin ({"id", "cmd", ...args}) → JSON lines on stdout ({"id", "ok", "result"|"error"}).
Unsolicited events: {"event": "selection", "board": <file>, "refs": [...], "nets": [...]} when the
selection in KiCad's PCB editor changes, and {"event": "status", ...} when the connection changes.

Every change goes through a KiCad commit, so the user can undo it in KiCad (Ctrl+Z). The bridge
never saves unless asked ("save").
"""
import json
import os
import sys
import threading
import time
import traceback

out_lock = threading.Lock()


def emit(obj):
    with out_lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


try:
    from kipy import KiCad
    from kipy.board import Board
    from kipy.board_types import FootprintInstance, Pad, Track, ArcTrack, Via, Zone
    from kipy.geometry import Angle, Vector2
    from kipy.proto.common.types import base_types_pb2
    KIPY_ERROR = None
except Exception as e:  # pragma: no cover - reported to the app
    KIPY_ERROR = f"{type(e).__name__}: {e}"

NM = 1_000_000.0


class Bridge:
    def __init__(self):
        self.kicad = None
        self.version = None
        self.last_sel = None
        self.lock = threading.Lock()
        self.status = {"connected": False}

    # ------------------------------------------------------------ connection
    def connect(self):
        if self.kicad is not None:
            try:
                self.kicad.ping()
                return self.kicad
            except Exception:
                self.kicad = None
        k = KiCad(timeout_ms=3000)
        k.ping()
        self.kicad = k
        try:
            self.version = str(k.get_version())
        except Exception:
            self.version = None
        return k

    @staticmethod
    def canon(path):
        """Canonical absolute path for identity checks (symlinks resolved, case folded on Windows)."""
        p = os.path.realpath(os.path.abspath(path))
        return os.path.normcase(p)

    @staticmethod
    def doc_path(d):
        """Full path of an open PCB document: project folder + board file name ('' when unknown)."""
        folder = getattr(getattr(d, "project", None), "path", "") or ""
        name = d.board_filename or ""
        if not folder or not name:
            return ""
        return os.path.join(folder, name) if not os.path.isabs(name) else name

    def docs(self):
        k = self.connect()
        return k.get_open_documents(base_types_pb2.DocumentType.DOCTYPE_PCB)

    def boards(self):
        return [self.doc_path(d) or d.board_filename for d in self.docs()]

    def board(self, want):
        """The open board whose full path is `want`. Same file names in other folders never match;
        an unknown document path or several matches are refused. Called before every command."""
        if not want:
            raise RuntimeError("no board path given; SlashPCB must name the exact board file")
        target = self.canon(want)
        docs = self.docs()
        hits = [d for d in docs if self.doc_path(d) and self.canon(self.doc_path(d)) == target]
        if len(hits) == 1:
            return Board(self.kicad._client, hits[0])
        if len(hits) > 1:
            raise RuntimeError(f"{len(hits)} open KiCad documents resolve to {want}; refusing an ambiguous target")
        unknown = [d.board_filename for d in docs if not self.doc_path(d)]
        open_list = ", ".join(self.doc_path(d) or f"{d.board_filename} (folder unknown)" for d in docs) or "none"
        if unknown:
            raise RuntimeError(f"KiCad does not report the folder of {', '.join(unknown)}; cannot confirm it is {want} (open: {open_list})")
        raise RuntimeError(f"KiCad has not opened {want} (open: {open_list})")

    def refresh_status(self):
        st = {"connected": False}
        try:
            boards = self.boards()
            st = {"connected": True, "version": self.version, "boards": boards}
        except Exception as e:
            st = {"connected": False, "error": str(e)[:300]}
        if st != self.status:
            self.status = st
            emit({"event": "status", **st})
        return st

    # ------------------------------------------------------------ helpers
    @staticmethod
    def field_text(f):
        try:
            return f.text.value
        except Exception:
            return ""

    def footprints_by_ref(self, b, refs):
        want = set(refs)
        return [fp for fp in b.get_footprints() if self.field_text(fp.reference_field) in want]

    def selection(self, b):
        refs, nets = set(), set()
        for it in b.get_selection():
            if isinstance(it, FootprintInstance):
                refs.add(self.field_text(it.reference_field))
            elif isinstance(it, Pad):
                try:
                    nets.add(it.net.name)
                except Exception:
                    pass
            elif isinstance(it, (Track, ArcTrack, Via, Zone)):
                try:
                    nets.add(it.net.name)
                except Exception:
                    pass
        return sorted(r for r in refs if r), sorted(n for n in nets if n)

    # ------------------------------------------------------------ commands
    def cmd_status(self, a):
        return self.refresh_status()

    def cmd_get_selection(self, a):
        b = self.board(a.get("board"))
        refs, nets = self.selection(b)
        return {"refs": refs, "nets": nets}

    def cmd_select(self, a):
        b = self.board(a.get("board"))
        b.clear_selection()
        fps = self.footprints_by_ref(b, a.get("refs") or [])
        if fps:
            b.add_to_selection(fps)
        self.last_sel = (self.doc_path(b.document), tuple(sorted(a.get("refs") or [])), ())
        return {"selected": len(fps)}

    def cmd_move(self, a):
        """Move/rotate footprints: moves=[{ref, x?, y?, rot?, dx?, dy?}] in mm/degrees. One undo step."""
        b = self.board(a.get("board"))
        moves = {m["ref"]: m for m in a.get("moves") or []}
        fps = self.footprints_by_ref(b, list(moves))
        missing = sorted(set(moves) - {self.field_text(f.reference_field) for f in fps})
        if missing:
            raise RuntimeError(f"not on the board: {', '.join(missing)}")
        commit = b.begin_commit()
        try:
            done = []
            for fp in fps:
                m = moves[self.field_text(fp.reference_field)]
                p = fp.position
                x = m["x"] if "x" in m else p.x / NM + m.get("dx", 0)
                y = m["y"] if "y" in m else p.y / NM + m.get("dy", 0)
                fp.position = Vector2.from_xy_mm(float(x), float(y))
                if "rot" in m:
                    fp.orientation = Angle.from_degrees(float(m["rot"]))
                done.append({"ref": m["ref"], "x": round(float(x), 4), "y": round(float(y), 4), "rot": m.get("rot")})
            b.update_items(fps)
            b.push_commit(commit, a.get("message") or "SlashPCB: move footprints")
        except Exception:
            b.drop_commit(commit)
            raise
        return {"moved": done}

    def cmd_set_field(self, a):
        """Set Value (or Reference/Datasheet/Description) of footprints on the open board. One undo step."""
        b = self.board(a.get("board"))
        name = a["field"]
        fps = self.footprints_by_ref(b, a.get("refs") or [])
        if not fps:
            raise RuntimeError("no matching footprints")
        attr = {"Value": "value_field", "Reference": "reference_field", "Datasheet": "datasheet_field", "Description": "description_field"}.get(name)
        if not attr:
            raise RuntimeError("KiCad's API exposes only Value, Reference, Datasheet and Description on footprints; edit other fields in the schematic")
        commit = b.begin_commit()
        try:
            for fp in fps:
                f = getattr(fp, attr)
                f.text.value = str(a["value"])
                setattr(fp, attr, f)
            b.update_items(fps)
            b.push_commit(commit, a.get("message") or f"SlashPCB: set {name}")
        except Exception:
            b.drop_commit(commit)
            raise
        return {"changed": len(fps)}

    def cmd_refill_zones(self, a):
        self.board(a.get("board")).refill_zones()
        return {"refilled": True}

    def cmd_save(self, a):
        self.board(a.get("board")).save()
        return {"saved": True}

    # ------------------------------------------------------------ selection watcher
    def watch(self):
        while True:
            time.sleep(0.6)
            try:
                with self.lock:
                    st = self.refresh_status()
                    if not st.get("connected") or not st.get("boards"):
                        continue
                    for d in self.docs():
                        path = self.doc_path(d)
                        if not path:
                            continue
                        b = Board(self.kicad._client, d)
                        sel = self.selection(b)
                        key = (path, tuple(sel[0]), tuple(sel[1]))
                        if key != self.last_sel:
                            self.last_sel = key
                            emit({"event": "selection", "board": path, "refs": sel[0], "nets": sel[1]})
            except Exception:
                self.kicad = None


def main():
    if KIPY_ERROR:
        emit({"event": "status", "connected": False, "error": f"kicad-python not available: {KIPY_ERROR}"})
    br = Bridge()
    if not KIPY_ERROR:
        threading.Thread(target=br.watch, daemon=True).start()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        rid = msg.get("id")
        try:
            if KIPY_ERROR:
                raise RuntimeError(f"kicad-python not available: {KIPY_ERROR}")
            fn = getattr(br, "cmd_" + str(msg.get("cmd")), None)
            if not fn:
                raise RuntimeError(f"unknown command {msg.get('cmd')}")
            with br.lock:
                res = fn(msg)
            emit({"id": rid, "ok": True, "result": res})
        except Exception as e:
            emit({"id": rid, "ok": False, "error": str(e)[:1000], "trace": traceback.format_exc()[-1500:]})


if __name__ == "__main__":
    main()
