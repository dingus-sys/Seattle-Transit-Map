"""Regression tests for Gorst geometry fixes in build_graph and repair_network."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
import build_graph
from repair_network import bridge_route_components
from shapely.geometry import LineString, MultiLineString, Point
from shapely.ops import unary_union


def _drawing(g):
    return unary_union([LineString(e["c"]) for e in g.edges.values()])


class GorstPipelineRegressionTests(unittest.TestCase):
    def test_bridge_prefers_closer_carriageway_over_opposite_part(self):
        g = build_graph.Graph(
            {0: (0, 56), 1: (100, 56), 2: (150, 56), 3: (250, 56)},
            [(0, 1, [(0, 56), (100, 56)]), (2, 3, [(150, 56), (250, 56)])],
        )
        for e in g.edges.values():
            e.update(lines=frozenset({"r"}), order=["r"], dirs={"r": 2})
        surface = {
            "r": MultiLineString([
                [(0, 0), (125, 2), (250, 0)],
                [(0, 56), (125, 56), (250, 56)],
            ])
        }

        self.assertEqual(bridge_route_components(g, surface), 1)
        self.assertGreater(_drawing(g).distance(Point(125, 2)), 50)
        self.assertLess(_drawing(g).distance(Point(125, 56)), 0.01)

    def test_bridge_skips_sideways_v_detour_when_only_opposite_part_matches(self):
        g = build_graph.Graph(
            {0: (0, 56), 1: (100, 56), 2: (150, 56), 3: (250, 56)},
            [(0, 1, [(0, 56), (100, 56)]), (2, 3, [(150, 56), (250, 56)])],
        )
        for e in g.edges.values():
            e.update(lines=frozenset({"r"}), order=["r"], dirs={"r": 2})
        surface = {"r": MultiLineString([[(0, 0), (125, 0), (250, 0)]])}

        self.assertEqual(bridge_route_components(g, surface), 1)
        self.assertGreater(_drawing(g).distance(Point(125, 0)), 50)

    def test_collapse_bubbles_peels_folded_dead_end_preserving_continuation(self):
        nodes = {
            0: (-1000, 0),
            1: (0, 0),
            2: (160, 55),
            3: (200, 20),
            4: (1200, 55),
            5: (200, -500),
        }
        edges = [
            (0, 1, [(-1000, 0), (0, 0)]),
            (1, 2, [(0, 0), (160, 55)]),
            (2, 4, [(160, 55), (1200, 55)]),
            (1, 3, [(0, 0), (200, 20)]),
            (2, 3, [(160, 55), (200, 20)]),
            (3, 5, [(200, 20), (200, -500)]),
        ]
        g = build_graph.Graph(nodes, edges)
        g.edges[0]["lines"] = frozenset({"r"})
        g.edges[1]["lines"] = frozenset({"r", "branch"})
        g.edges[2]["lines"] = frozenset({"r"})
        g.edges[3]["lines"] = frozenset({"r"})
        g.edges[4]["lines"] = frozenset({"r", "branch"})
        g.edges[5]["lines"] = frozenset({"branch"})
        routes = {
            "r": MultiLineString([
                [(-1000, 0), (0, 0), (160, 55), (1200, 55)],
                [(-1000, 0), (0, 0), (200, 20), (160, 55), (1200, 55)],
            ]),
            "branch": MultiLineString([[(0, 0), (160, 55), (200, 20), (200, -500)]]),
        }

        folded = build_graph.collapse_bubbles(g, routes=routes)
        self.assertEqual(folded, 1)
        r_edges = [e for e in g.edges.values() if "r" in e["lines"]]
        self.assertEqual(
            {frozenset((e["a"], e["b"])) for e in r_edges},
            {frozenset((0, 1)), frozenset((1, 2)), frozenset((2, 4))},
        )
        branch_edges = [e for e in g.edges.values() if "branch" in e["lines"]]
        self.assertEqual(
            {frozenset((e["a"], e["b"])) for e in branch_edges},
            {frozenset((1, 2)), frozenset((2, 3)), frozenset((3, 5))},
        )


if __name__ == "__main__":
    unittest.main()
