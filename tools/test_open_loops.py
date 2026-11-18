"""repair_network.open_skinny_loops: an out-and-back drawn as a flattened loop becomes a
dead-end stub to its turnaround; a real loop around a block stays a loop.
Run: python tools/test_open_loops.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "pipeline"))
import build_graph as graph  # noqa: E402
from repair_network import open_skinny_loops  # noqa: E402


class OpenSkinnyLoops(unittest.TestCase):
    def make(self, loops):
        g = graph.Graph({0: (0.0, 0.0), 1: (-500.0, 0.0)}, [])
        g.add(1, 0, [(-500.0, 0.0), (0.0, 0.0)], frozenset({"r"}))
        ids = [g.add(0, 0, c, frozenset({"r"})) for c in loops]
        return g, ids

    def test_out_and_back_becomes_a_stub(self):
        # 207 m out along a street and back, as Island Transit 4 at Troxell Rd
        g, (loop,) = self.make([[(0, 0), (1, 0.2), (207, 0.5), (1, 0.3), (0, 0)]])
        self.assertEqual(open_skinny_loops(g), (1, 0))
        self.assertNotIn(loop, g.edges)
        stub = [e for e in g.edges.values() if e["a"] == 0 and e["b"] != 1]
        self.assertEqual(len(stub), 1)
        tip = g.pos[stub[0]["b"]]
        self.assertAlmostEqual(tip[0], 207, delta=0.01)
        self.assertEqual(g.deg(stub[0]["b"]), 1)
        self.assertEqual(stub[0]["dirs"], {"r": 0})
        self.assertFalse(any(e["a"] == e["b"] for e in g.edges.values()))

    def test_round_loop_is_kept(self):
        g, (loop,) = self.make([[(0, 0), (80, 0), (80, 80), (0, 80), (0, 0)]])
        self.assertEqual(open_skinny_loops(g), (0, 0))
        self.assertIn(loop, g.edges)

    def test_tiny_spike_is_removed(self):
        g, (loop,) = self.make([[(0, 0), (6, 0), (0.2, 0.1), (0, 0)]])
        self.assertEqual(open_skinny_loops(g), (0, 1))
        self.assertEqual(len(g.edges), 1)


if __name__ == "__main__":
    unittest.main()
