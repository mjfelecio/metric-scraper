# Acceptance datasets

These files are the presentation and acceptance inputs described in
`research/GOAL/SPECIFICATIONS.txt`.

| Platform  | Small valid smoke set    | Small invalid smoke set    | Full valid set            | Full invalid set            |
| --------- | ------------------------ | -------------------------- | ------------------------- | --------------------------- |
| TikTok    | `tiktok-valid-10.txt`    | `tiktok-invalid-10.txt`    | `tiktok-valid-100.txt`    | `tiktok-invalid-100.txt`    |
| Instagram | `instagram-valid-10.txt` | `instagram-invalid-10.txt` | `instagram-valid-100.txt` | `instagram-invalid-100.txt` |

The 10-link files are subsets of the corresponding 100-link files. Valid files
contain distinct public posts and cover short redirects, alternate paths, query
parameters, old/recent posts, low/high views, and small/large creators. Invalid
files contain only deliberately bad, unavailable, non-video, or wrong-platform
inputs for error-handling demonstrations.

Validate without scraping:

```powershell
pnpm exec tsx src/cli/index.ts validate data/acceptance/tiktok-valid-100.txt --platform tiktok
pnpm exec tsx src/cli/index.ts validate data/acceptance/instagram-valid-100.txt --platform instagram
```

Run a live smoke test:

```powershell
pnpm exec tsx src/cli/index.ts tiktok data/acceptance/tiktok-valid-10.txt --concurrency 2 --target-rpm 10 --max-attempts 1
pnpm exec tsx src/cli/index.ts instagram data/acceptance/instagram-valid-10.txt --concurrency 2 --target-rpm 10 --max-attempts 1
```

Public posts can be removed or made private after this dataset is committed. A
live validation date and results should therefore be recorded with acceptance
evidence rather than treating the files as permanent fixtures.
