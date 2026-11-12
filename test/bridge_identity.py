"""Live-link identity check with fake KiCad documents (no IPC connection, no KiCad edits).
Two revisions with the same board file name must never be confused."""
import importlib.util
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

sys.dont_write_bytecode = True
repo = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("bridge_under_test", repo / "python" / "kicad_bridge.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

failed = []
def check(cond, msg):
    if not cond:
        failed.append(msg)

with tempfile.TemporaryDirectory() as tmp:
    a, b = os.path.join(tmp, "frozen-original"), os.path.join(tmp, "derivative")
    os.makedirs(a); os.makedirs(b)
    for d in (a, b):
        open(os.path.join(d, "board.kicad_pcb"), "w").close()
    os.symlink(b, os.path.join(tmp, "link"))
    doc = lambda folder, name="board.kicad_pcb": SimpleNamespace(board_filename=name, project=SimpleNamespace(path=folder))
    m.Board = lambda client, d: SimpleNamespace(document=d, name=d.board_filename)
    br = m.Bridge()
    br.kicad = SimpleNamespace(_client=None)
    def opened(*docs):
        br.docs = lambda: list(docs)
    def refused(want):
        try:
            br.board(want)
            return False
        except RuntimeError:
            return True

    opened(doc(a))
    check(refused(os.path.join(b, "board.kicad_pcb")), "same file name in another folder was accepted")
    check(br.board(os.path.join(a, "board.kicad_pcb")).document.project.path == a, "the exact board was not selected")
    opened(doc(a), doc(b))
    check(br.board(os.path.join(b, "board.kicad_pcb")).document.project.path == b, "wrong document among two same-named boards")
    check(br.board(os.path.join(tmp, "link", "board.kicad_pcb")).document.project.path == b, "symlinked path not resolved to the same file")
    opened(doc(""))
    check(refused(os.path.join(a, "board.kicad_pcb")), "a document without a known folder was accepted")
    opened(doc(a), doc(a))
    check(refused(os.path.join(a, "board.kicad_pcb")), "an ambiguous target was accepted")
    check(refused(""), "a command without a board path was accepted")

print("bridge identity: " + ("ok" if not failed else "FAIL " + "; ".join(failed)))
sys.exit(1 if failed else 0)
