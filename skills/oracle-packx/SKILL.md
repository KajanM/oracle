---
name: oracle-packx
description: >
  Bundle optimized code context with packx then send it to Oracle's MCP consult tool
  for GPT-5.4 Pro analysis. Use when the user wants to ask oracle about code with smart
  filtering, or run "packx oracle", "oracle with packx", or "bundle and ask oracle".
---

# Packx + Oracle Pipeline

You are a PIPELINE EXECUTOR. Your ONLY job is: packx bundle → `mcp__oracle__consult` → read output.log → summarize for user → optionally commit Oracle-driven implementation changes when the user explicitly asks.

**DO NOT** research the codebase yourself. **DO NOT** use Read/Grep/Glob to answer the user's question. **DO NOT** spawn subagents for research. The ENTIRE POINT of this skill is to send the question to GPT-5.4 Pro via Oracle — not to answer it yourself. If you catch yourself exploring code to formulate an answer, STOP and go back to the pipeline.

For packx flag reference, filter decision trees, and advanced features, see [references/packx-quick-reference.md](references/packx-quick-reference.md).

---

## THE PIPELINE (follow exactly, no skipping)

### Step 1: Choose a slug

**SLUG MUST BE 3-5 WORDS separated by hyphens.** Count the words OUT LOUD. Oracle rejects slugs outside this range.

- **GOOD:** `"review-auth-security-code"` (4 words), `"debug-type-error-fix"` (4 words)
- **BAD:** `"auth-review"` (2 words — REJECTED), `"review"` (1 word — REJECTED)

```bash
mkdir -p ~/.oracle/bundles
```

### Step 2: Preview with packx

Run a dry-run to check file count and estimate size. **Do not skip this step.**

```bash
packx --preview [your-filters]
```

**STOP** if 0 files match. Widen your filters (check `-i` uses `**/` prefix; check `-s` spelling).

If the target directory is NOT your cwd, wrap in a subshell: `(cd /path/to/project && packx ...)`

### Step 3: Build the bundle

## CRITICAL

We want bundles to be as close to 49k as possible. So if a bundle ends up < 40k, please attempt again to gather more context so that we can get better answers. If you don't include enough context, the oracle agent will have massive blindspots.

```bash
packx --limit 49k [filters] -f markdown --no-interactive --stdout > ~/.oracle/bundles/{slug}.txt
```

Required flags: `--limit 49k`, `-f markdown`, `--no-interactive`, `--stdout`.

If preview showed >200 files, add `--strip-comments --minify`.

### Step 4: Validate the bundle

```bash
test -s ~/.oracle/bundles/{slug}.txt && echo "OK" || echo "EMPTY"
```

**STOP** if empty. Go back to Step 2 and fix your filters.

### Step 5: Collect screenshots (optional)

If the user provided image paths (`.png`, `.jpg`, `.webp`, `.pdf`, etc.), verify they exist:

```bash
for f in /path/to/screenshot1.png; do test -f "$f" || echo "WARNING: $f not found"; done
```

These go into the `files` array alongside the bundle in Step 6.

### Step 6: Call `mcp__oracle__consult`

**THIS IS THE CRITICAL STEP. You MUST execute this MCP tool call. Do NOT skip it.**

```
mcp__oracle__consult({
  prompt: "[{slug}]\n\n{your detailed question here}",
  files: ["~/.oracle/bundles/{slug}.txt"],
  engine: "browser",
  model: "gpt-5.4-pro",
  browserModelLabel: "GPT-5.4 Pro",
  slug: "{slug}"
})
```

With screenshots, add them to `files` and set `browserAttachments: "always"`:

```
mcp__oracle__consult({
  prompt: "[{slug}]\n\n{your detailed question here}",
  files: ["~/.oracle/bundles/{slug}.txt", "/path/to/screenshot.png"],
  engine: "browser",
  model: "gpt-5.4-pro",
  browserModelLabel: "GPT-5.4 Pro",
  browserAttachments: "always",
  slug: "{slug}"
})
```


### Browser-mode durability and answer fidelity

Browser-mode sessions now persist remote `oracle serve` identity separately from Chrome runtime metadata:

- `~/.oracle/sessions/{slug}/meta.json` → `browser.remote` stores `host`, `runId`, `cursor`, status, retention, and conversation URL when known. It must never contain `remoteToken`.
- `browser.runtime` remains only Chrome/CDP details (`chromePort`, `tabUrl`, target id, etc.). Do not treat it as the remote serve run identity.
- If a local client disconnects while the remote browser run continues, first run `oracle session {slug}` or `mcp__oracle__sessions({ id: "{slug}", detail: true })`; retained remote NDJSON events can be replayed from `browser.remote.runId` while the serve buffer is still available.
- For high-fidelity answers, prefer `~/.oracle/sessions/{slug}/answer.raw.md` over `output.log` when present. `answer.html` may also exist for DOM/copy-button fidelity checks. `output.log` remains the human-readable transcript and may be less canonical for large Markdown/code-fence responses.
- If replay says the remote run is unavailable/GC'd, report the `browser.remote.unavailableReason` and retention window rather than retrying blindly.

### Step 7: Read the FULL response

The MCP tool only returns the **last 4000 bytes** (hardcoded truncation). The full response is on disk:

```
Read ~/.oracle/sessions/{slug}/answer.raw.md if present; otherwise read ~/.oracle/sessions/{slug}/output.log
```

If the file doesn't exist yet, check status with `mcp__oracle__sessions({ id: "{slug}", detail: true })`.

### Step 8: Summarize for the user

Present GPT-5.4 Pro's response — highest-priority findings first, then concrete recommendations. When possible, present the recommendations as discrete items so later implementation changes can be mapped back to them cleanly. If implementation is needed, suggest execution skills like `codex-swarm`.

If follow-up code changes are likely, also mention the optional commit path: after the user implements Oracle's recommendations, they can say `"commit"` and you should run Step 9 to inspect `git diff --staged` / `git diff`, map the actual changes back to Oracle's advice, and create a traceable git commit tied to `{slug}`.

### Step 9: Commit Phase (optional)

Only run this step if the user explicitly asks for it **after implementation** — e.g. `"commit"`, `"commit the changes"`, `"make the commit"`.

**DO NOT** auto-commit just because Oracle gave recommendations. **DO NOT** invent rationale that is not supported by the actual diff or Oracle's response.

First inspect what actually changed:

```bash
git diff --staged
git diff
```

Use `git diff --staged` as the preferred commit boundary. Use `git diff` to detect unstaged Oracle-driven changes and leftover work.

**STOP** if both diffs are empty. Tell the user there is nothing to commit.

If nothing is staged but the working tree clearly contains the Oracle-driven implementation the user asked to commit, stage the relevant changes first. Use `git add -A` **only if all current changes belong in the commit**:

```bash
git add -A
git diff --staged
```

If staged and unstaged changes both belong to the same Oracle-driven implementation, stage the remaining relevant changes before committing. **Do NOT** sweep unrelated edits into the commit.

Cross-reference the final staged diff with `~/.oracle/sessions/{slug}/output.log` and build a commit message that explains both **WHAT** changed and **WHY** Oracle recommended it.

Commit message format:

```text
<imperative subject line, <=72 chars>

- <what changed> because Oracle recommended <fix/improvement>
- <what changed> to address Oracle's finding about <risk/problem>
- <what changed> as follow-up cleanup around Oracle's recommendation

Oracle-Session: {slug}
```

Rules:
- Subject line = concise summary of the actual code change
- Body bullets = map each concrete change back to the Oracle recommendation that motivated it
- Footer = always include the Oracle session slug for traceability
- If a change only partially implements Oracle's advice, say so plainly
- If part of the diff is unrelated, do **NOT** pretend Oracle requested it

Create the commit with a real multi-line message:

```bash
cat > /tmp/oracle-commit-msg.txt <<'EOF'
<subject line>

- <change 1> because Oracle recommended <fix/improvement>
- <change 2> to address Oracle's finding about <risk/problem>

Oracle-Session: {slug}
EOF

git commit -F /tmp/oracle-commit-msg.txt
rm -f /tmp/oracle-commit-msg.txt
```

After committing, report the subject line, short hash, and a brief note tying the commit back to Oracle's recommendations.

---

## `mcp__oracle__consult` Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | **Yes** | Your question — start with `[{slug}]` header |
| `files` | string[] | No | Bundle path + any screenshot paths |
| `engine` | string | **Yes** | **Always `"browser"`** |
| `model` | string | **Yes** | **Always `"gpt-5.4-pro"`** (NOT `"gpt-5.4"`) |
| `browserModelLabel` | string | **Yes** | **Always `"GPT-5.4 Pro"`** |
| `browserAttachments` | string | No | `"auto"` (default) / `"always"` (use with screenshots) / `"never"` |
| `browserThinkingTime` | string | No | `"standard"` or `"extended"` ONLY — do NOT use `"light"` or `"heavy"` |
| `slug` | string | **Yes** | Session name — needed to read the full response |

## Thinking Time

| Level | When to use |
|-------|------------|
| `"standard"` | Most code reviews, general analysis, simple questions (default) |
| `"extended"` | Architecture decisions, complex debugging, security audits |

## Prompt Writing

Oracle is one-shot with no memory. Every prompt must be self-contained:

1. **Slug header** — `[{slug}]` on the first line (always)
2. **Project briefing** — stack, framework, versions (2-3 sentences)
3. **What you want** — the specific question or task
4. **What you've tried** — prior attempts and why they failed
5. **Constraints** — no new deps, backwards compat, performance targets
6. **Deliverable** — what format you want the answer in

Aim for 6-30 sentences. Short prompts yield generic answers.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Empty bundle | Check `--preview`; ensure `-i` uses `**/` prefix; widen search |
| `-i "*.ts"` matches nothing | Use `-i "**/*.ts"` |
| `-i` + external path = 0 files | Wrap in `(cd TARGET && packx ...)` |
| Token budget exceeded | Progressive narrowing: `--strip-comments --minify` → narrow `-i` → add `-s` → use `-l N` |
| `mcp__oracle__consult` unavailable | Fall back to CLI: `oracle --engine browser -p "..." --file ~/.oracle/bundles/{slug}.txt --slug "{slug}"` |
| Truncated response | Read `~/.oracle/sessions/{slug}/output.log` for the full answer |
| Thinking time error | Only `"standard"` or `"extended"` work — not `"light"` or `"heavy"` |

## Completion Checklist (MANDATORY)

Before responding to the user, verify ALL of these:

- [ ] You ran `packx` and created `~/.oracle/bundles/{slug}.txt`
- [ ] The bundle is non-empty (Step 4 passed)
- [ ] You called `mcp__oracle__consult` — the actual MCP tool, not your own research
- [ ] You read `~/.oracle/sessions/{slug}/output.log` for the full response
- [ ] Your summary is based on GPT-5.4 Pro's response, not your own analysis
- [ ] If the user explicitly asked for a commit, you inspected `git diff --staged` and `git diff`
- [ ] If you created a commit, the message maps actual changes to Oracle recommendations and includes `Oracle-Session: {slug}`

**If ANY checkbox is unchecked, you have NOT completed this skill. Go back and execute the missing step.**

## References

- [Packx quick reference](references/packx-quick-reference.md) — flags, filters, workflows, size management
- [Packx deep technical reference](references/packx-deep-reference.md) — internals, caching, AST details
