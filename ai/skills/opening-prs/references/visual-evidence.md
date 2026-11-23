# Visual evidence

The repo's own screenshot or reviewer guide wins over this file, and so does any installed `opening-prs-*` extension's evidence reference. Load `capturing-ui` for the capture itself; this file carries what happens to its output.

## Order, and why

1. **Check before uploading.** Look at every file in `capturing-ui`'s `preview.html`, including the GIF and frames under Other files, and upload without asking. Uploads are public and permanent, so stop and ask only when a file may show customer data, secrets, or internal information.
2. **Upload per repo.** An extension or repo rule names the upload command. Otherwise, after Step 6 has created the PR (or in update mode), ask the carbon unit to drag the checked files into the PR description editor on GitHub and paste back what it inserts. Write each URL as a `![<stem>](<url>)` line, the stem being its file name without `.png`, into the upload output; the byte check below pairs each URL with its file. Verify each URL: `curl -sL -o /dev/null -w '%{http_code} %{size_download}'` must match the local byte count.
3. **Embed.** `node ~/.claude/skills/capturing-ui/scripts/evidence.mjs markdown --uploaded <upload output> --area <slug> --heading <title>` prints the four-row before/after table the reviewer's guide asks for; it refuses when an upload is missing, so no cell is silently empty.
