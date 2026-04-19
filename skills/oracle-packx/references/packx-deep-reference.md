# Packx Deep Reference

Complete technical reference for packx v4.x — the AI context bundler.

## File Discovery Pipeline

### Processing Order
1. **Candidate discovery** — by extension + glob patterns + git mode
2. **Ignore filtering** — `.gitignore` (traversed upward) + `.packignore` + default ignores
3. **Content filtering** — search strings (`-s`) and exclusion strings (`-S`)
4. **Size filtering** — skip files > 10MB silently
5. **Binary detection** — first 512 bytes checked for null bytes; >10% non-printable = binary → skip
6. **Pattern matching** — minimatch for `-i`/`-x` patterns
7. **Token counting** — js-tiktoken (GPT tokenizer), fallback: `text.length / 4`

### Auto-Excluded Directories & Files (DEFAULT_IGNORE_PATTERNS)
```
**/node_modules/**     **/.git/**          **/dist/**
**/build/**            **/.next/**         **/coverage/**
**/.cache/**           **/tmp/**           **/temp/**
**/*.log               **/.DS_Store        **/Thumbs.db
**/package-lock.json   **/yarn.lock        **/pnpm-lock.yaml
**/bun.lockb           **/bun.lock         **/Gemfile.lock
**/Cargo.lock          **/poetry.lock      **/Pipfile.lock
**/composer.lock
```

### Default Extensions (no `-i` flag)
**Languages:** js, jsx, ts, tsx, mjs, cjs, py, rb, go, java, cpp, c, h, rs, swift, kt, scala, php
**Web Frameworks:** vue, svelte, astro
**Styles:** css, scss, less
**Config:** json, yaml, yml, toml, xml
**Documentation:** md, mdx, txt
**Scripts:** sh, bash, zsh, fish
**Data:** sql, graphql, gql

## The `-i` Include Glob: Critical Behavior

**The `-i` flag requires `**/` prefix for extension matching:**

```bash
# CORRECT — always use **/ prefix for extensions
packx --limit 49k -i "**/*.ts" --preview
packx --limit 49k -i "src/**/*.tsx" --preview

# WRONG — bare *.ext does NOT match
packx --limit 49k -i "*.ts" --preview    # Matches nothing!
```

Directory-style includes (`-i "src/"`) work without `**/`.
The `-x` exclude flag is more lenient — `"*.test.*"` works for excludes.

## Token Budget (`--limit`)

### k vs K Notation
| Notation | Multiplier | Example | Exact Result |
|----------|-----------|---------|--------------|
| lowercase `k` | × 1,000 (SI) | `49k` | 49,000 tokens |
| UPPERCASE `K` | × 1,024 (binary) | `32K` | 32,768 tokens |
| No suffix | Raw number | `50000` | 50,000 tokens |
| Decimal | Works with both | `1.5k` | 1,500 tokens |

### Token Counting
- Uses `js-tiktoken` (OpenAI's tokenizer) for accurate GPT token counts
- Fallback: `Math.round(text.length / 4)` if tiktoken fails
- Counts are cached per-file in `.packx_cache/cache.json`

### Interactive Mode + Limit
When `--limit` is used with interactive mode (`-I`), a visual progress bar shows real-time token consumption as files are selected/deselected.

## Import Following (`--follow-imports`)

### Supported Import Styles
1. ES6: `import ... from "..."` and `export ... from "..."`
2. CommonJS: `require("...")`
3. Dynamic: `import("...")`

### Resolution
- **Only follows relative imports** (`./` or `../`), never `node_modules`
- Max depth: 10 levels
- Circular dependencies handled via visited-path Set

**Resolution extensions tried (in order):**
`""`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.mjs`, `.cts`, `.cjs`, `.json`

**Extension mappings:**
- `.js` → tries `.ts`, `.tsx`, `.js`, `.jsx`
- `.mjs` → tries `.mts`, `.mjs`
- `.cjs` → tries `.cts`, `.cjs`
- `.jsx` → tries `.tsx`, `.jsx`

**Index files for directory imports:**
`index.ts`, `index.tsx`, `index.js`, `index.jsx`, `index.mts`, `index.mjs`

### Parse Strategy
1. Tree-sitter AST parsing first (for .ts, .js, etc.)
2. Regex fallback if AST unavailable:
```
import\s+(?:[\w\s{},*]+\s+from\s+)?["']([^"']+)["']
export\s+(?:[\w\s{},*]+\s+from\s+)?["']([^"']+)["']
require\s*\(\s*["']([^"']+)["']\s*\)
import\s*\(\s*["']([^"']+)["']\s*\)
```

## Related Files (`-r` / `--related`)

Extracts base name (before first dot after name), then finds all files in the same directory with the same core name:
- `Button.tsx` → finds `Button.test.tsx`, `Button.stories.tsx`, `Button.module.css`, etc.
- Recursively expands matched files with their related files

## Comment Stripping (`--strip-comments`)

### AST-Based (primary — tree-sitter)
- Language-specific tree-sitter grammar
- Collects all comment nodes from AST
- Removes entire lines if only whitespace surrounds the comment
- Otherwise removes inline comments preserving code

### Regex Fallback (by language family)
| Language Family | Languages | Patterns |
|----------------|-----------|----------|
| C-style | js, jsx, ts, tsx, java, c, cpp, go, rust, swift, php, css, scss, less | `/* ... */` and `// ...` |
| Hash-style | py, rb, sh, bash, zsh, yaml, yml, toml | `# ...` |
| HTML-style | html, xml, md, mdx, vue, svelte, astro | `<!-- ... -->` |
| Lua-style | lua, sql | `-- ...` |

All regex fallbacks preserve quoted strings.

## Context Lines (`-l` / `--lines`)

### Smart Context Mode
1. Extracts N lines around each match
2. **Tries to expand to complete code blocks** using tree-sitter AST
3. Falls back to indent-based block detection
4. Max expansion: `contextLines × 2`

### Overlap Merging
Windows sorted by start line, then merged if `window.startLine <= current.endLine + 1`. Matches from overlapping regions are combined.

### Indent-Based Block Detection (fallback)
- Scans upward for lower indentation level (block openers: `{`, `:`, function/class/if keywords)
- Scans downward for closing braces or lower indentation

## Git Integration

### `--staged`
```
git diff --cached --name-only --diff-filter=ACMR
```
(Added, Copied, Modified, Renamed)

### `--dirty`
```
git diff --name-only --diff-filter=ACMR       # modified
git ls-files --others --exclude-standard       # untracked
```
Returns deduplicated union.

### `--diff`
```
git merge-base <branch> HEAD                    # find common ancestor
git diff --name-only --diff-filter=ACMR <base>  # diff from there
```
Falls back to branch name directly if merge-base fails.

**These three flags are mutually exclusive.**

## Output Formats

### XML (default)
```xml
<file_summary>
  <purpose>...</purpose>
</file_summary>
<directory_structure>file paths</directory_structure>
<files>
  <file path="src/auth.ts" matches="3" windows="2">
    ...content or context windows...
  </file>
</files>
```

### Markdown (`-f markdown`)
```markdown
# Packx Output
This file contains X filtered files...
## Files
### src/auth.ts (3 matches)
```ts
...content...
```​
```

### JSONL (`-f jsonl`)
One JSON object per line:
```json
{"path":"src/auth.ts","content":"...","tokens":150,"matches":[{"line":10,"column":5,"match":"..."}]}
```

### Plain (`-f plain`)
Like markdown but simpler header, no fenced blocks.

## Caching (`.packx_cache/`)

**Cache file:** `.packx_cache/cache.json` (version 2)

**Entry structure:**
```json
{
  "mtime": 1702000000000,
  "size": 4096,
  "contentHash": "sha256hex...",
  "isBinary": false,
  "tokens": 342
}
```

**Validation strategy:**
1. mtime AND size match → cache hit (fast path)
2. Size differs → cache miss
3. mtime differs but size same → compute SHA-256 → compare hash
4. Hash matches → update mtime, keep entry
5. Hash differs → cache miss, recompute

**Bypass:** `--no-cache`
**Prune:** Stale entries for deleted files cleaned on next run

## Bundles (`-b` / `--bundle`)

- Stored in `.pack/bundles/` directory
- Extensions: `.bundle`, `.pack`, `.txt`
- Format: gitignore-style patterns (one per line, `#` for comments)
- In interactive mode: loads bundles as pre-selected file sets
- With `-b name`: loads non-interactively and outputs directly

## Interactive Mode (`-I`)

**Default since v4.7.0** — running `packx` with no output flags enters interactive mode.

### Features
- Tree-based file browser with token counts
- Live preview pane with syntax highlighting
- Token budget progress bar (`--limit`)
- Git status decorators: `[M]` Modified, `[A]` Added, `[?]` Untracked
- `.packignore` files shown but start unselected
- Fuzzy search filtering
- Visual dependency graph

### Key Bindings
| Key | Action |
|-----|--------|
| `j/k` or ↑/↓ | Navigate |
| `Space` | Toggle selection |
| `Shift+Space` / `v` | Range selection (anchor) |
| `Tab` | Toggle preview focus |
| `PgUp/PgDn` | Scroll preview |
| `g/G` | Jump to top/bottom |
| `h/l` | Collapse/expand folder |
| `o` | Open in editor |
| `d` | Resolve dependencies |
| `c` | Toggle comment stripping |
| `+/-` | Adjust context lines |
| `x` | Banish to `.packignore` |
| `?` | Full-screen help overlay |
| `Enter` | Confirm selection |

### After Selection
- Option to save glob pattern to `.packignore`
- Option to save selection as named bundle
- Choose output: clipboard, file, stdout, or skip

## Watch Mode (`-w`)

- Uses `chokidar` with 150ms debounce
- File stabilization: 100ms threshold, 50ms poll interval
- Watches: `change`, `add`, `unlink` events
- **Requires** `--output` or `--copy`
- **Cannot combine with `-I`** (interactive)
- Ctrl+C for graceful shutdown

## `--instruction` and `--prompt`

| Flag | Position | Input |
|------|----------|-------|
| `--instruction <file>` | Prepends to TOP of output | File path |
| `--prompt <text>` / `-p` | Appends to END of output | Inline text |

## `--preview` Mode

- Dry run: shows matching files without packing content
- Displays up to 50 files (rest counted as "... and X more")
- Shows file count total
- Useful for testing filter combinations before committing

## `--explain` Mode

- Full dry run with detailed logging
- Shows: resolved config options, file discovery process, pattern matching, what would be included
- No output generated

## `--skeleton` Mode (v4.15.0+)

- AST-based: strips function bodies to `{ /* ... */ }`
- Keeps interfaces, type definitions, function signatures
- Great for architecture review at minimal token cost

## Secret Redaction (v4.15.0+)

Automatically detects and redacts 22 pattern types:
AWS keys, GitHub tokens, JWTs, database connection strings, API keys, private keys, etc.
Replaces matches with `<REDACTED:TYPE>`.

## `--minify` Behavior

```javascript
content.split('\n')
  .map(line => line.trim())
  .filter(line => line.length > 0)
  .join('\n')
```
Removes empty lines, trims whitespace per line.

## Token Splitting (`--max-tokens` / `-M`)

- Reserves ~50 tokens per chunk for headers/footers
- **Files are never split mid-file**
- A single file exceeding the budget is skipped entirely (marked "oversized")
- Creates: `output-1.xml`, `output-2.xml`, etc.
- Only chunk 1 copied to clipboard; rest go to files

## Concurrency

- Files analyzed in parallel using `p-limit`
- `CONCURRENCY_LIMIT = 50`
- Progress emitted every 50 files or 10% of total

## .packignore

- Gitignore syntax (processed by `ignore` npm library)
- Auto-loaded from project root
- `--no-packignore` to disable
- In interactive mode: matching files shown but unselected
- `x` hotkey in interactive mode banishes files to `.packignore`

## Positional Path Arguments

```bash
packx src/          # Directory → scan root
packx README.md     # File → explicit include
packx "**/*.test.ts" # Glob pattern → include pattern
```

**Classification:**
- Contains `*`, `?`, `[`, `]`, `{`, `}`, `!` → treated as glob pattern
- Exists as directory → treated as scan root
- Exists as file → treated as explicit file include

**Interaction with filters:**
- Explicit files + `-i` patterns: must match BOTH
- Positional roots: used as starting directories for scanning
- Positional globs: added to include patterns

## Gotchas & Edge Cases

| Issue | Detail |
|-------|--------|
| `-i "*.ts"` matches nothing | Must use `"**/*.ts"` with `**/` prefix for extensions |
| Interactive is default | Since v4.7.0, bare `packx` enters interactive mode. Use `--no-interactive` for scripting |
| `--stdout` disables interactive | Can't combine `--stdout` with `-I` |
| `--watch` + `-I` incompatible | Watch requires output target, can't be interactive |
| Files >10MB silently skipped | No warning — use `--explain` to debug missing files |
| Single file > `--max-tokens` | Entire file skipped, not split |
| Clipboard: only chunk 1 | When splitting, remaining chunks go to files |
| Binary files silently skipped | >10% non-printable chars in first 512 bytes |
