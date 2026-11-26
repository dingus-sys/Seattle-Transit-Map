"""The Pages workflow uploads and deploys one artifact per attempt.

Run 45679823877 (November 25, 2026) passed every check, then failed at deploy-pages: a re-run of
the job had left two artifacts named "github-pages" in the same run. The name has to carry the run
attempt, and the deploy step has to ask for the same name the upload step used.
"""
import pathlib
import re
import unittest

WORKFLOW = pathlib.Path(__file__).resolve().parent.parent / ".github" / "workflows" / "pages.yml"


class PagesWorkflowArtifactNames(unittest.TestCase):
    def setUp(self):
        self.text = WORKFLOW.read_text()

    def test_upload_name_carries_the_attempt(self):
        m = re.search(r"upload-pages-artifact@v\d+\s*\n\s*with:\s*\n(?:\s+#.*\n)*\s*name:\s*(.+)", self.text)
        self.assertIsNotNone(m, "upload-pages-artifact has no name")
        self.assertIn("github.run_attempt", m.group(1))

    def test_deploy_asks_for_the_same_name(self):
        up = re.search(r"upload-pages-artifact@v\d+\s*\n\s*with:\s*\n\s*name:\s*(.+)", self.text)
        dep = re.search(r"deploy-pages@v\d+\s*\n\s*with:\s*\n\s*artifact_name:\s*(.+)", self.text)
        self.assertIsNotNone(up)
        self.assertIsNotNone(dep, "deploy-pages does not name its artifact")
        self.assertEqual(up.group(1), dep.group(1))


if __name__ == "__main__":
    unittest.main()
