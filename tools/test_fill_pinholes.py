"""fill_pinholes (tiled) must match labelling the whole raster at once.
Run: python tools/test_fill_pinholes.py"""
import os
import sys
import unittest

import numpy as np
from scipy import ndimage

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "pipeline"))
from build_graph import fill_pinholes  # noqa: E402


def global_fill(arr, max_area):
    lab, _ = ndimage.label(~arr, output=np.int32)
    small = np.bincount(lab.ravel()) < max_area
    small[0] = False
    return arr | small[lab]


class FillPinholes(unittest.TestCase):
    def test_matches_whole_raster_labelling(self):
        rng = np.random.default_rng(7)
        for density in (0.45, 0.6, 0.75):
            arr = ndimage.binary_dilation(rng.random((700, 900)) < density * 0.05, iterations=3)
            arr |= rng.random(arr.shape) < 0.02
            want = global_fill(arr.copy(), 31)
            got = fill_pinholes(arr.copy(), 31, tile=128, margin=40)
            self.assertTrue(np.array_equal(want, got), f"tiled fill differs at density {density}")

    def test_specks_across_tile_borders_are_filled(self):
        arr = np.ones((300, 300), dtype=bool)
        arr[126:131, 126:131] = False          # a 25-pixel speck right on a tile corner
        arr[10:200, 60:62] = False             # a long thin gap: far larger than a speck
        got = fill_pinholes(arr.copy(), 31, tile=128, margin=40)
        self.assertTrue(got[126:131, 126:131].all())
        self.assertFalse(got[10:200, 60:62].any())


if __name__ == "__main__":
    unittest.main()
