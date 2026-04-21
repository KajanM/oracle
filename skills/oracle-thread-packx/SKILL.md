---
name: oracle-thread-packx
description: >
  Use packx plus Oracle's MCP consult tool to run iterative GPT-5.4 Pro code reviews in the same ChatGPT browser conversation. Use when the user wants "ask oracle again", "iterate with oracle", "continue the oracle thread", or repeated packx-backed reviews that should preserve prior ChatGPT thread context.
---

# Oracle Thread Packx

You are a THREAD PIPELINE EXECUTOR.

Your job is:

1. Build a focused packx bundle.
2. Send it to Oracle through `mcp__oracle__consult`.
3. Preserve the returned ChatGPT conversation URL.
4. On later iterations, pass that URL back as `browserConversationUrl`.
5. Read the full Oracle session log.
6. Summarize Oracle's answer for the user.

Do **not** research the codebase yourself as a substitute for Oracle. Do **not** answer from your own code inspection unless you are only preparing the bundle or validating files. The point of this skill is to get GPT-5.4 Pro's review in a persistent ChatGPT thread.

---

## Core invariant

A thread is continued only when Oracle is given the exact prior ChatGPT conversation URL:

```json
{
  "browserConversationUrl": "https://chatgpt.com/c/<conversationId>"
}
```

If Oracle cannot land on that exact conversation, browser navigation should fail rather than silently post into a new thread. Do not remove `browserConversationUrl` to "make it work" unless the user explicitly asks to start a new thread.

## State layout

Skill-owned thread state lives outside Oracle sessions:

```
~/.oracle/threads/{threadSlug}/
  state.json
  iterations/
    001/
      prompt.md
      bundle.txt
      result-summary.md
    002/
      prompt.md
      bundle.txt
      result-summary.md
```

Oracle's own session history remains separate:

```
~/.oracle/sessions/{oracleSessionId}/output.log
```

Use `~/.oracle/threads/` for thread bookkeeping. Use `~/.oracle/sessions/` only to read Oracle run logs and metadata.

## Slugs

Use two slugs:

- `THREAD_SLUG`: stable thread name, preferably 3 hyphen-separated words.
- `SESSION_SLUG`: Oracle run slug for the current iteration, 3-5 hyphen-separated words.

Oracle rejects custom slugs outside 3-5 words, so count carefully.

Good:

- thread: `oracle-nav-thread`
- session: `oracle-nav-i001`
- session: `oracle-nav-i002`

Bad:

- thread: `nav`
- session: `oracle-navigation-thread-iteration-number-one`

If the user gives a long project/topic name, shorten it to a safe 3-5 word slug.

## First-run workflow

Use this when no thread state exists yet.

### Step 1: Create directories

```bash
THREAD_SLUG="oracle-nav-thread"
ITERATION="001"
THREAD_DIR="$HOME/.oracle/threads/$THREAD_SLUG"
ITER_DIR="$THREAD_DIR/iterations/$ITERATION"
mkdir -p "$ITER_DIR"
```

### Step 2: Preview with packx

Run a preview before building the bundle.

```bash
packx --preview [filters]
```

Stop if zero files match. Widen filters or fix glob syntax.

If the target repo is not the current directory, run packx from that repo:

```bash
(cd /path/to/project && packx --preview [filters])
```

### Step 3: Build the bundle

Target a useful bundle, not a tiny one. If the bundle is under roughly 40k and important context is missing, rebuild with broader filters.

```bash
packx --limit 49k [filters] -f markdown --no-interactive --stdout > "$ITER_DIR/bundle.txt"
```

Required flags:

- `--limit 49k`
- `-f markdown`
- `--no-interactive`
- `--stdout`

If preview shows a very large file set, add:

```bash
--strip-comments --minify
```

### Step 4: Validate the bundle

```bash
test -s "$ITER_DIR/bundle.txt" && echo "OK" || echo "EMPTY"
```

Stop if empty.

### Step 5: Write the prompt

Create a prompt that stands alone even though this is the first message in the thread.

```bash
cat > "$ITER_DIR/prompt.md" <<'EOF'
[oracle-nav-thread / iteration 001]

Project briefing:
- <stack, framework, runtime, relevant constraints>
- <where the important code lives>
- <test/build commands if known>

Task:
<ask the exact question>

What I want from you:
- Highest-risk findings first.
- Concrete fix plan.
- Tests or acceptance criteria.
- Call out uncertainty and assumptions.
EOF
```

Aim for 6-30 sentences. Short prompts usually produce generic answers.

### Step 6: Call Oracle MCP

For the first iteration, do not set `browserConversationUrl`; there is no prior thread yet.

```javascript
mcp__oracle__consult({
  prompt: "<contents of $ITER_DIR/prompt.md>",
  files: ["~/.oracle/threads/oracle-nav-thread/iterations/001/bundle.txt"],
  engine: "browser",
  model: "gpt-5.4-pro",
  browserAttachments: "auto",
  slug: "oracle-nav-i001"
})
```

For screenshots, PDFs, or other binary context, include them in `files` and force real browser uploads:

```javascript
mcp__oracle__consult({
  prompt: "<contents of $ITER_DIR/prompt.md>",
  files: [
    "~/.oracle/threads/oracle-nav-thread/iterations/001/bundle.txt",
    "/absolute/path/to/screenshot.png"
  ],
  engine: "browser",
  model: "gpt-5.4-pro",
  browserAttachments: "always",
  slug: "oracle-nav-i001"
})
```

### Step 7: Persist returned thread URL

After the MCP call completes, capture these structured fields from the tool response:

- `structuredContent.sessionId`
- `structuredContent.browserConversationUrl`
- `structuredContent.browserConversationId`

Write `state.json`:

```json
{
  "threadSlug": "oracle-nav-thread",
  "createdAt": "2026-04-20T00:00:00.000Z",
  "updatedAt": "2026-04-20T00:00:00.000Z",
  "browserConversationUrl": "https://chatgpt.com/c/<conversationId>",
  "browserConversationId": "<conversationId>",
  "iterations": [
    {
      "iteration": "001",
      "oracleSessionId": "{sessionId}",
      "sessionSlug": "oracle-nav-i001",
      "bundlePath": "~/.oracle/threads/oracle-nav-thread/iterations/001/bundle.txt",
      "promptPath": "~/.oracle/threads/oracle-nav-thread/iterations/001/prompt.md"
    }
  ]
}
```

If `browserConversationUrl` is missing, do not claim the thread is resumable. Tell the user Oracle completed but no browser conversation URL was captured.

### Step 8: Read the full Oracle answer

The MCP response may contain only a tail. Read the full log:

```bash
cat "$HOME/.oracle/sessions/{sessionId}/output.log"
```

If the file is missing, inspect via the sessions tool:

```javascript
mcp__oracle__sessions({
  id: "{sessionId}",
  detail: true
})
```

### Step 9: Summarize for the user

Report Oracle's findings, not your own independent review.

Use this structure:

```
Oracle thread: oracle-nav-thread
Oracle session: {sessionId}
ChatGPT thread: https://chatgpt.com/c/<conversationId>

Top findings:
1. ...
2. ...

Recommended next steps:
1. ...
2. ...

Tests / acceptance criteria:
- ...
```

Save a short summary:

```bash
cat > "$ITER_DIR/result-summary.md" <<'EOF'
<your user-facing summary>
EOF
```

## Follow-up iteration workflow

Use this when `~/.oracle/threads/{threadSlug}/state.json` already exists.

### Step 1: Load existing thread state

```bash
THREAD_SLUG="oracle-nav-thread"
THREAD_DIR="$HOME/.oracle/threads/$THREAD_SLUG"
STATE_FILE="$THREAD_DIR/state.json"
test -s "$STATE_FILE" || {
  echo "Missing thread state: $STATE_FILE"
  exit 1
}
```

Extract the browser URL:

```bash
BROWSER_CONVERSATION_URL="$(node -e 'const fs = require("fs");
const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (!state.browserConversationUrl) process.exit(2);
process.stdout.write(state.browserConversationUrl);' "$STATE_FILE")"
test -n "$BROWSER_CONVERSATION_URL" || {
  echo "Missing browserConversationUrl in $STATE_FILE"
  exit 1
}
```

Stop if this is empty.

### Step 2: Create next iteration directory

Use the next numeric iteration.

```bash
ITERATION="002"
ITER_DIR="$THREAD_DIR/iterations/$ITERATION"
mkdir -p "$ITER_DIR"
```

### Step 3: Build a fresh packx bundle

The new bundle should represent the current repo state. Previous attachments in ChatGPT may be stale.

```bash
packx --preview [filters]
packx --limit 49k [filters] -f markdown --no-interactive --stdout > "$ITER_DIR/bundle.txt"
test -s "$ITER_DIR/bundle.txt" && echo "OK" || echo "EMPTY"
```

Stop if empty.

### Step 4: Write a follow-up prompt

Make clear that this is a continuation and that the new bundle supersedes older code context.

```bash
cat > "$ITER_DIR/prompt.md" <<'EOF'
[oracle-nav-thread / iteration 002]

This is a follow-up in the same ChatGPT conversation. Use the prior discussion for continuity, but treat the newly attached packx bundle as the current source of truth.

What changed since the previous iteration:
- <short factual change list>
- <tests run, failures, or remaining uncertainty>

Current task:
<ask the next exact question>

What I want from you:
- Verify whether the latest changes address the prior findings.
- Identify regressions or missed edge cases.
- Give concrete next steps and tests.
EOF
```

### Step 5: Call Oracle MCP with browserConversationUrl

This is the critical difference from the first run.

```javascript
mcp__oracle__consult({
  prompt: "<contents of $ITER_DIR/prompt.md>",
  files: ["~/.oracle/threads/oracle-nav-thread/iterations/002/bundle.txt"],
  engine: "browser",
  model: "gpt-5.4-pro",
  browserConversationUrl: "https://chatgpt.com/c/<conversationId>",
  browserAttachments: "auto",
  slug: "oracle-nav-i002"
})
```

Do not substitute a base ChatGPT URL. Do not omit `browserConversationUrl` unless starting a new thread.

### Step 6: Update state

Append the new iteration and refresh the stored URL/id from the MCP structured response. If the response includes a new `browserConversationUrl`, store it. If it only includes the same URL, keep the existing one.

State shape remains:

```json
{
  "threadSlug": "oracle-nav-thread",
  "createdAt": "...",
  "updatedAt": "...",
  "browserConversationUrl": "https://chatgpt.com/c/<conversationId>",
  "browserConversationId": "<conversationId>",
  "iterations": [
    { "iteration": "001", "oracleSessionId": "..." },
    {
      "iteration": "002",
      "oracleSessionId": "...",
      "sessionSlug": "oracle-nav-i002",
      "bundlePath": "~/.oracle/threads/oracle-nav-thread/iterations/002/bundle.txt",
      "promptPath": "~/.oracle/threads/oracle-nav-thread/iterations/002/prompt.md"
    }
  ]
}
```

### Step 7: Read full log and summarize

Read:

```bash
cat "$HOME/.oracle/sessions/{sessionId}/output.log"
```

Then summarize Oracle's latest answer and explicitly note whether it confirms, revises, or contradicts previous advice.

## CLI fallback

Use the MCP tool first. If MCP is unavailable, use the Oracle CLI.

First iteration:

```bash
oracle --engine browser \
  --model gpt-5.4-pro \
  --file "$ITER_DIR/bundle.txt" \
  --slug "oracle-nav-i001" \
  -p "$(cat "$ITER_DIR/prompt.md")"
```

Follow-up iteration:

```bash
oracle --engine browser \
  --model gpt-5.4-pro \
  --chatgpt-url "$BROWSER_CONVERSATION_URL" \
  --file "$ITER_DIR/bundle.txt" \
  --slug "oracle-nav-i002" \
  -p "$(cat "$ITER_DIR/prompt.md")"
```

`--chatgpt-url` is the CLI equivalent of MCP `browserConversationUrl`.

After a CLI run, recover the actual Oracle session ID from command output or `oracle status`, then read:

```bash
cat "$HOME/.oracle/sessions/{sessionId}/output.log"
```

If a follow-up run with `--chatgpt-url` fails because the conversation is inaccessible, do not retry without `--chatgpt-url` unless the user wants a new thread.

## Model and browser settings

Default: `model: "gpt-5.4-pro"`, `engine: "browser"`, `browserAttachments: "auto"`.

- Use `browserAttachments: "always"` when attaching screenshots, PDFs, images, or when the user specifically wants ChatGPT file uploads.
- Use `browserThinkingTime: "extended"` only for complex architecture, security, or deep debugging reviews. Otherwise omit it.
- Do not rely on `browserModelLabel` for GPT models unless there is a specific reason. The `model: "gpt-5.4-pro"` setting is the source of truth.

## Prompt rules

Every prompt must include:

- Thread and iteration header.
- Brief project context.
- What changed since the previous iteration, if any.
- Current exact question.
- Constraints.
- Desired output format.

Good follow-up wording:

> This is iteration 003 in the same ChatGPT thread. The attached bundle reflects the current repo and supersedes earlier attached code. Please compare it against your prior recommendation about strict conversation-ID enforcement and tell me what remains unsafe.

Bad follow-up wording:

> Thoughts?

## File selection rules

Use enough context for Oracle to reason correctly. Under-bundling produces bad advice.

Good filters:

```bash
packx --preview -i "src/**/*.ts" -i "tests/**/*.ts" -i "skills/**/*.md"
```

If too large:

```bash
packx --preview -i "src/browser/**/*.ts" -i "src/mcp/**/*.ts" -i "tests/browser/**/*.ts"
```

If still too large:

```bash
packx --limit 49k -i "src/browser/**/*.ts" -i "src/mcp/**/*.ts" \
  --strip-comments --minify -f markdown --no-interactive --stdout > "$ITER_DIR/bundle.txt"
```

Avoid secrets:

- `.env*`
- `*.pem`
- `*.key`
- `secrets.*`
- `credentials.*`

## Troubleshooting

| Problem | What to do |
| --- | --- |
| packx preview returns 0 files | Fix globs. Prefer `**/*.ts` over `*.ts`. |
| Bundle is tiny | Add more relevant files before consulting Oracle. |
| MCP response is truncated | Read `~/.oracle/sessions/{sessionId}/output.log`. |
| No `browserConversationUrl` returned | Treat the thread as not resumable; tell the user. |
| Follow-up lands on wrong thread | Stop. The browser navigation guard should fail; do not continue from base ChatGPT. |
| Conversation URL inaccessible | Ask whether to start a new thread or fix login/account access. |
| Oracle slug rejected | Use 3-5 hyphen-separated words. |
| MCP unavailable | Use CLI fallback with `--chatgpt-url` for follow-ups. |

## Completion checklist

Before answering the user, verify:

- You created or loaded `~/.oracle/threads/{threadSlug}/state.json`.
- You ran `packx --preview`.
- You built a non-empty bundle under the current iteration directory.
- You called `mcp__oracle__consult`, or used the CLI fallback only if MCP was unavailable.
- For follow-ups, you passed `browserConversationUrl`.
- You captured `structuredContent.sessionId`.
- You captured and persisted `structuredContent.browserConversationUrl` when present.
- You read the full Oracle log from `~/.oracle/sessions/{sessionId}/output.log`.
- Your summary is based on Oracle's answer.
- You did not silently start a new ChatGPT thread when the user asked to continue an existing one.

If any box is unchecked, complete the missing step before responding.
