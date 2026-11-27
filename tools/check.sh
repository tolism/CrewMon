#!/usr/bin/env bash
# CrewMon pre-push check: everything that must be true before anything goes to GitHub.
#   tools/check.sh            check the working tree
#   (installed as .git/hooks/pre-push by tools/install-hooks.sh, so git push refuses to push when it fails)
set -u
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node/bin:$PATH"
fail=0
ok()   { printf '  \033[32m✔\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✘\033[0m %s\n' "$1"; fail=1; }
step() { printf '\n%s\n' "$1"; }

step "1. Code parses"
for f in extension.js snapshot.js board.js research.js processes.js delivery.js media/critters.js tools/gallery.js tools/screenshot/build-demo.js tools/screenshot/shoot.js; do
  node --check "$f" 2>/dev/null && ok "$f" || bad "$f does not parse"
done
python3 - <<'EOF' > /tmp/crewmon-check-map.js || bad "could not extract the map script"
import re
h = open('media/map.html').read()
print(re.findall(r'<script nonce="\{\{nonce\}\}">(.*?)</script>', h, re.S)[-1])
EOF
node --check /tmp/crewmon-check-map.js 2>/dev/null && ok "media/map.html (script)" || bad "media/map.html script does not parse"
python3 -c "import ast,sys; ast.parse(open('keeper/keeper').read())" && ok "keeper/keeper" || bad "keeper/keeper does not parse"
for f in build_vsix.py make_icon.py; do python3 -m py_compile "$f" 2>/dev/null && ok "$f" || bad "$f does not compile"; done
rm -rf __pycache__ keeper/__pycache__
python3 -c "import json; json.load(open('package.json')); json.load(open('messenger/.claude-plugin/plugin.json'))" && ok "package.json, plugin.json" || bad "a JSON file is invalid"

node --test tools/test/*.test.js >/tmp/crewmon-check-tests.log 2>&1 && ok "board and Research Companion rules: $(grep -E '^(# |ℹ )pass' /tmp/crewmon-check-tests.log | sed -E 's/^(# |ℹ )pass //') tests pass" || { bad "board or Research Companion tests fail"; grep -E "not ok|Error" /tmp/crewmon-check-tests.log | head -5; }

step "2. Messenger plugin validates"
CLAUDE_BIN=$(node -p "require('./processes').claudeBin() || ''")
if [ -x "$CLAUDE_BIN" ]; then
  out=$(env $(env | grep -oE '^CLAUDE[A-Z_]*' | sed 's/^/-u /') "$CLAUDE_BIN" plugin validate messenger 2>&1)
  echo "$out" | grep -q "Validation passed" && ! echo "$out" | grep -q "error TS" && ok "claude plugin validate messenger" || { bad "messenger plugin validation failed"; echo "$out" | grep -E "error|✘" | head -5; }
elif [ -n "${CI:-}" ]; then
  printf '  - skipped: no Claude Code on this machine (CI)\n'
else
  bad "no Claude Code binary found to validate the messenger"
fi
if node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 6) ? 0 : 1)'; then
  out=$(node --experimental-strip-types --no-warnings tools/test-messenger.mjs 2>&1) && ok "$out" || { bad "messenger tests failed"; echo "$out" | head -20; }
else
  printf '  - skipped: the messenger tests need Node 22.6 or newer (this is %s)\n' "$(node --version)"
fi

step "3. Package builds"
python3 build_vsix.py >/dev/null && ok "build_vsix.py" || bad "build_vsix.py failed"
if command -v vsce >/dev/null; then
  vsce ls >/dev/null 2>&1 && ok "vsce accepts the package" || bad "vsce rejects the package"
fi
git diff --quiet -- messenger/hooks/register.ts messenger/.claude-plugin/plugin.json || bad "the build changed the messenger version stamp: commit it first"

step "4. It runs (headless browser, example crew)"
if [ -d tools/screenshot/node_modules/playwright ]; then
  node tools/screenshot/build-demo.js >/dev/null
  node - <<'EOF' && ok "map, Activity, Inbox, View, hand-over window, work board, Research Companion, roll-down: no page errors" || bad "the map page reports errors"
const { chromium } = require(process.cwd() + '/tools/screenshot/node_modules/playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto('file://' + process.cwd() + '/tools/screenshot/demo.html'); await p.waitForTimeout(800);
  const nodes = await p.$$eval('.node', n => n.length);
  if (nodes < 5) errs.push('only ' + nodes + ' agents drawn');
  for (const id of ['#actbtn', '#inboxbtn', '#viewbtn']) { await p.click(id); await p.waitForTimeout(150); await p.keyboard.press('Escape'); }
  await p.evaluate(() => { openHandover(sessions[0], sessions[1]); setDest(true); setDest(false); $('hcancel').click(); });
  await p.evaluate(() => { select(sessions[0].id, false); });
  await p.keyboard.press('t'); await p.waitForTimeout(150);
  if (await p.$eval('#board', e => e.hidden)) errs.push('the work board did not open');
  await p.evaluate(() => { const s = sessions.find(x => x.rkey && research[x.rkey]); if (s) select(s.id, false); });
  await p.keyboard.press('e'); await p.waitForTimeout(150);
  if (await p.$eval('#research', e => e.hidden)) errs.push('Research Companion did not open');
  for (const t of ['plan', 'compare', 'runs', 'questions']) { await p.click('[data-tab="' + t + '"]'); await p.waitForTimeout(60); }
  await p.click('.rexp .rrow'); await p.waitForTimeout(60); await p.keyboard.press('Escape');
  await p.keyboard.press('b'); await p.keyboard.press('b'); await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
  if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
  await b.close();
})().catch(e => { console.error(e.message); process.exit(1); });
EOF
else
  bad "playwright not installed (cd tools/screenshot && npm install && npm run setup)"
fi

step "5. Nothing sensitive or generated is pushed"
range="${1:-}"
if [ -z "$range" ]; then
  up=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
  range="${up:+$up..HEAD}"
fi
files=$(git ls-files)
added=$( { [ -n "$range" ] && git diff "$range"; git diff HEAD; } 2>/dev/null | grep '^+' | grep -v '^+++' || true)
# personal or machine details (read from this machine, so the check itself names nobody), keys
me=$(whoami); host=$(hostname); ip=$(hostname -I 2>/dev/null | awk '{print $1}')
# (written in pieces, so this line does not match itself)
k1="sk-""ant-"; k2="ghp""_[A-Za-z0-9]{20}"; k3="AK""IA[0-9A-Z]{16}"; k4="PRIVATE"" KEY"; m1="@gm""ail\\.com"; m2="@ya""hoo\\."
pat="$HOME/|$me@|\\b$host\\b|$m1|$m2|$k1|$k2|$k3|$k4"
[ -n "$ip" ] && pat="$pat|${ip//./\\.}"
if echo "$added" | grep -nE "$pat" >/tmp/crewmon-check-hits; then
  bad "sensitive text in what is being pushed:"; head -8 /tmp/crewmon-check-hits | cut -c1-160
else
  ok "no personal paths, emails, hosts, keys or participant ids"
fi
if echo "$files" | grep -nE '\.(parquet|csv|h5|pkl|npy|jsonl|vsix|db|sqlite)$|(^|/)(dist|node_modules|\.claude)/|(^|/)demo\.html$|package-lock\.json$' ; then
  bad "data, build or generated files are tracked (above)"
else
  ok "no data, build or generated files tracked"
fi
big=$(git ls-files -z | xargs -0 du -k 2>/dev/null | awk '$1 > 1024 {print $2" ("$1" KB)"}')
[ -z "$big" ] && ok "no file over 1 MB" || { bad "large files:"; echo "$big"; }

echo
if [ "$fail" = 0 ]; then printf '\033[32mAll checks passed.\033[0m\n'; else printf '\033[31mChecks failed: not ready to push.\033[0m\n'; fi
exit $fail
