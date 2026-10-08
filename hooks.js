// Installs project-level client hooks that tell an agent session when Mycelium messages are waiting. The
// server writes a one-line note to <home>/sessions/<client-pid>.unread while messages are unread; the hook
// finds its own session's note, shows it once, and deletes it, so the agent is reminded once per batch and
// decides itself whether to call read_messages. Never touches global (user-level) client config.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

// The agent client that started this process: the nearest ancestor that is not node/npm/npx or a shell.
// The MCP server and notify.sh (below) both walk up this way, so they land on the same session pid.
export function clientPid() {
  let pid = process.ppid;
  try {
    for (let i = 0; i < 8; i++) {
      const m = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)]).toString().trim().match(/^(\d+)\s+(.+)$/);
      if (!m || !/^(node|npm|npx|-?sh|-?bash|-?zsh|-?dash|env)\b/.test(basename(m[2]))) return pid;
      pid = Number(m[1]);
    }
  } catch {
    // no ps (or the process exited): fall back to the last pid reached
  }
  return pid;
}

// Walks up from the hook to the agent client process, skipping node/npm/npx and shells exactly like
// clientPid() in server.js. "text" prints the note as plain stdout (prompt hooks); "json" wraps it as
// additionalContext. The note holds only counts and the agent name, never message content, so it needs
// no JSON escaping.
const NOTIFY_SH = `#!/bin/sh
# Mycelium unread-message reminder for agent hooks. Usage: notify.sh <format> [HookEventName]
#   text    plain stdout (Claude Code, Kiro and Factory Droid prompt hooks)
#   json    {"hookSpecificOutput":{"hookEventName":..,"additionalContext":..}} (Claude Code, Codex, Gemini CLI,
#           Factory Droid PostToolUse, VS Code Copilot PostToolUse)
#   flat    {"additionalContext":..} (Copilot CLI postToolUse)
#   cursor  {"additional_context":..} (Cursor postToolUse)
#   cline   {"cancel":false,"contextModification":..,"errorMessage":""} (Cline)
pid=$PPID
i=0
while [ "$i" -lt 8 ]; do
  line=$(ps -o ppid=,comm= -p "$pid" 2>/dev/null) || exit 0
  parent=$(echo "$line" | awk '{print $1}')
  comm=$(basename "$(echo "$line" | sed 's/^ *[0-9]* *//')")
  case "$comm" in
    node*|npm*|npx*|sh|-sh|bash|-bash|zsh|-zsh|dash|-dash|env) pid=$parent; i=$((i + 1)) ;;
    *) break ;;
  esac
done
f="$(dirname "$0")/../sessions/$pid.unread"
[ -f "$f" ] || exit 0
note=$(cat "$f")
rm -f "$f"
case "$1" in
  json) printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\\n' "$2" "$note" ;;
  flat) printf '{"additionalContext":"%s"}\\n' "$note" ;;
  cursor) printf '{"additional_context":"%s"}\\n' "$note" ;;
  cline) printf '{"cancel":false,"contextModification":"%s","errorMessage":""}\\n' "$note" ;;
  *) printf '%s\\n' "$note" ;;
esac
`;

function readJson(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

function writeFile(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

// Adds a command hook to a { hooks: { Event: [ { matcher?, hooks: [...] } ] } } object (Claude Code, Codex).
function addJsonHook(config, event, command, matcher, mark) {
  config.hooks ??= {};
  config.hooks[event] ??= [];
  if (JSON.stringify(config.hooks[event]).includes(mark)) return false;
  config.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, timeout: 5 }] });
  return true;
}

// Project-level hook files, relative to the project directory (the current directory by default).
const PROJECT_FILES = { claude: ".claude/settings.local.json", codex: ".codex/hooks.json" };

// Writes the reminder script and returns its path, for agents that add their own hooks (see the skill).
export function writeHookScript(home) {
  const script = join(home, "hooks", "notify.sh");
  writeFile(script, NOTIFY_SH);
  return script;
}

export function installHooks(client, home, configFile) {
  if (!PROJECT_FILES[client]) {
    throw new Error(
      client === "kimi"
        ? "Kimi Code reads hooks only from its global ~/.kimi-code/config.toml, and Mycelium does not install global hooks. See the skill for other ways to stay reminded."
        : `install-hooks supports claude and codex. For "${client}", run "mycelium hook-script" and add a project-level hook yourself (see the skill).`,
    );
  }
  const script = writeHookScript(home);
  const cmd = (format, event) => `sh "${script}" ${format}${event ? ` ${event}` : ""}`;
  const file = resolve(configFile ?? PROJECT_FILES[client]);
  const config = readJson(file);
  const prompt = client === "claude" ? cmd("text") : cmd("json", "UserPromptSubmit");
  const added = [addJsonHook(config, "UserPromptSubmit", prompt, undefined, script), addJsonHook(config, "PostToolUse", cmd("json", "PostToolUse"), "*", script)];
  if (added.some(Boolean)) writeFile(file, JSON.stringify(config, null, 2) + "\n");
  return `${added.some(Boolean) ? "Added" : "Already present:"} Mycelium hooks in ${file}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import("node:assert")).default;
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "mycelium-hooks-"));
  const claude = join(dir, "settings.local.json");
  writeFileSync(claude, JSON.stringify({ model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "keep-me" }] }] } }));
  installHooks("claude", dir, claude);
  assert.match(installHooks("claude", dir, claude), /Already present/, "idempotent");
  const c = JSON.parse(readFileSync(claude, "utf8"));
  assert.equal(c.model, "x");
  assert.equal(c.hooks.Stop[0].hooks[0].command, "keep-me", "keeps existing hooks");
  assert.equal(c.hooks.UserPromptSubmit.length, 1);
  assert.equal(c.hooks.PostToolUse[0].matcher, "*");
  assert.throws(() => installHooks("kimi", dir), /global/, "no global hooks");

  // A hook run from this node process walks past sh and node to the same client clientPid() finds here.
  const run = (args) => execFileSync("sh", ["-c", `sh "${join(dir, "hooks", "notify.sh")}" ${args.join(" ")}`]).toString();
  const probe = clientPid();
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const note = "Mycelium: 2 unread message(s) for agent box-claude-1a2b3c4d (1 direct, 2 from trusted agents). read_messages shows them.";
  writeFileSync(join(dir, "sessions", `${probe}.unread`), note);
  assert.equal(JSON.parse(run(["json", "PostToolUse"])).hookSpecificOutput.additionalContext, note);
  assert.equal(run(["text"]), "", "shown once, then removed");
  writeFileSync(join(dir, "sessions", `${probe}.unread`), note);
  assert.equal(run(["text"]).trim(), note);
  for (const [format, field] of [["flat", "additionalContext"], ["cursor", "additional_context"], ["cline", "contextModification"]]) {
    writeFileSync(join(dir, "sessions", `${probe}.unread`), note);
    assert.equal(JSON.parse(run([format]))[field], note, format);
  }
  console.log("hooks: PASS");
}
