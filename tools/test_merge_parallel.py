"""merge_parallel.merge_parallel_copies: routes repaired as separate copies along one street
end up on one shared edge (Totem Lake Transit Center); forks, parallel streets a block apart
and a surface street beside a freeway stay apart.
Run: python tools/test_merge_parallel.py"""
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "pipeline"))
import build_graph as graph  # noqa: E402
from merge_parallel import merge_parallel_copies  # noqa: E402
from shapely.geometry import LineString, box  # noqa: E402


def make(paths):
    """paths: [(coords, {slug: dir})]; nodes are the path ends, shared when they coincide."""
    g = graph.Graph({}, [])
    nodes = {}
    for coords, dirs in paths:
        ends = []
        for p in (coords[0], coords[-1]):
            if p not in nodes:
                nodes[p] = len(nodes)
                g.pos[nodes[p]] = p
            ends.append(nodes[p])
        k = g.add(ends[0], ends[1], coords, frozenset(dirs))
        g.edges[k].update(order=sorted(dirs), dirs=dict(dirs))
    return g


def carrying(g, slug):
    return [e for e in g.edges.values() if slug in e["lines"]]


def total(g, slug):
    return sum(LineString(e["c"]).length for e in carrying(g, slug))


def check_ends(test, g):
    for e in g.edges.values():
        test.assertEqual(tuple(e["c"][0]), tuple(g.pos[e["a"]]))
        test.assertEqual(tuple(e["c"][-1]), tuple(g.pos[e["b"]]))


class MergeParallelCopies(unittest.TestCase):
    def test_two_copies_of_a_loop_become_one(self):
        # Totem Lake: the 225 and the 239 each had their own loop a few meters apart, from one node
        loop = [(0, 0), (200, 0), (200, -80), (0, -80), (0, 0)]
        wobble = [(0, 0), (200, 4), (204, -80), (0, -76), (0, 0)]
        g = make([(loop, {"225": 1}), (wobble, {"239": 1}), ([(-300, 0), (0, 0)], {"225": 0, "239": 0})])
        merge_parallel_copies(g)
        loops = [e for e in g.edges.values() if e["a"] == e["b"]]
        self.assertEqual(len(loops), 1)
        self.assertEqual(loops[0]["lines"], {"225", "239"})
        self.assertEqual(loops[0]["dirs"], {"225": 1, "239": 1})
        check_ends(self, g)

    def test_copy_along_a_corridor_joins_it(self):
        # a corridor carrying two routes, and a third route repaired from its own shape 6 m off it
        # for 400 m in the middle, then turning away on side streets at both ends
        g = make([([(0, 0), (1000, 0)], {"a": 0, "b": 0}),
                  ([(300, 200), (300, 6), (700, 6), (700, 200)], {"c": 1})])
        stretches, _, _ = merge_parallel_copies(g)
        self.assertGreaterEqual(stretches, 1)
        shared = [e for e in g.edges.values() if e["lines"] == {"a", "b", "c"}]
        self.assertEqual(len(shared), 1)
        line = LineString(shared[0]["c"])
        self.assertAlmostEqual(line.length, 400, delta=12)
        self.assertLess(max(abs(y) for _, y in shared[0]["c"]), 0.01)  # the corridor's geometry is kept
        # c runs (300,6) -> (700,6), the same way as the corridor's coordinates
        self.assertEqual(shared[0]["dirs"]["c"], 1)
        # c is still one connected path: in from the north, along the corridor, out to the north
        self.assertAlmostEqual(total(g, "c"), 400 + 2 * 194, delta=25)
        check_ends(self, g)

    def test_opposite_direction_copy_flips_its_direction(self):
        g = make([([(0, 0), (500, 0)], {"a": 1, "b": 1}), ([(500, 5), (0, 5)], {"c": 1})])
        merge_parallel_copies(g)
        (e,) = g.edges.values()
        self.assertEqual(e["lines"], {"a", "b", "c"})
        self.assertEqual(e["dirs"]["c"], 2)

    def test_same_route_both_ways_becomes_two_way(self):
        g = make([([(0, 0), (500, 0)], {"a": 1, "b": 1}), ([(500, 5), (0, 5)], {"a": 1})])
        merge_parallel_copies(g)
        (e,) = g.edges.values()
        self.assertEqual(e["dirs"]["a"], 0)
        self.assertEqual(e["dirs"]["b"], 1)

    def test_short_split_is_folded_in(self):
        # the copy leaves the street for 40 m (a corner cut, a pull-in) and comes back
        cut = [(0, 6), (200, 6), (215, 22), (235, 22), (250, 6), (500, 6)]
        g = make([([(0, 0), (500, 0)], {"a": 0, "b": 0}), (cut, {"c": 0})])
        merge_parallel_copies(g)
        self.assertEqual(len(g.edges), 1)
        self.assertEqual(next(iter(g.edges.values()))["lines"], {"a", "b", "c"})

    def test_long_split_stays_apart(self):
        # a real 300 m detour on another street rejoins later: keep it
        detour = [(0, 6), (200, 6), (200, 120), (500, 120), (500, 6), (900, 6)]
        g = make([([(0, 0), (900, 0)], {"a": 0, "b": 0}), (detour, {"c": 0})])
        merge_parallel_copies(g)
        far = [e for e in g.edges.values() if "c" in e["lines"] and max(y for _, y in e["c"]) > 100]
        self.assertTrue(far, "the detour was folded away")

    def test_parallel_street_a_block_away_stays(self):
        g = make([([(0, 0), (800, 0)], {"a": 0}), ([(0, 60), (800, 60)], {"b": 0})])
        self.assertEqual(merge_parallel_copies(g), (0, 0, 0))
        self.assertEqual(len(g.edges), 2)

    def test_fork_at_a_shallow_angle_stays(self):
        # two routes leave a junction 20 degrees apart: within 15 m of each other for the first
        # 40 m, but that is a fork, not a shared street
        t = math.radians(20)
        g = make([([(0, 0), (600, 0)], {"a": 0, "b": 0}),
                  ([(0, 0), (600 * math.cos(t), 600 * math.sin(t))], {"c": 0}),
                  ([(-300, 0), (0, 0)], {"a": 0, "b": 0, "c": 0})])
        merge_parallel_copies(g)
        self.assertEqual(len(carrying(g, "c")), 2)
        self.assertTrue(all("a" not in e["lines"] for e in carrying(g, "c") if e["c"][-1][1] > 1))

    def test_crossing_street_stays(self):
        g = make([([(0, 0), (600, 0)], {"a": 0}), ([(300, -300), (300, 300)], {"b": 0})])
        self.assertEqual(merge_parallel_copies(g), (0, 0, 0))

    def test_freeway_bubble_is_folded_but_street_beside_freeway_is_not(self):
        fwy = box(-50, -40, 2050, 40)
        # one route in the express lanes 30 m from the main lanes between the same two junctions
        g = make([([(0, 0), (2000, 0)], {"a": 0}), ([(0, 0), (100, 30), (1900, 30), (2000, 0)], {"b": 0})])
        merge_parallel_copies(g, mask=fwy)
        self.assertEqual([e["lines"] for e in g.edges.values()], [{"a", "b"}])
        # a city street under the freeway, 30 m off it, joining it only at one end, keeps its own line
        g = make([([(0, 0), (2000, 0)], {"a": 0}), ([(0, 0), (100, 30), (2000, 30), (2100, 200)], {"b": 0})])
        merge_parallel_copies(g, mask=fwy)
        self.assertEqual(len(g.edges), 2)

    def test_idempotent(self):
        loop = [(0, 0), (200, 0), (200, -80), (0, -80), (0, 0)]
        wobble = [(0, 0), (200, 4), (204, -80), (0, -76), (0, 0)]
        g = make([(loop, {"225": 1}), (wobble, {"239": 1}), ([(-300, 0), (0, 0)], {"225": 0, "239": 0}),
                  ([(0, 0), (0, 300)], {"930": 0}), ([(0, 0), (200, 6), (204, -80), (0, -80), (0, 0)], {"930": 1})])
        merge_parallel_copies(g)
        before = sorted((e["a"], e["b"], tuple(sorted(e["lines"]))) for e in g.edges.values())
        self.assertEqual(merge_parallel_copies(g), (0, 0, 0))
        after = sorted((e["a"], e["b"], tuple(sorted(e["lines"]))) for e in g.edges.values())
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
