# Vendoring notes — bmazzarol-bunnings fork

This fork tracks [nicobailon/pi-web-access](https://github.com/nicobailon/pi-web-access)
(`upstream` remote) and carries local modifications on top.

## Base

| Upstream ref | Upstream version |
|---|---|
| `896d75b` (`chore(release): v0.48.0`) | 0.48.0 |

Re-verify against upstream after any sync.

## Local changes

### 1. New `github` search provider (explicit-only)

Files:

- **`github-search.ts`** (new) — searches via the public GitHub MCP server
  (`https://api.githubcopilot.com/mcp`, streamable HTTP). Same backend Copilot CLI
  exposes as its built-in `web_search` tool. The `web_search` toolset is enabled with
  the `X-MCP-Toolsets: web_search` header (plus `X-MCP-Host: copilot-cli`).
  Auth: `githubToken` in `~/.pi/agent/web-search.json`, `GITHUB_TOKEN` env, or
  `gh auth token` (in that order). `domainFilter`/`recencyFilter` are encoded as
  natural-language constraints appended to the query (the GitHub tool accepts only
  a `query` argument). `numResults` truncates results.
- **`gemini-search.ts`** —
  - import of `isGithubSearchAvailable` / `searchWithGithub`
  - `"github"` appended to `RESOLVED_SEARCH_PROVIDERS`
  - one line each in `searchWithAnySearch` and `isResolvedProviderAvailable`
  - `GitHub` added to the "Explicit-only providers" comment
- **`index.ts`** — import of `isGithubSearchAvailable`; `github` entry in the
  `getProviderAvailability` providers map.

Deliberately **not** added to `ALL_SEARCH_PROVIDERS`: `github` is explicit-only,
so `auto`/`all` never fan out to it (matches the convention for `kimi`, `xai`,
`tabstack`, etc.). Select it with `provider: "github"`.

## Why

Pi's web search providers are all hard-coded; there is no custom-provider hook.
Forking is the only clean way to add one without patching `node_modules`
(would be lost on every package update). Upstream may add this provider itself;
if so, drop the local changes and re-pin to upstream.

## Syncing with upstream

```bash
cd ~/pi-web-access
git fetch upstream
git rebase upstream/main          # conflicts expected only in gemini-search.ts / index.ts
node -e "import('./github-search.ts').then(async m => { console.log('available:', await m.isGithubSearchAvailable()); const r = await m.searchWithGithub('latest Node.js LTS', { numResults: 3 }); console.log(r.results.length, 'results'); })"
npx tsc --noEmit -p tsconfig.json
```

Then update the Base table above and push. Pi picks up the new ref on start
(git packages are reconciled to the configured ref; a commit-hash ref is pinned).

## Install

Installed as a pi git package (replaces `npm:pi-web-access`):

```bash
pi remove npm:pi-web-access
pi install git:github.com/bmazzarol-bunnings/pi-web-access
```
