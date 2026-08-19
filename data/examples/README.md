# Example data

Everything in this directory is **placeholder data**. None of these URLs point at real
TikTok or Instagram posts, and none of them are known-good social media test fixtures —
they exist purely to exercise the pipeline (input parsing, normalization, de-duplication,
queueing, retry accounting, JSONL output, run summaries).

| File                  | Purpose                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `tiktok-urls.txt`     | Newline-delimited input, including comments, a duplicate, an unparseable line and an unsupported host, so the input validation path is visible. |
| `instagram-urls.json` | JSON-array input, including one duplicate.                                                                                                      |
| `mixed-urls.txt`      | Both platforms in one batch, for the auto-routing path.                                                                                         |
| `sample-output.jsonl` | **Synthetic** example of the output contract.                                                                                                   |
| `tiktok-apify-smoke.txt` | Four unique TikTok posts for the Apify comparison benchmark, one supplied twice so video-id de-duplication is visible before anything is billed. |

## About `sample-output.jsonl`

The metric values in that file are invented — they illustrate the row shape, not real
engagement numbers. It shows the four cases worth understanding:

1. a failure row from the current placeholder scrapers (`status: "error"`, `not_implemented`)
2. a successful row with metrics populated and unavailable fields left `null`
3. **the same `video_id` and URL appearing twice** with different `scraped_at` values —
   repeated scrapes are supposed to append, not update; `video_id` is not a key
4. a permanent failure (`status: "not_found"`), which is recorded rather than dropped

Real runs write to the `output/` directory, which is gitignored.
