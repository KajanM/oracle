#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${ORACLE_NODE_BIN:-$HOME/.local/share/fnm/node-versions/v22.22.2/installation/bin/node}"

if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node)"
fi

cd "$ROOT"

echo "[gui-keychain-smoke] Probing ChatGPT/OpenAI cookies via Chrome Safe Storage..."
"$NODE_BIN" --experimental-sqlite --input-type=module <<'NODE'
import { getCookies } from "@steipete/sweet-cookie";

const { cookies, warnings } = await getCookies({
  url: "https://chatgpt.com",
  origins: ["https://chatgpt.com/", "https://chat.openai.com/", "https://auth.openai.com/"],
  browsers: ["chrome"],
  mode: "merge",
  chromeProfile: "Default",
  timeoutMs: 5000,
});

console.log(`Got ${cookies.length} ChatGPT/OpenAI cookies. Warnings: ${warnings.length}`);
for (const warning of warnings) console.log("WARN:", warning);
for (const cookie of cookies) console.log(`${cookie.name}\t${cookie.domain}`);

if (warnings.length > 0 || cookies.length === 0) {
  process.exitCode = 1;
}
NODE

echo "[gui-keychain-smoke] Running minimal Oracle browser smoke..."
"$NODE_BIN" dist/bin/oracle-cli.js \
  --engine browser \
  --wait \
  --heartbeat 0 \
  --timeout 120 \
  --browser-input-timeout 30000 \
  --model "${ORACLE_BROWSER_SMOKE_MODEL:-gpt-5.2}" \
  --prompt "Return exactly one markdown bullet: - ok" \
  --slug gui-keychain-smoke \
  --force
