# Find the code

A product site or a "closed source" label usually still has public code behind it. Look in every place below before settling on ideas only, keeping the first five hits per place.

1. **Gated or marketing page.** Take the product and company names from the page, then search GitHub for them: `gh search repos '<product>' --limit 5` and `gh search repos --owner <org> --limit 20`. A page that hides its resource behind a form or a social post usually links the repo from the post, the footer, or the docs.
2. **The owner's repos.** List the org's or author's public repos on GitHub and GitLab, and keep those that touch the piece in focus: SDKs, examples, plugins, CLIs, MCP servers, file-format specs, templates.
3. **Published packages.** Search the registries by product and org name: `npm search <name>`, `https://pypi.org/search/?q=<name>`, `https://crates.io/search?q=<name>`. A package page names its repository and license.
4. **Agent integrations.** MCP servers, Claude Code or Codex plugins, skills, and CLIs the product ships for agents, often in a separate repo or package from the product.
5. **Specs and docs.** An open file format, an API schema (OpenAPI, JSON Schema), and code examples in the docs.
6. **Shipped browser code.** For a web app with nothing else public, fetch the page's script bundles and any public sourcemap (`<bundle>.js.map`) as text into the scratchpad. Read it as data about how the product works; it carries the site's terms, so it is credited ideas only.

Fetch each artifact as Step 2 of the skill describes, and read each one's license on its own: an MIT SDK beside a closed app is copyable even when the app is not.

Write every artifact found, with its license, on the `Code found` line, or name each place searched when the hunt found nothing.
