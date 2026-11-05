"""Build/credential regression tests with dummy values only: python3 -m unittest discover -s tools -p 'test_*.py'."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
import build_site
import config


class BuildTests(unittest.TestCase):
    def test_ribbon_renderer_ships_in_website_and_inline_preview(self):
        page = (Path(config.ROOT) / 'web' / 'page.html').read_text()
        with tempfile.TemporaryDirectory() as directory, patch.object(build_site, 'SITE', directory):
            html = build_site.build_website(page, 'styles', 'app', 'geometry', 'ribbons', [], False)
            self.assertEqual((Path(directory) / 'ribbons.js').read_text(), 'ribbons')
            self.assertIn('<script id="ribbons-src" src="ribbons.js?v=', html)
            self.assertLess(html.index('id="ribbons-src"'), html.index('id="geom-src"'))
            self.assertNotIn('/*RIBBONS_JS*/', html)
        with patch.object(build_site, 'maplibre_css', return_value='map styles'):
            inline = build_site.build_artifact(page, 'styles', 'app', 'geometry', 'ribbons', [])
            self.assertIn('<script id="ribbons-src">ribbons</script>', inline)

    def test_existing_repository_secret_names(self):
        with patch.dict(os.environ, {"WSP_KEY": "ferry-example", "WSDOT_KEY": "road-example"}, clear=True):
            self.assertEqual(config.wsf_code(), "ferry-example")
            self.assertEqual(config.wsdot_code(), "road-example")

    def test_explicit_ferry_code_takes_precedence(self):
        with patch.dict(os.environ, {"WSF_ACCESS_CODE": "explicit-example", "WSDOT_KEY": "shared-example"}, clear=True):
            self.assertEqual(config.wsf_code(), "explicit-example")

    def test_keyless_build_does_not_read_credentials(self):
        with patch.object(build_site, "oba_key", side_effect=AssertionError("must not read key")), patch.object(build_site, "wsf_code", side_effect=AssertionError("must not read key")), patch.object(build_site, "wsdot_code", side_effect=AssertionError("must not read key")):
            result = build_site.live_js(False)
            self.assertIn(build_site.KEY_PLACEHOLDER, result)
            self.assertIn(build_site.WSF_PLACEHOLDER, result)
            self.assertIn(build_site.WSDOT_PLACEHOLDER, result)

    def test_keys_are_json_encoded_and_cannot_close_script(self):
        dummy = 'example/with&special"characters</script>'
        with patch.dict(os.environ, {"OBA_API_KEY": dummy, "WSDOT_KEY": dummy}, clear=True):
            result = build_site.live_js(True)
            self.assertNotIn("</script>", result)
            decoded = json.loads(result.split(" = ", 1)[1][:-1])
            self.assertEqual(decoded["key"], dummy)
            self.assertEqual(decoded["wsdot"]["code"], dummy)


if __name__ == "__main__":
    unittest.main()
