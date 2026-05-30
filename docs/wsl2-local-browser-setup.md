# WSL2 Local Browser Setup

This guide sets up Oracle browser mode inside a WSL2 instance using Chrome installed in WSL.
Use the Windows bridge only if local WSL Chrome is unreliable or cannot stay signed in.

## Prerequisites

- WSL2 with a working Linux desktop display, usually WSLg.
- Node.js 22 or newer.
- Chrome installed inside WSL.
- The Oracle repo cloned locally.

Check the basics:

```bash
node --version
command -v google-chrome
echo "$DISPLAY"
```

If Chrome is installed somewhere other than `/usr/bin/google-chrome`, use that path in the commands below.

## Install Dependencies

From the repo root:

```bash
corepack enable
corepack prepare pnpm@10.23.0 --activate
pnpm install
pnpm build
```

Verify the built CLI:

```bash
node ./dist/bin/oracle-cli.js --help
```

## Shell Setup

Add this to `~/.zshrc`:

```zsh
export ORACLE_HOME_DIR="$HOME/.oracle-local"
export ORACLE_BROWSER_REMOTE_DEBUG_HOST="127.0.0.1"
export ORACLE_REPO_DIR="$HOME/dev/ai-ecosystem/oracle"

alias oracle='node "$ORACLE_REPO_DIR/dist/bin/oracle-cli.js"'
alias oracle-browser='oracle --engine browser --browser-chrome-path /usr/bin/google-chrome --browser-manual-login --browser-manual-login-profile-dir "$HOME/.oracle-local/browser-profile"'
```

Reload the shell config:

```bash
source ~/.zshrc
```

Why these settings matter:

- `ORACLE_HOME_DIR="$HOME/.oracle-local"` keeps WSL browser sessions separate from other Oracle sessions.
- `ORACLE_BROWSER_REMOTE_DEBUG_HOST="127.0.0.1"` forces Oracle to connect to Chrome inside WSL instead of the WSL host IP.
- `--browser-manual-login` uses a persistent automation profile so ChatGPT login survives across runs.
- `--browser-manual-login-profile-dir` pins that persistent profile path.

## First Login Run

Run:

```bash
oracle-browser --browser-keep-browser -p "hello"
```

Chrome should open from WSL. Sign into ChatGPT in that Oracle-controlled Chrome window.
Keep the window open until Oracle sends the prompt and captures the response.

## Normal Use

After the first login succeeds:

```bash
oracle-browser -p "hello"
```

Attach files when asking for code review or debugging:

```bash
oracle-browser \
  -p "Review this repo setup and identify risks" \
  --file "src/**/*.ts" \
  --file "README.md"
```

## Troubleshooting

If Oracle says no Chrome installation was found, pass the explicit Chrome path:

```bash
oracle-browser --browser-chrome-path /usr/bin/google-chrome -p "hello"
```

If Oracle tries to connect to `10.x.x.x:9222` and fails with `ECONNREFUSED`, make sure this is set:

```bash
export ORACLE_BROWSER_REMOTE_DEBUG_HOST="127.0.0.1"
```

If ChatGPT asks you to log in every run, make sure the command includes:

```bash
--browser-manual-login
--browser-manual-login-profile-dir "$HOME/.oracle-local/browser-profile"
```

If Oracle sends the prompt and ChatGPT answers, but Oracle does not print the response, check the log for:

```text
[browser] [poll] snapshot missing or empty
```

The local browser capture path should then try the assistant turn's copy button. If it still fails, rerun with `--browser-keep-browser` and inspect the live Chrome tab before it closes.

## Development Note

When working from a cloned repo, `pnpm exec oracle` does not expose the package's own `oracle` binary. Use the built file directly:

```bash
node ./dist/bin/oracle-cli.js --help
```

After changing TypeScript source, rebuild before using the alias:

```bash
pnpm build
```
