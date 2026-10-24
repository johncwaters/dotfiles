# Visual evidence

The repo's own screenshot or reviewer guide wins over this file, and so does any installed `opening-prs-*` extension's evidence reference. Load `capturing-ui` for the capture itself; this file carries what happens to its output.

## Order, and why

1. **Approve before uploading.** Get approval for the exact files in `capturing-ui`'s `preview.html`, including the GIF and frames under Other files. Uploads are public and permanent.
2. **Upload per repo.** An extension or repo rule names the upload command. Otherwise, after Step 6 has created the PR (or in update mode), ask the carbon unit to drag the approved files into the PR description editor on GitHub and paste back what it inserts. Write each URL as a `![<stem>](<url>)` line, the stem being its file name without `.png`, into the upload output; the byte check below pairs each URL with its file. Verify each URL: `curl -sL -o /dev/null -w '%{http_code} %{size_download}'` must match the local byte count.
3. **Embed.** `node ~/.claude/skills/capturing-ui/scripts/evidence.mjs markdown --uploaded <upload output> --area <slug> --heading <title>` prints the four-row before/after table the reviewer's guide asks for; it refuses when an upload is missing, so no cell is silently empty.
