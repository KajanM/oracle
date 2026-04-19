# Packx Quick Reference

Packx (v4.x) is a native AI context bundler. It discovers files, filters by content/type/git-status, strips noise, counts tokens, and outputs in LLM-friendly formats. **Since v4.7.0, bare `packx` with no output flags enters interactive mode** — always use `--no-interactive` for scripting pipelines.

## How File Discovery Works

1. **Candidate discovery** — scans directories using glob patterns (ripgrep fast-path when available, Node.js glob fallback)
2. **Ignore filtering** — applies `.gitignore` (traversed upward from cwd) + `.packignore` + 22 built-in ignore patterns
3. **Include/exclude pattern matching** — `-i` and `-x` filters via minimatch
4. **Content filtering** — `-s` search strings and `-S` exclusion strings (up to 50 files in parallel)
5. **Size/binary filtering** — skips files >10MB silently; detects binary via first 512 bytes (>10% non-printable = binary)
6. **Token counting** — `js-tiktoken` (OpenAI tokenizer), fallback: `text.length / 4`

## Auto-Excluded (always skipped)
```
node_modules/  .git/  dist/  build/  .next/  coverage/  .cache/  tmp/  temp/
*.log  .DS_Store  Thumbs.db  package-lock.json  yarn.lock  pnpm-lock.yaml
bun.lockb  bun.lock  Gemfile.lock  Cargo.lock  poetry.lock  Pipfile.lock  composer.lock
```

## Default File Types (when no `-i` flag)
**Code:** js, jsx, ts, tsx, mjs, cjs, py, rb, go, java, cpp, c, h, rs, swift, kt, scala, php
**Web:** vue, svelte, astro, css, scss, less
**Config:** json, yaml, yml, toml, xml
**Docs:** md, mdx, txt
**Scripts:** sh, bash, zsh, fish
**Data:** sql, graphql, gql

## Critical: `-i` Glob Requires `**/` Prefix

```bash
# CORRECT — always use **/ prefix for extension globs
packx --limit 49k -i "**/*.ts" --preview
packx --limit 49k -i "src/**/*.tsx" --preview

# WRONG — bare *.ext matches NOTHING
packx --limit 49k -i "*.ts" --preview    # Empty result!
```

Directory-style includes (`-i "src/"`) work without `**/`. The `-x` exclude flag is more lenient — `"*.test.*"` works for excludes.

## Critical: `-i` Fails with External Directories

**The `-i` glob is matched against paths relative to cwd.** When you pass a positional path outside cwd (e.g., `~/dev/other-project`), relative paths start with `../` which `**` cannot traverse — **silently producing 0 results**.

```bash
# BROKEN — -i + external path = 0 files every time
packx --limit 49k -i "**/*.ts" --no-interactive --preview ~/dev/other-project

# FIX 1 (Best): cd into the target via subshell
(cd ~/dev/other-project && packx --limit 49k -i "**/*.ts" --no-interactive --preview)

# FIX 2: Positional path alone (all default file types), then exclude unwanted
packx --limit 49k -x "*.json" -x "*.md" -x "*.sh" --no-interactive --preview ~/dev/other-project

# FIX 3: Use -s (content search) — works fine with external paths
packx --limit 49k -s "import" --no-interactive --preview ~/dev/other-project
```

**Rule**: If the target directory ≠ cwd, wrap in `(cd TARGET && packx ...)`.

## Token Budget: k vs K

| Notation | Multiplier | Example | Result |
|----------|-----------|---------|--------|
| lowercase `k` | × 1,000 (SI) | `49k` | 49,000 tokens |
| UPPERCASE `K` | × 1,024 (binary) | `32K` | 32,768 tokens |
| No suffix | Raw number | `50000` | 50,000 tokens |

## Positional Arguments

```bash
packx src/                  # Directory → scan root
packx README.md src/auth.ts # Files → explicit includes
packx "**/*.test.ts"        # Glob → include pattern
```

Positional args are classified automatically: directories become scan roots, existing files are explicit includes, patterns with glob characters (`*`, `?`, `[]`, `{}`) become glob filters. When combined with `-i`, explicit files must match BOTH conditions.

## Complete Flag Reference

### Search & Filter
| Flag | Short | Purpose | Notes |
|------|-------|---------|-------|
| `--strings <text>` | `-s` | Include files containing text | Repeatable; case-insensitive by default |
| `--exclude-strings` | `-S` | Exclude files containing text | Opposite of -s |
| `--include <glob>` | `-i` | Include by glob | **Must use `**/` prefix for extensions** |
| `--exclude <glob>` | `-x` | Exclude by filename/glob | More lenient than -i |
| `--regex` | `-R` | Treat -s patterns as regex | Full regex syntax |
| `--case-sensitive` | `-C` | Case-sensitive search | Default is case-insensitive |
| `--staged` | | Git staged files only | `git diff --cached --name-only --diff-filter=ACMR` |
| `--diff` | | Files changed from main | Uses `git merge-base` to find divergence point |
| `--dirty` | | Modified + untracked files | Union of modified and `git ls-files --others` |
| `--no-packignore` | | Ignore .packignore file | |

`--staged`, `--diff`, and `--dirty` are **mutually exclusive**.

### Processing
| Flag | Short | Purpose | Notes |
|------|-------|---------|-------|
| `--strip-comments` | | Remove comments | AST-aware via tree-sitter; regex fallback by language family |
| `--no-comments` | | Alias for --strip-comments | |
| `--minify` | | Remove empty lines + trim whitespace | Stacks remaining lines together |
| `--lines <N>` | `-l` | Extract N context lines around matches | Smart expansion to complete code blocks; overlapping windows auto-merge |
| `--follow-imports` | | Include imported dependencies | ES6/CJS/dynamic; relative only; max depth 10; tries .ts/.tsx/.js/.jsx extensions |
| `--related` | `-r` | Include related files | Matches by core filename in same dir (tests, stories, styles) |
| `--skeleton` | | Interface-only extraction | AST-based: strips function bodies to `{ /* ... */ }` |
| `--instruction <file>` | | Prepend custom instructions from file | Inserted at top of bundle |
| `--prompt <text>` | `-p` | Append text to end of output | |

### Output
| Flag | Short | Purpose | Notes |
|------|-------|---------|-------|
| `--copy` | `-c` | Copy to clipboard | pbcopy/clip/xclip; only chunk 1 if splitting |
| `--stdout` | | Write to stdout | Summaries go to stderr; **disables interactive mode** |
| `--output <file>` | `-o` | Write to file | |
| `--format <fmt>` | `-f` | `xml` (default), `markdown`, `plain`, `jsonl` | Use `markdown` for Oracle/ChatGPT |
| `--preview` | | Show matching files (up to 50) without packing | Dry run for testing filters |
| `--max-tokens <N>` | `-M` | Split into chunks | Creates file-1.xml, file-2.xml; files never split mid-file |
| `--limit <size>` | | Token budget | `49k`=49,000; `32K`=32,768; visual progress in interactive mode |
| `--no-interactive` | | Disable interactive mode | **Required for scripting/piping** |

## Filter Decision Tree

```
Is the task about a specific feature/module?
├─ YES → Do you know the entrypoint file?
│        ├─ YES → --follow-imports <entrypoint>
│        └─ NO  → -s "keyword" -i "relevant/path/**/*.ts"
└─ NO  → Is it a code review / PR?
         ├─ YES → --diff (or --staged / --dirty)
         └─ NO  → Is it architecture/overview?
                  ├─ YES → --skeleton -i "src/**/*.ts"
                  └─ NO  → Is it debugging?
                           ├─ YES → -s "error message" -r -l 20
                           └─ NO  → -i "**/*.ts" (broad scan)

Always add: --limit 49k --preview (check first) → --no-interactive --stdout -f markdown
Token-tight? Add: --strip-comments --minify
Still too big? Add: -x "**/*.test.*" -x "**/stories/**" then -s "keyword" then -l N
```

## Bundle Size Management

- ALWAYS run `packx --preview [filters]` FIRST to estimate size
- If preview shows >49k: add `--strip-comments --minify`
- If still >49k: narrow `-i` patterns or add `-x` exclusions
- If still >49k: add `-s` keyword to filter to only relevant files
- If context around matches is sufficient: use `-l 20` instead of full files

Progression example:

```bash
# 1) Preview baseline
packx --preview -i "src/**/*.ts" -i "apps/web/**/*.tsx"

# 2) If too many files, strip/minify
packx --limit 49k -i "src/**/*.ts" --strip-comments --minify -f markdown --no-interactive --stdout > ~/.oracle/bundles/{slug}.txt

# 3) If still >49k, narrow includes/excludes
packx --limit 49k -i "src/auth/**/*.ts" -x "**/*.test.*" --strip-comments --minify -f markdown --no-interactive --stdout > ~/.oracle/bundles/{slug}.txt

# 4) If still >49k, add keyword focus
packx --limit 49k -i "src/auth/**/*.ts" -s "token session oauth" -x "**/*.test.*" --strip-comments --minify -f markdown --no-interactive --stdout > ~/.oracle/bundles/{slug}.txt

# 5) If still >49k, use context lines instead of full files
packx --limit 49k -s "token session oauth" -l 15 -x "**/*.test.*" --strip-comments -f markdown --no-interactive --stdout > ~/.oracle/bundles/{slug}.txt

# 6) For architecture overview, use skeleton mode
packx --limit 49k -i "src/**/*.ts" --skeleton -f markdown --no-interactive --stdout > ~/.oracle/bundles/{slug}.txt
```

## Common Workflows

### Review code by keyword
```bash
packx --limit 49k -s "auth" -i "**/*.ts" -x "*.test.*" -f markdown --no-interactive --stdout > ~/.oracle/bundles/{slug}.txt
```

### Analyze from entrypoint (best signal-to-noise)
```bash
packx --limit 49k --follow-imports src/server.ts -f markdown --no-interactive --stdout > ~/.oracle/bundles/{slug}.txt
```

### Debug from error
```bash
packx --limit 49k -s "TypeError: Cannot read properties" -r -f markdown --no-interactive --stdout > ~/.oracle/bundles/{slug}.txt
```

### Context-line focused review (token-efficient)
```bash
packx --limit 49k -s "catch" -s "throw" -l 15 --strip-comments -f markdown --no-interactive --stdout > ~/.oracle/bundles/{slug}.txt
```

### Architecture overview with skeleton mode
```bash
packx --limit 49k -i "src/**/*.ts" --skeleton -x "**/*.test.*" -f markdown --no-interactive --stdout > ~/.oracle/bundles/{slug}.txt
```

### PR/diff review
```bash
packx --limit 49k --diff -f markdown --no-interactive --stdout > ~/.oracle/bundles/{slug}.txt
```

### Large Monorepo
```bash
packx --limit 49k -i "apps/web/src/**/*.tsx" -i "apps/api/src/**/*.ts" -i "packages/auth/src/**/*.ts" -x "**/*.test.*" --strip-comments --minify -f markdown --no-interactive --stdout > ~/.oracle/bundles/{slug}.txt
```

## Fallback — Manual Bundle Augmentation

When `packx` cannot reach every needed file in one pass:

```bash
packx --limit 49k -i "src/**/*.ts" -f markdown --no-interactive --stdout > ~/.oracle/bundles/{slug}.txt
cat docs/auth-decision-record.md >> ~/.oracle/bundles/{slug}.txt
wc -c ~/.oracle/bundles/{slug}.txt
```

## References

- [Packx deep technical reference](packx-deep-reference.md) — full internals, caching, import resolution, AST details
