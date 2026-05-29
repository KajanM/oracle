# GUIDE — Running your own "Oracle" (a personal AI consultant on a Mac)

This guide documents how I run [Oracle](https://github.com/steipete/oracle) from my
own fork to turn a Mac (in my case a Mac mini that's always on) into a private
"oracle" — an on-demand way to spend a frontier model's intelligence on hard
planning, architecture, and code-review questions, driven straight from
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) via an MCP tool.

It's written so someone else can reproduce the setup from scratch. Everything
here uses **browser mode** (it automates a logged-in Chrome session against
ChatGPT / Gemini), so **no API keys are required**.

> **Security note up front.** Nothing secret is checked into this repo. Your
> ChatGPT/Gemini login lives only in your local Chrome profile and in
> `~/.oracle/` on your own machine. The remote `serve` token, Tailscale
> addresses, and `~/.oracle/sessions/` transcripts are **per-machine and
> private** — never commit them. See [Security checklist](#security-checklist).

---

## What "Oracle" is, in one paragraph

Oracle bundles a prompt + files and sends them to a strong model, then returns
the answer. Instead of paying for API tokens, browser mode reuses the cookies
from a Chrome profile that's already signed into ChatGPT (or Gemini), drives the
real web UI, selects the best available model ("Latest" / Pro with extended
thinking), submits the prompt + attachments, and streams the answer back. I wire
this into Claude Code as an MCP server so any agent session can call
`mcp__oracle__consult` and get a researched, high-leverage plan back.

---

## Two ways to run it (and how to tell which you're using)

There are two topologies. **They behave differently, and it's easy to think
you're using one when you're actually using the other** — so this section is the
single most important part of the guide.

### Mode A — Local (MCP stdio on the same machine)

Claude Code spawns the Oracle MCP server as a local subprocess. That process
drives **this machine's** Chrome with **this machine's** ChatGPT cookies. Nothing
goes over the network to another host.

This is what my MacBook is currently configured for. The MCP entry in
`~/.claude.json` looks like:

```jsonc
{
  "mcpServers": {
    "oracle": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/<you>/dev/oracle/dist/bin/oracle-mcp.js"],
      "env": {
        "ORACLE_ENGINE": "browser"
      }
    }
  }
}
```

Because there are **no remote env vars** (`ORACLE_REMOTE_HOST` /
`ORACLE_REMOTE_TOKEN`) and no `browser.remoteHost` in `~/.oracle/config.json`,
every consult runs **locally**. Parallel consults are supported via isolated
Chrome tabs.

### Mode B — Remote (a dedicated Mac running `oracle serve`)

A dedicated always-on Mac (e.g. a Mac mini) stays signed into ChatGPT and runs
`oracle serve`, exposing a browser bridge over [Tailscale](https://tailscale.com).
Other machines point at it and offload the browser work to the mini. This is what
my Mac mini is set up to do (see [Run it as a service](#optional-run-it-as-an-always-on-service-mac-mini)).

> **How to tell which mode is active:** look at the client's config. If
> `~/.oracle/config.json` has a `browser.remoteHost` (or `ORACLE_REMOTE_HOST` is
> set in the MCP `env`, or you pass `--remote-host`), consults route to the
> remote mini. **If none of those are set, consults run locally — even if a
> remote `serve` is running elsewhere.** A remote `serve` being up does *not*
> automatically capture local calls; the client has to opt in.
>
> Trade-off I hit in practice: the remote `serve` is **single-flight** (one
> session at a time; it returns `409 Conflict` when busy), whereas local mode
> runs **parallel** sessions in isolated tabs. I run locally for parallel agent
> work and use the mini when I want the work off my laptop.

---

## Prerequisites

- **macOS** (browser mode is most reliable here; Linux/Windows work with extra
  `--browser-chrome-path` / `--browser-cookie-path` flags).
- **Node 22+** (I run Node 25 on the mini). I manage versions with
  [`fnm`](https://github.com/Schniz/fnm).
- **pnpm** (the repo uses it; `corepack enable` or `npm i -g pnpm`).
- **Google Chrome**, signed into ChatGPT (and Gemini if you want Gemini mode).
- **Tailscale** on every machine — only needed for Mode B.
- A GitHub fork of Oracle if you want to track your own changes (mine is
  `johnlindquist/oracle`, forked from `steipete/oracle`).

---

## Step 1 — Clone the fork and build

```bash
git clone git@github.com:<you>/oracle.git ~/dev/oracle
cd ~/dev/oracle
pnpm install
pnpm run build          # tsc + vendor copy -> dist/bin/oracle-cli.js, dist/bin/oracle-mcp.js
```

The two binaries that matter:

- `dist/bin/oracle-cli.js` — the `oracle` CLI (and `oracle serve`).
- `dist/bin/oracle-mcp.js` — the MCP server Claude Code launches.

> Prefer not to maintain a fork? You can `npm install -g @steipete/oracle` or
> `brew install steipete/tap/oracle` and point the MCP config at the installed
> binary instead. I use a fork so I can carry local browser-automation fixes.

---

## Step 2 — Configure `~/.oracle/config.json`

This file holds **non-secret** runtime defaults. Mine (local mode) is:

```json
{
  "engine": "browser",
  "browser": {
    "autoReattachDelay": "30s",
    "autoReattachInterval": "2m",
    "autoReattachTimeout": "2m"
  },
  "notify": {
    "enabled": true,
    "sound": true
  },
  "maxFileSizeBytes": 10485760
}
```

Notes:

- `engine: "browser"` forces cookie-backed browser runs (never falls back to an
  API key).
- `autoReattach*` reconnects the automation when ChatGPT redirects mid-load
  (fixes the "Inspected target navigated or closed" error).
- `maxFileSizeBytes: 10485760` (10 MiB) lets large packx bundles upload instead
  of being truncated at the old 1 MB guard.
- To switch to **remote** (Mode B), add a `browser.remoteHost` and
  `browser.remoteToken` here (see that section). Those two values **are**
  sensitive — keep them out of git.

---

## Step 3 — Sign into ChatGPT and verify cookie sync

Browser mode reads cookies from your real Chrome profile and copies them into a
throwaway automation profile. First run opens ChatGPT so you can log in:

```bash
node dist/bin/oracle-cli.js --engine browser -p "HI"
```

Sign in once in the Chrome window that opens; subsequent runs reuse the session.

### The macOS Keychain gotcha (read this if cookie sync "fails")

The most confusing failure mode isn't "no cookies" — it's that **SSH / non-GUI
shells can't read the macOS Keychain** (`Chrome Safe Storage`), so cookie sync
returns zero cookies *even though* the same machine works fine from a GUI
Terminal. Symptom in logs:

```
Failed to read macOS Keychain (Chrome Safe Storage): exit 36
```

Prove the intended path from a **local GUI Terminal** (not SSH) without printing
any cookie values:

```bash
./scripts/gui-keychain-smoke.sh
```

The full decision tree — cookie sync vs. temp Chrome vs. remote routing, and how
to debug each — is in [`COOKIE_DEBUGGING.md`](./COOKIE_DEBUGGING.md).

---

## Step 4 — Wire Oracle into Claude Code (Mode A)

Register the MCP server at user scope so every project can use it:

```bash
claude mcp add oracle --scope user \
  -e ORACLE_ENGINE=browser \
  -- node /Users/<you>/dev/oracle/dist/bin/oracle-mcp.js
```

Or edit `~/.claude.json` directly to match the [Mode A snippet](#mode-a--local-mcp-stdio-on-the-same-machine) above.

Once registered, an agent can call:

- `mcp__oracle__consult` — run a prompt (+ files) and get the answer back.
- `mcp__oracle__sessions` — list/inspect past sessions.
- `mcp__oracle__imagine` — generate images via ChatGPT image mode.

> **Important for skill authors:** reference the tool by its **full** name,
> `mcp__oracle__consult`, not just "consult" — otherwise the agent won't connect
> the instruction to the actual tool.

### Where Oracle writes things locally

- `~/.oracle/bundles/{slug}.txt` — context bundles (use `.txt`, **not** `.md`;
  ChatGPT chokes on large `.md` uploads).
- `~/.oracle/sessions/{slug}/` — per-session output. In browser mode
  `output.log` holds automation metadata + a transcript; prefer
  `answer.raw.md` when present for the high-fidelity answer.
- The MCP result is **tail-truncated** (~4000 bytes), so the calling agent is
  responsible for persisting the full answer it receives.

---

## (Optional) Run it as an always-on service (Mac mini)

This is Mode B: a dedicated Mac mini, reachable over Tailscale, running
`oracle serve` under `launchd` so it survives reboots.

### 1. Generate a private token

```bash
openssl rand -hex 16          # use the output as your serve token; keep it secret
```

### 2. Create the LaunchAgent

`~/Library/LaunchAgents/dev.oracle.serve.plist` (replace the placeholders —
`<TAILSCALE_IP>` is the mini's Tailscale address, `<SERVE_TOKEN>` is the token
above, and the `PATH` should point at your Node install):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.oracle.serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd /Users/<you>/dev/oracle &amp;&amp; export PATH=/Users/<you>/.local/share/fnm/node-versions/v25.5.0/installation/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin &amp;&amp; export ORACLE_SERVE_LOG_RUNS=1 ORACLE_SERVE_VERBOSE=1 &amp;&amp; exec node dist/bin/oracle-cli.js serve --host <TAILSCALE_IP> --port 7333 --token <SERVE_TOKEN></string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>/Users/<you>/dev/oracle</string>
  <key>StandardOutPath</key>
  <string>/Users/<you>/.oracle/serve.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/<you>/.oracle/serve.err.log</string>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/dev.oracle.serve.plist
launchctl list | grep oracle           # should show dev.oracle.serve
```

The mini must stay signed into ChatGPT in its own Chrome profile (verify with
`./scripts/gui-keychain-smoke.sh` from a GUI Terminal on the mini, e.g. via
Screen Sharing — Keychain reads fail over SSH).

### 3. Point a client at the mini

On the client machine, add the remote bridge to `~/.oracle/config.json`:

```jsonc
{
  "engine": "browser",
  "browser": {
    "remoteHost": "<TAILSCALE_IP>:7333",
    "remoteToken": "<SERVE_TOKEN>"   // sensitive — never commit
  }
}
```

Resolution order is `--remote-host/--remote-token` flags → `browser.remoteHost` /
`browser.remoteToken` in config → `ORACLE_REMOTE_HOST` / `ORACLE_REMOTE_TOKEN`
env vars. Remember `serve` is single-flight (`409` when busy).

---

## The `oracle-packx` skill

[`packx`](https://www.npmjs.com/package/packx) bundles rich repo context into a
single file; the `oracle-packx` skill chains that bundle into
`mcp__oracle__consult`. A copy of the skill lives in this repo at
[`skills/oracle-packx/SKILL.md`](./skills/oracle-packx/SKILL.md); I install it
for Claude Code under `~/.agents/skills/oracle-packx/` (alongside its
`references/`).

The pipeline, in short:

1. **Pick a slug** — 3–5 hyphenated words (e.g. `review-auth-security-code`).
   Oracle rejects slugs outside that range. Bundles live at
   `~/.oracle/bundles/{slug}.txt`.
2. **Preview** — `packx --preview <filters>`; stop if 0 files match.
3. **Bundle** — `packx --limit 900k <filters> -f markdown --no-interactive --stdout > ~/.oracle/bundles/{slug}.txt`
   (add `--strip-comments --minify` for very large trees). Browser mode now
   handles bundles up to ~900k tokens / multi-MB on disk.
4. **Consult** — call `mcp__oracle__consult` with `engine: "browser"`,
   `browserModelLabel: "Latest"`, `browserThinkingTime: "extended"`, the bundle
   in `files`, and a prompt whose **first line is `[{slug}]`** followed by a
   blank line. Pass screenshots/PDFs in `files` with `browserAttachments: "always"`.
5. **Read the full answer** from `~/.oracle/sessions/{slug}/output.log` (or
   `answer.raw.md`) — the MCP return is truncated.
6. **Summarize / implement** — convert Oracle's answer into work; commit only
   when the user explicitly asks, tagging the commit with `Oracle-Session: {slug}`.

Hard rules the skill enforces: always browser engine (never API), self-contained
and progress-gated prompts, and a "Forward Progress Gate" that blocks repeat
consults on the same topic unless something was implemented, verified, blocked,
or narrowed since the last call. There's also a concurrency gate
(`ORACLE_MAX_CONCURRENT_SESSIONS`, default 10) that rejects calls past the limit
to prevent runaway Chrome spawns.

---

## Security checklist

Before sharing or committing anything, confirm none of these leak:

- [ ] **Serve token** — the `--token` value / `browser.remoteToken`. Never
      commit. Rotate with `openssl rand -hex 16` if exposed.
- [ ] **Cookies / session tokens** — `__Secure-next-auth.session-token`,
      `cf_clearance`, `_account`, `SAPISID`, etc. Debug scripts must print cookie
      **names only**, never values (see `cookie-probe` patterns).
- [ ] **`~/.oracle/` contents** — `serve-token`, `sessions/`, `browser-profile/`,
      and `*.log` are per-machine and private. None of them belong in git.
- [ ] **Tailscale addresses** — internal `100.x.y.z` IPs; fine to share within
      your tailnet, but I redact them in public docs.
- [ ] **No API keys needed** — browser mode uses cookies; if you ever see
      `Missing OPENAI_API_KEY`, the call wrongly used API mode — fix the call to
      `engine: "browser"`, don't add a key.

---

## Verify the whole thing works

```bash
# Local CLI smoke (opens/uses Chrome):
node dist/bin/oracle-cli.js --engine browser --wait --timeout 120 \
  -p "Return exactly one markdown bullet: - ok" --slug guide-smoke-test-run

# From Claude Code: ask an agent to call mcp__oracle__consult with a tiny prompt,
# then confirm a session appears via mcp__oracle__sessions.

# GUI Keychain / cookie smoke (run in a GUI Terminal, not SSH):
./scripts/gui-keychain-smoke.sh
```

If the smoke prompt comes back with `- ok`, your oracle is live.
