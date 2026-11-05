# Repository workflow

This project is `dingus-sys/Seattle-Transit-Map`, published from `main` to
https://dingus-sys.github.io/Seattle-Transit-Map/ by GitHub Actions.

- The user wants the agent to save finished changes to GitHub and handle publication.
  Do not leave completed work waiting for the user to push or upload files manually.
- Test complex changes locally when useful, then commit and publish the tested result.
  The regular authenticated Git connection works. On November 5, 2026, the GitHub connector
  could read the repository but its Git blob write returned 403; do not assume write access.
- Publish requested website updates after checks pass, unless the user asks for review-only
  or local-only work. Verify GitHub Pages and the live site before reporting success.
- Read `README.md` and `CLAUDE.md` for build steps, test hooks, data formats and credentials.
- Never commit or print API key values. Keep generated `site/` page files out of commits;
  the Pages workflow builds them. Fix generated data in `pipeline/`, then regenerate it.
- Read the current remote head before writing and preserve others' work. Use fast-forward
  updates or an expected-SHA check. Never force-push.
