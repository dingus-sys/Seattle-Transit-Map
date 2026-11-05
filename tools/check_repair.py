"""Source-coverage regression checks. Requires requirements.txt; run with python3 tools/check_repair.py."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
import build_graph
from repair_network import restore_spans
from shapely.geometry import LineString, MultiLineString, Point
from shapely.ops import unary_union


def network():
    g = build_graph.Graph({0: (0, 0), 1: (1000, 0)}, [(0, 1, [(0, 0), (1000, 0)])])
    g.edges[0].update(lines=frozenset({"r"}), order=["r"], dirs={"r": 2})
    return g


def drawing(g):
    return unary_union([LineString(e["c"]) for e in g.edges.values()])


class RepairTests(unittest.TestCase):
    def test_terminal_branch_is_restored_and_joined(self):
        g = network()
        shape = MultiLineString([[(0, 0), (1000, 0)], [(500, 0), (500, 800)]])
        self.assertEqual(restore_spans(g, {"r": shape}), 1)
        self.assertLess(drawing(g).distance(Point(500, 800)), 0.01)
        self.assertEqual(restore_spans(g, {"r": shape}), 0)

    def test_omitted_branch_with_no_loose_end_is_restored(self):
        g = network()
        shape = MultiLineString([[(0, 0), (1000, 0)], [(0, 0), (0, 600), (1000, 600), (1000, 0)]])
        self.assertGreater(restore_spans(g, {"r": shape}), 0)
        self.assertLess(drawing(g).distance(Point(500, 600)), 0.01)

    def test_isolated_source_parts_do_not_create_disconnected_islands(self):
        g = network()
        shape = MultiLineString([[(0, 0), (1000, 0)], [(0, 2000), (1000, 2000)]])
        self.assertEqual(restore_spans(g, {"r": shape}), 0)
        self.assertEqual(len(g.edges), 1)

    def test_small_terminal_loops_remain_simplified(self):
        g = network()
        shape = MultiLineString([[(0, 0), (1000, 0)], [(500, 0), (500, 200), (600, 200), (600, 0)]])
        self.assertEqual(restore_spans(g, {"r": shape}), 0)

    def test_splitting_retains_strand_order_and_one_way_direction(self):
        g = network()
        build_graph.split_edge(g, 0, (500, 0))
        self.assertEqual(len(g.edges), 2)
        for e in g.edges.values():
            self.assertEqual(e["order"], ["r"])
            self.assertEqual(e["dirs"], {"r": 2})


if __name__ == "__main__":
    unittest.main()
