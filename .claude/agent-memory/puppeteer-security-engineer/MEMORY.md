# Memory Index

- [project_puppeteer_cleanup_invariant.md](project_puppeteer_cleanup_invariant.md) — Every adapter.login() must be wrapped in try/finally with adapter.cleanup() in route handlers; otherwise Chromium leaks → Cloud Run OOM
