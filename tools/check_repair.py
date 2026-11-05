"""Source-coverage regression checks. Requires requirements.txt; run with python3 tools/check_repair.py."""
from pathlib import Path
from math import cos, sin, tau
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
import build_graph
from repair_network import restore_spans
from restore_turnarounds import restore_turnarounds
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

    def test_large_span_repair_ignores_small_detours(self):
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

    def test_turnaround_split_across_trips_replaces_clipped_tail(self):
        ring = [(20 * cos(i * tau / 16), 20 * sin(i * tau / 16)) for i in range(16)]
        ring.append(ring[0])
        approach = (100, 0)
        shape = MultiLineString([[approach, *ring[:7]], [*ring[6:], approach]])
        tail = [approach, *ring[:5]]
        g = build_graph.Graph({0: approach, 1: tail[-1]}, [(0, 1, tail)])
        g.edges[0].update(lines=frozenset({"r", "s"}), order=["r", "s"], dirs={"s": 2})

        self.assertEqual(restore_turnarounds(g, {"r": shape}, {}), 1)
        route = [LineString(e["c"]) for e in g.edges.values() if "r" in e["lines"]]
        self.assertLess(LineString(ring).difference(unary_union(route).buffer(1)).length, 0.01)
        self.assertEqual(sum(line.is_ring for line in route), 1)
        loop = next(e for e in g.edges.values() if e["a"] == e["b"])
        self.assertIn(loop["dirs"]["r"], (1, 2))
        self.assertEqual(loop["lines"], {"r"})
        other = [LineString(e["c"]) for e in g.edges.values() if "s" in e["lines"]]
        self.assertLess(unary_union(other).hausdorff_distance(LineString(tail)), 0.01)
        self.assertEqual(restore_turnarounds(g, {"r": shape}, {}), 0)

    def test_passing_roundabout_arc_keeps_its_exit(self):
        arc = [(20 * cos(i * tau / 16), 20 * sin(i * tau / 16)) for i in range(5)]
        path = [(100, 0), *arc, (0, 100)]
        shape = MultiLineString([path])
        g = build_graph.Graph({0: path[0], 1: path[-1]}, [(0, 1, path)])
        g.edges[0].update(lines=frozenset({"r"}))
        self.assertEqual(restore_turnarounds(g, {"r": shape}, {}), 0)
        self.assertEqual(list(drawing(g).coords), path)

    def test_turnaround_with_omitted_approach_rejoins_route(self):
        ring = [(20 * cos(i * tau / 16), 20 * sin(i * tau / 16)) for i in range(16)]
        ring.append(ring[0])
        shape = MultiLineString([[(300, 0), *ring, (300, 0)]])
        g = build_graph.Graph({0: (300, 0), 1: (150, 0)}, [(0, 1, [(300, 0), (150, 0)])])
        g.edges[0].update(lines=frozenset({"r"}))

        self.assertEqual(restore_turnarounds(g, {"r": shape}, {}), 1)
        self.assertLess(drawing(g).distance(Point(80, 0)), 0.01)
        self.assertLess(LineString(ring).difference(drawing(g).buffer(1)).length, 0.01)

    def test_separate_turnaround_lanes_share_the_drawn_approach(self):
        angles = [0.15 + i * (tau - 0.3) / 16 for i in range(17)]
        arc = [(20 * cos(a), 20 * sin(a)) for a in angles]
        shape = MultiLineString([[(100, 3), *arc, (100, -3)]])
        tail = [(100, 0), *arc[:6]]
        g = build_graph.Graph({0: tail[0], 1: tail[-1]}, [(0, 1, tail)])
        g.edges[0].update(lines=frozenset({"r"}))

        self.assertEqual(restore_turnarounds(g, {"r": shape}, {}), 1)
        approach = next(iter(g.adj[0]))
        join = g.other(approach, 0)
        self.assertGreaterEqual(g.deg(join), 2)
        self.assertLess(LineString(arc).difference(drawing(g).buffer(1)).length, 0.01)


if __name__ == "__main__":
    unittest.main()
