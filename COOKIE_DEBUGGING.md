# Oracle Browser Cookie, Session, and Remote Debugging Guide

This guide is based on Oracle session `browser-cookie-debug-guide-2` and the 2026-05-25 debugging receipts. It is for Oracle browser-mode failures around Chrome cookies, macOS Keychain, ChatGPT/Gemini login state, remote browser routing, MCP consult runs, and session logs.

The key lesson from the incident: the failure mode was not “Chrome has no cookies.” The same machine had valid ChatGPT cookies and browser mode worked from a GUI Terminal, but SSH/non-GUI shells could not read macOS Keychain (`Chrome Safe Storage`) and therefore `sweet-cookie` returned zero cookies.

## 1. Mental model and terminology

Keep these paths separate. Most debugging mistakes come from mixing them together.

### Cookie sync

Cookie sync means Oracle reads cookies from a real browser profile, converts them to Chrome DevTools Protocol `Network.setCookie` calls, and applies them to a fresh automation Chrome profile before navigating to ChatGPT.

Relevant code:

- `src/browser/cookies.ts#syncCookies`
- `src/browser/cookies.ts#readChromeCookiesWithWait`
- `src/browser/cookies.ts#readChromeCookies`
- `src/browser/index.ts#runBrowserMode`

Important behavior:

- Inline cookies win first because they avoid Keychain and profile ambiguity.
- Otherwise Oracle calls `@steipete/sweet-cookie` against the configured Chrome profile / cookie DB.
- Cookies are applied to the launched automation browser through CDP.
- If browser mode is not manual-login and no inline cookies are supplied, zero applied cookies should be treated as an auth blocker.

### Local temp Chrome

This is the default ChatGPT browser automation path.

Oracle:

1. launches a temporary Chrome profile,
2. copies cookies from the user’s real Chrome profile,
3. navigates to ChatGPT,
4. checks login,
5. selects the model,
6. sends the prompt/files,
7. waits for the answer,
8. captures markdown,
9. cleans up unless configured to keep the browser.

Relevant code:

- `src/browser/chromeLifecycle.ts#launchChrome`
- `src/browser/index.ts#runBrowserMode`
- `src/browser/actions/navigation.ts`
- `src/browser/actions/modelSelection.ts`
- `src/browser/actions/assistantResponse.ts`

### Manual login

Manual login means the user signs into an automation profile directly. It is useful when decrypting cookies is blocked, because it avoids copying cookies out of the real Chrome profile.

Check current repo behavior before relying on it: in this local bundle, several browser config paths force-disable manual-login fields for normal runs, so use docs/tests/current code as the authority.

### Remote Chrome

Remote Chrome means Oracle connects directly to an already-running Chrome/Edge instance over CDP, typically through `--remote-chrome host:port`.

Properties:

- Oracle does not launch the browser.
- Oracle does not own browser lifecycle.
- Cookie sync is skipped because the target browser should already be signed in.
- Local-only flags such as headless/hide/keep/chrome-path are ignored.
- This is still CDP automation, similar in detectability class to Puppeteer-style control. It is not stealth.

Relevant code:

- `src/browser/index.ts#runRemoteBrowserMode`
- `src/cli/browserConfig.ts#parseRemoteChromeTarget`

### Remote browser host / `oracle serve`

Remote browser host means a remote Oracle service performs the browser automation. The local client sends the prompt/files to the service.

Properties:

- Client uses `--remote-host` / `--remote-token` or `~/.oracle/config.json` remote settings.
- Cookies are not transferred from the client machine.
- The remote host must be able to read its own Chrome cookies or already have a valid browser session.
- Debugging must happen on the host that runs the browser automation.

Relevant code:

- `src/remote/server.ts`
- `src/remote/client.ts`
- `src/remote/remoteServiceConfig.ts`
- `src/cli/bridge/*`

### API engine

API engine is not browser mode. It uses provider APIs and keys, not ChatGPT browser cookies. If an MCP/Packx/Oracle browser consult reports `Missing OPENAI_API_KEY`, that is a routing/config error: retry with `engine: "browser"`; do not debug cookies as if API mode were browser mode.

## 2. Security and redaction policy

Never paste, commit, or share:

- Chrome Safe Storage secret printed by `security find-generic-password -w`.
- Raw cookie values.
- `__Secure-next-auth.session-token` values, including split `.0` / `.1` variants.
- Cloudflare cookie values such as `cf_clearance`, `__cf_bm`, `_cfuvid`, `__cflb`.
- `_account`, `_puid`, Google/Gemini cookies, or exported `CookieParam[]` payloads.
- `ORACLE_REMOTE_TOKEN`, `browser.remoteToken`, bridge/serve tokens, or session tokens.
- Full `~/.oracle/config.json` if it contains tokens, keys, private project URLs, or inline cookies.
- Full raw session logs when prompts, file paths, project URLs, or answers are private.

Usually safe to paste:

- Cookie counts.
- Cookie names and domains without values.
- Warning strings.
- Exit codes.
- Status lines such as `cookie-sync count=26`, `login check passed`, `Answer: ok`.
- Local paths to logs, as long as the log contents are not pasted.
- Redacted config shape: whether `engine`, `browser.remoteHost`, and `browser.remoteToken` are set.

Safe receipt format:

```text
Session: <slug>
Engine: browser
Cookie probe: Got <N> ChatGPT/OpenAI cookies. Warnings: 0
Oracle browser: cookie-sync count=<N>, login check passed
Answer receipt: "- ok"
Elapsed: <seconds>
Session log: ~/.oracle/sessions/<slug>/output.log
Raw secrets/cookies: not pasted
```

## 3. Golden success receipts

A healthy GUI macOS browser-cookie path should look like this:

```text
[gui-keychain-smoke] Probing ChatGPT/OpenAI cookies via Chrome Safe Storage...
Got 30 ChatGPT/OpenAI cookies. Warnings: 0
...
[gui-keychain-smoke] Running minimal Oracle browser smoke...
[browser] [phase] cookie-sync — ... count=26
[browser] [nav] login check passed ...
Answer:
ok
```

The committed helper `scripts/gui-keychain-smoke.sh` performs exactly this two-step validation:

1. safe `@steipete/sweet-cookie` cookie probe that prints counts, warnings, cookie names, and domains only;
2. minimal browser run asking for one markdown bullet.

Incident receipts:

- GUI Terminal: `Got 30 ChatGPT/OpenAI cookies. Warnings: 0`; browser `cookie-sync count=26`; login passed; answer `ok`; total `34.6s`.
- Local agent session: `Got 50 ChatGPT/OpenAI cookies. Warnings: 0`; browser `cookie-sync count=26`; login passed; answer `ok`; total `52.0s`.
- SSH/non-GUI: `Got 0 cookies. Warnings: 1`; `Failed to read macOS Keychain (Chrome Safe Storage): exit 36`.

## 4. Safe probe commands

Run from repo root unless noted.

### 4.1 Prove whether this shell can read Chrome Safe Storage without printing the secret

```bash
set +e
security find-generic-password -w -a Chrome -s "Chrome Safe Storage" >/dev/null
status=$?
set -e
echo "Chrome Safe Storage status=$status"
```

Expected success:

```text
Chrome Safe Storage status=0
```

Known SSH/non-GUI failure:

```text
Chrome Safe Storage status=36
```

To check Keychain state without printing secrets:

```bash
security show-keychain-info "$HOME/Library/Keychains/login.keychain-db"
```

Known bad output:

```text
User interaction is not allowed.
```

Interpretation: this shell is not in a GUI security context that can satisfy Keychain access. Do not keep retrying cookie sync from that same SSH context unless you switch to inline cookies, remote service, remote Chrome, manual-login, or a GUI/LaunchAgent path.

### 4.2 Run the committed GUI Keychain smoke

```bash
./scripts/gui-keychain-smoke.sh
```

Expected success:

```text
[gui-keychain-smoke] Probing ChatGPT/OpenAI cookies via Chrome Safe Storage...
Got <N> ChatGPT/OpenAI cookies. Warnings: 0
...
[gui-keychain-smoke] Running minimal Oracle browser smoke...
...
Answer:
ok
```

Expected SSH/non-GUI failure:

```text
Got 0 ChatGPT/OpenAI cookies. Warnings: 1
WARN: Failed to read macOS Keychain (Chrome Safe Storage): exit 36
```

The helper exits nonzero if warnings are present or cookie count is zero, which makes it suitable for verification receipts.

Optional overrides:

```bash
ORACLE_NODE_BIN=/path/to/node ./scripts/gui-keychain-smoke.sh
ORACLE_BROWSER_SMOKE_MODEL=gpt-5.2 ./scripts/gui-keychain-smoke.sh
ORACLE_BROWSER_SMOKE_SLUG=my-cookie-smoke ./scripts/gui-keychain-smoke.sh
```

### 4.3 Safe ChatGPT/OpenAI cookie probe only

```bash
node --experimental-sqlite --input-type=module <<'NODE'
import { getCookies } from "@steipete/sweet-cookie";

const { cookies, warnings } = await getCookies({
  url: "https://chatgpt.com",
  origins: [
    "https://chatgpt.com/",
    "https://chat.openai.com/",
    "https://auth.openai.com/",
  ],
  browsers: ["chrome"],
  mode: "merge",
  chromeProfile: "Default",
  timeoutMs: 5000,
});

console.log(`Got ${cookies.length} ChatGPT/OpenAI cookies. Warnings: ${warnings.length}`);
for (const warning of warnings) console.log("WARN:", warning);
for (const cookie of cookies) console.log(`${cookie.name}\t${cookie.domain}`);
if (warnings.length > 0 || cookies.length === 0) process.exitCode = 1;
NODE
```

Do not add `cookie.value` to this script. Names/domains are enough.

### 4.4 Safe Gemini/Google cookie probe only

Use this when Gemini works but ChatGPT fails, or ChatGPT works but Gemini fails.

```bash
node --experimental-sqlite --input-type=module <<'NODE'
import { getCookies } from "@steipete/sweet-cookie";

const { cookies, warnings } = await getCookies({
  url: "https://gemini.google.com",
  origins: [
    "https://gemini.google.com/",
    "https://accounts.google.com/",
    "https://google.com/",
  ],
  browsers: ["chrome"],
  mode: "merge",
  chromeProfile: "Default",
  timeoutMs: 5000,
});

console.log(`Got ${cookies.length} Gemini/Google cookies. Warnings: ${warnings.length}`);
for (const warning of warnings) console.log("WARN:", warning);
for (const cookie of cookies) console.log(`${cookie.name}\t${cookie.domain}`);
if (warnings.length > 0 || cookies.length === 0) process.exitCode = 1;
NODE
```

ChatGPT and Gemini use different domains and login systems. It is normal for ChatGPT cookies to be missing while Google cookies exist, or the reverse. Debug against the provider you are actually running.

### 4.5 Minimal local Oracle browser smoke

```bash
node dist/bin/oracle-cli.js \
  --engine browser \
  --wait \
  --heartbeat 0 \
  --timeout 120 \
  --browser-input-timeout 30000 \
  --model gpt-5.2 \
  --prompt "Return exactly one markdown bullet: - ok" \
  --slug local-agent-keychain-smoke \
  --force
```

Expected success indicators:

```text
[browser] [phase] cookie-sync — ... count=<N greater than 0>
[browser] [nav] login check passed ...
Answer:
ok
```

Expected cookie failure:

```text
No ChatGPT cookies were applied from your Chrome profile; cannot proceed in browser mode.
```

`src/browser/index.ts` fails early when cookie sync is enabled, the run is not manual-login, no inline cookies are present, and zero cookies were applied.

### 4.6 Browser smoke suite

```bash
./scripts/browser-smoke.sh
```

Key receipts to keep:

```text
[browser-smoke] fast simple
[browser-smoke] fast with attachment preview (inline)
[browser-smoke] pro standard markdown check
[browser-smoke] reattach flow after controller loss
```

Use this after browser/session/capture changes, not for every Keychain diagnosis.

## 5. Decision tree

### A. Cookie count is zero

1. Confirm which shell is running the command.
   - GUI Terminal and agent shell may differ from SSH/tmux/LaunchAgent.
2. Run the safe Keychain status probe.
3. Run the provider-specific safe cookie probe.
4. If ChatGPT probe is zero but Google/Gemini probe is nonzero, do not conclude Keychain is broken; ChatGPT may be logged out or using a different Chrome profile.
5. Check `chromeProfile` and `chromeCookiePath` config.
6. If Keychain works but cookies are still zero, verify Chrome profile and domains.

### B. Keychain returns `exit 36` or `User interaction is not allowed`

Likely cause: non-GUI security context.

Do:

- Re-run from a local GUI Terminal.
- Use `./scripts/gui-keychain-smoke.sh` as the proof.
- If automation must be headless/remote, run Oracle service from a GUI-capable host/session, use inline cookies, or use a signed-in remote Chrome/manual-login profile where appropriate.

Do not:

- Print the Chrome Safe Storage secret into shared logs.
- Assume the repo or `sweet-cookie` version regressed without a direct safe probe.
- Keep retrying from the same SSH shell expecting Keychain access to change.

### C. Google/Gemini cookies exist but ChatGPT cookies are missing

This means Chrome Safe Storage can be read, but the target provider is not authenticated in the selected Chrome profile.

Do:

- Open ChatGPT in that Chrome profile and sign in.
- Re-run the ChatGPT/OpenAI probe.
- Confirm `chromeProfile` is the intended profile, usually `Default` unless configured.

### D. Cookie sync succeeds but login check fails

Look for:

- Cloudflare interstitial.
- ChatGPT login CTA.
- Workspace/account picker.
- Expired ChatGPT session cookies.
- Wrong profile or stale `_account`/session token pair.

Useful actions:

```bash
node dist/bin/oracle-cli.js --engine browser --browser-keep-browser --verbose \
  --prompt "Return exactly one markdown bullet: - ok" \
  --slug login-debug --force
```

Then inspect the kept browser or use browser tools against the session’s active Chrome port.

### E. Cloudflare blocks automation

Cloudflare can block the launched automation profile even after cookies are copied.

Do:

- Use `--browser-keep-browser`.
- Solve the interstitial manually if visible.
- Re-run.
- Consider inline cookies only if you can handle them safely.

Do not assume remote Chrome is invisible automation. CDP-controlled browsers can still be detected.

### F. Model picker changes or selectors fail

Expected logs may include:

```text
[dom] model bootstrap failed, falling back to inline selectors
[model] selected: Use latest model
```

Fallback selectors can still work. Only treat this as failure if model selection, submit, or response capture fails.

Debug with:

```bash
ORACLE_BROWSER_MODEL_DEBUG=1 node dist/bin/oracle-cli.js \
  --engine browser --browser-keep-browser --verbose \
  --prompt "Return exactly one markdown bullet: - ok" \
  --slug model-picker-debug --force
```

Relevant files:

- `src/browser/actions/modelSelection.ts`
- `src/browser/modelPickerProbe.ts`
- `tests/browser/modelSelection.test.ts`

### G. Response capture stalls

Do not fail immediately. Browser runs can take a long time, especially Latest/Pro/Extended.

Inspect session logs:

```bash
tail -200 "$HOME/.oracle/sessions/<slug>/output.log"
cat "$HOME/.oracle/sessions/<slug>/meta.json"
tail -200 "$HOME/.oracle/sessions/<slug>/models/<model>.log"
```

Healthy signs:

- `status` still running.
- `output.log` is updating.
- Poll heartbeats continue.
- Partial capture lines appear.
- Browser runtime metadata exists.

Failure signs:

- Terminal error in log.
- Browser process exited unexpectedly.
- Session status is failed.
- Repeated login/auth errors.

### H. Output is truncated

MCP/tool output can truncate even when the Oracle session succeeded.

Read the authoritative file:

```bash
wc -c "$HOME/.oracle/sessions/<slug>/output.log"
tail -200 "$HOME/.oracle/sessions/<slug>/output.log"
oracle session <slug> --render-plain > /tmp/oracle-answer.md
```

## 6. Session debugging

Oracle stores session data under:

```text
~/.oracle/sessions/<slug>/
```

Common files:

```text
meta.json                  # status, model, cwd, browser config, runtime hints
output.log                 # authoritative combined CLI/session output
models/<model>.log         # model-specific answer/log
request.json               # request shape when available
```

Useful commands:

```bash
oracle status --hours 24
oracle status --all
oracle session <slug> --render
oracle session <slug> --render-plain
cat "$HOME/.oracle/sessions/<slug>/meta.json"
tail -200 "$HOME/.oracle/sessions/<slug>/output.log"
```

Browser runtime hints may include:

- Chrome port.
- Chrome pid.
- Target id.
- Conversation URL.
- Controller pid.

Use these to inspect a kept browser:

```bash
node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(j.browser?.runtime)' \
  "$HOME/.oracle/sessions/<slug>/meta.json"
```

For DOM inspection, use the repo’s browser tooling against the port from `meta.json`.

## 7. MCP / Packx / Oracle browser-engine rules

For Oracle consults that need ChatGPT browser mode, always set browser mode explicitly:

```json
{
  "engine": "browser",
  "browserModelLabel": "Latest",
  "browserThinkingTime": "extended"
}
```

Do not omit `engine`. Do not fall back to API mode when the browser run is slow or when a prompt is small.

If you see:

```text
Missing OPENAI_API_KEY
```

Interpretation: the call accidentally used API mode or defaulted incorrectly. Retry with `engine: "browser"` and let `~/.oracle/config.json` own browser/remote routing.

For Packx bundles:

- Build rich context, but respect the current MCP file guard.
- If a bundle exceeds the guard, narrow or minify it and include omitted facts in a compact evidence supplement.
- Always read `~/.oracle/sessions/<slug>/output.log` after the run; MCP responses can truncate.

Known receipt from this guide run:

```text
First bundle: 1.2 MB, rejected by MCP file guard.
Second bundle: 975482 bytes, accepted.
Oracle session: browser-cookie-debug-guide-2
```

## 8. Remote browser host vs remote Chrome

### Remote browser host (`oracle serve`)

Use when the browser automation should run on another machine/service.

Pros:

- Good for dedicated hosts.
- Can centralize long browser runs.
- Uses the host’s Chrome/Keychain/session, not the client’s.

Cons:

- Host must be configured and authenticated.
- Token handling matters.
- Debugging must happen on the host.

Check health without printing tokens:

```bash
oracle bridge status
oracle bridge doctor
```

If inspecting config, redact tokens:

```bash
node -e 'const fs=require("fs"); const p=process.env.HOME+"/.oracle/config.json"; const j=JSON.parse(fs.readFileSync(p,"utf8")); if (j.browser?.remoteToken) j.browser.remoteToken="<redacted>"; console.log(JSON.stringify(j,null,2));'
```

### Remote Chrome (`--remote-chrome host:port`)

Use when Oracle should attach to an already-running browser with an existing login session.

Pros:

- Skips cookie sync.
- Avoids Keychain extraction.
- Good for a dedicated signed-in automation profile.

Cons:

- It is still CDP automation and may be detected.
- Oracle does not own lifecycle.
- Local flags are ignored.
- Can interfere with the user’s active browser if pointed at a real daily-driver Chrome.

Do not describe remote Chrome as “stealth.” It is a reliability workaround, not an anti-detection guarantee.

## 9. Maintainer / agent checklist

Before editing browser/cookie/remote/session code:

```bash
pnpm install
pnpm run build
bash -n scripts/gui-keychain-smoke.sh
```

When touching cookie sync or macOS behavior:

```bash
./scripts/gui-keychain-smoke.sh
```

When touching browser automation:

```bash
./scripts/browser-smoke.sh
```

When touching remote service/client:

```bash
pnpm vitest run tests/remote/server.test.ts tests/remote/client.test.ts tests/remote/remoteServiceConfig.test.ts
oracle bridge doctor
```

When touching MCP consult:

```bash
pnpm run build
pnpm run test:mcp:unit
```

When debugging ChatGPT DOM/model picker:

```bash
ORACLE_BROWSER_MODEL_DEBUG=1 oracle --engine browser --browser-keep-browser --verbose \
  -p "Return exactly one markdown bullet: - ok"
```

Durable files to keep current:

- `scripts/gui-keychain-smoke.sh`: safe Keychain/cookie/browser proof.
- `scripts/browser-smoke.sh`: browser, markdown, attachment, reattach coverage.
- `docs/browser-mode.md`: execution paths, cookie controls, remote Chrome, remote service.
- `docs/configuration.md`: `~/.oracle/config.json`, remote host/token precedence, engine selection.
- `docs/manual-tests.md`: browser and remote Chrome manual receipts.
- `AGENTS.md`: high-signal agent warnings, especially GUI-vs-SSH Keychain and never-click-Answer-now.
- `tests/browser/cookies.test.ts`: cookie replay, allow-errors, wait/retry behavior.
- `tests/remote/*`: service/client config and remote reliability.
- `tests/cli/browserConfig.test.ts`: model mapping, URL normalization, remote Chrome parsing.

## 10. Highest-leverage next local slice

Oracle recommended one next local slice:

> Write one repo doc, for example `docs/browser-cookie-debugging.md`, and wire it from `docs/browser-mode.md`, `docs/manual-tests.md`, and `AGENTS.md`. Keep it focused on diagnosis and receipts, not implementation changes.

Suggested acceptance checks:

```bash
pnpm run build
bash -n scripts/gui-keychain-smoke.sh
./scripts/gui-keychain-smoke.sh
grep -nE 'cookie-sync|login check|Answer:' "$HOME/.oracle/sessions/gui-keychain-smoke/output.log" | tail -20
```

Expected receipt:

```text
Got <N> ChatGPT/OpenAI cookies. Warnings: 0
[browser] [phase] cookie-sync — ... count=<N greater than 0>
[browser] [nav] login check passed ...
Answer:
ok
```

Later polish, as separate work:

- Add `oracle doctor browser-cookies` that wraps safe probes without printing secrets.
- Add `oracle doctor session <slug>` that summarizes `meta.json`, runtime, cookie-sync/login/model/capture lines, and redacts config.
- Document LaunchAgent-hosted `oracle serve` for macOS GUI sessions.
- Add a remote service receipt command that checks health and token presence without printing tokens.
- Add a small model-picker self-check command if ChatGPT DOM drift remains frequent.
