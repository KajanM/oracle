# Oracle-Packx Setup Guide (for Claude Code on a new machine)

You are Claude Code on a fresh machine. Your job: make the `oracle-packx` skill runnable here. Follow these steps in order. Do not skip verification.

Target end-state:
- `packx` CLI installed and on PATH
- `johnlindquist/oracle` cloned, dependencies installed, built
- `oracle-packx` skill available to Claude Code under `~/.claude/skills/oracle-packx/`
- `oracle` MCP server registered in Claude settings and pointing at the local build
- A smoke test that produces an Oracle response end-to-end

---

## 0. Prerequisites (verify, don't assume)

```bash
node --version          # expect >= 20
pnpm --version          # expect >= 10 (install if missing: npm i -g pnpm)
git --version
gh auth status          # must be logged in (private repo access required)
```

If `pnpm` is missing: `npm i -g pnpm`.
If `gh` is not authenticated: `gh auth login` — choose GitHub.com, SSH or HTTPS per preference.

Also required at runtime (not for setup): Google Chrome installed, and a ChatGPT Pro account you can log into manually when prompted.

---

## 1. Install `packx` (public npm package)

```bash
npm i -g packx
packx --version
```

`packx` is published publicly to npm from `github.com/johnlindquist/pack`. No cloning needed.

---

## 2. Clone and build the private `oracle` repo

The `oracle` MCP server binary lives in this repo. The public `@steipete/oracle` npm package does **not** include the browser-stability commits on this fork, so you must build from source.

```bash
mkdir -p ~/dev
cd ~/dev
gh repo clone kajanm/oracle
cd oracle
pnpm install
pnpm run build
```

Verify the MCP binary exists:

```bash
test -f ~/dev/oracle/dist/bin/oracle-mcp.js && echo OK || echo MISSING
```

If `MISSING`, the build failed — read the `pnpm run build` output and fix before continuing.

---

## 3. Install the `oracle-packx` skill

Copy the skill from the repo into Claude Code's user skills directory.

```bash
mkdir -p ~/.claude/skills
cp -R ~/dev/oracle/skills/oracle-packx ~/.claude/skills/oracle-packx
ls ~/.claude/skills/oracle-packx/SKILL.md   # must exist
```

Optional (recommended): also install the sibling `oracle` skill that this repo ships:

```bash
cp -R ~/dev/oracle/skills/oracle ~/.claude/skills/oracle
```

---

## 4. Register the `oracle` MCP server

The skill invokes the `mcp__oracle__consult` tool. That tool is provided by the `oracle` MCP server, which you just built. You need to tell Claude Code where it lives.

Resolve the absolute path (use it verbatim in the next step):

```bash
echo "$HOME/dev/oracle/dist/bin/oracle-mcp.js"
```

Register the server via the Claude Code CLI:

```bash
claude mcp add oracle --scope user -- node "$HOME/dev/oracle/dist/bin/oracle-mcp.js"
```

If the `claude mcp` command is unavailable in this install, edit `~/.claude.json` directly and add under the top-level `mcpServers` block:

```json
"oracle": {
  "type": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/home/dev/oracle/dist/bin/oracle-mcp.js"]
}
```

Replace `/absolute/path/to/home` with the real value from the `echo` above — do not use `~` or `$HOME` inside JSON.

---

## 5. Create runtime directories

```bash
mkdir -p ~/.oracle/bundles
mkdir -p ~/.oracle/sessions
```

These are used by the skill for bundle storage and session logs.

---

## 6. Restart Claude Code and verify the tool is live

Fully quit and relaunch Claude Code (the MCP server list is loaded at startup). Then, in a new Claude Code session in any directory, verify:

- The tool `mcp__oracle__consult` appears in the available tool list.
- The skill `oracle-packx` appears in the skills list.

If either is missing, re-check steps 3 and 4, then restart again.

---

## 7. Smoke test (end-to-end)

Run a tiny end-to-end pipeline to confirm everything works. From a small project directory:

```bash
cd ~/dev/oracle         # or any repo with <50 files
mkdir -p ~/.oracle/bundles
packx --limit 10k -i "README.md" -f markdown --no-interactive --stdout > ~/.oracle/bundles/smoke-setup-verify-test.txt
test -s ~/.oracle/bundles/smoke-setup-verify-test.txt && echo OK || echo EMPTY
```

Then, inside Claude Code, ask:

> Use the oracle-packx skill to summarize this README in one paragraph. Slug: `smoke-setup-verify-test`.

Expected behavior:
1. Claude invokes `mcp__oracle__consult` with the bundle.
2. Chrome launches (or attaches) and navigates to chatgpt.com.
3. If not logged in, you are prompted to log in manually — do so.
4. A session log appears at `~/.oracle/sessions/smoke-setup-verify-test/output.log`.
5. Claude reads the log and summarizes the response back.

If Chrome never opens: check that Chrome is installed at a standard path.
If the MCP tool errors with "busy" or concurrency issues: check `ORACLE_MAX_CONCURRENT_SESSIONS` — the default is 10.

---

## 8. Keeping the fork current

When you push new commits to `johnlindquist/oracle` from the other machine:

```bash
cd ~/dev/oracle
git pull
pnpm install        # only if lockfile changed
pnpm run build
```

No MCP re-registration is needed — the config points at the built file, which is overwritten in place.

---

## Troubleshooting checklist

| Symptom | Check |
|--------|-------|
| `mcp__oracle__consult` not in tool list | Restart Claude Code; verify `~/.claude.json` has the `oracle` entry and the path is absolute and exists |
| `oracle-packx` skill not listed | `ls ~/.claude/skills/oracle-packx/SKILL.md` must exist; restart Claude Code |
| Build fails with native module errors | Ensure Node >= 20 and that you ran `pnpm install` (not `npm install`) |
| `gh repo clone` 404 | You are not authenticated as `johnlindquist`, or you lack access to the private repo. Run `gh auth status` |
| packx bundle is empty | `-i` patterns need `**/` prefix for nested files; use `packx --preview` to debug filters |
| Oracle session hangs on login | Browser mode requires manual ChatGPT login on first run — complete it in the launched Chrome window |

---

## Inventory of things this setup relies on

- **packx** — public npm (`packx`), source `github.com/johnlindquist/pack`
- **oracle MCP server** — private repo `github.com/johnlindquist/oracle` (this repo), built locally
- **Chrome** — system install, used in browser automation mode
- **ChatGPT Pro account** — manual login required once per Chrome profile
- **Claude Code** — already installed (you are running inside it)
