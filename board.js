// Work boards: your view of what a tracked agent is doing (see docs/BOARD.md).
// One JSON file per tracked agent in ~/.claude/crewmon/boards/. The extension is the only writer.
// No VS Code code here, so it is tested on its own (tools/test/board.test.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SECTIONS = ['now', 'waiting', 'next', 'later', 'done'];
const MAX_ADDS = 6;            // new items per sync
const EXCERPT_CHARS = 14000;   // what Haiku reads per sync, newest kept
const MIN_GAP_MS = 90e3;       // between automatic syncs of one agent

function dir(home) { return path.join(home || os.homedir(), '.claude', 'crewmon', 'boards'); }
function fileOf(id, home) { return path.join(dir(home), id.replace(/[^\w-]/g, '') + '.json'); }
const newId = () => crypto.randomBytes(4).toString('hex');
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const clean = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n || 160);

// Word overlap, for "is this the same item": 1 = same words
function similar(a, b) {
  const A = new Set(norm(a).split(' ').filter(w => w.length > 2)), B = new Set(norm(b).split(' ').filter(w => w.length > 2));
  if (!A.size || !B.size) return norm(a) === norm(b) ? 1 : 0;
  let both = 0; for (const w of A) if (B.has(w)) both++;
  return both / Math.min(A.size, B.size) * (Math.min(A.size, B.size) / Math.max(A.size, B.size)) ** 0.25;
}
const SAME = 0.72;

function empty(id, title) {
  return { v: 1, id, title: title || '', tracked: true, vision: '', items: [], removed: [],
    created: Date.now(), syncedAt: 0, syncedSize: 0, lastTry: 0, lastError: '' };
}
function load(id, home) {
  try { return JSON.parse(fs.readFileSync(fileOf(id, home), 'utf8')); } catch (_) { return null; }
}
function save(b, home) {
  fs.mkdirSync(dir(home), { recursive: true });
  const f = fileOf(b.id, home), tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(b, null, 1));
  fs.renameSync(tmp, f);                  // atomic: a half-written board is never read
}
function all(home) {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(dir(home)).filter(n => n.endsWith('.json')); } catch (_) { return out; }
  for (const n of names) { const b = load(n.slice(0, -5), home); if (b && b.id) out[b.id] = b; }
  return out;
}

function find(b, itemId) { return b.items.find(x => x.id === itemId); }
function addItem(b, section, text, src, extra) {
  const it = Object.assign({ id: newId(), text: clean(text), section, src, pinned: false, at: Date.now() }, extra || {});
  b.items.push(it);
  return it;
}

// ---- your edits (from the board drawer) ----
function userEdit(b, op) {
  const it = op.itemId ? find(b, op.itemId) : null;
  switch (op.op) {
    case 'add': if (clean(op.text) && SECTIONS.includes(op.section)) addItem(b, op.section, op.text, 'you', { pinned: true }); break;
    case 'text': if (it && clean(op.text)) { it.text = clean(op.text); it.src = 'you'; it.pinned = true; } break;
    case 'move': if (it && SECTIONS.includes(op.to)) { it.section = op.to; it.probable = false; it.at = Date.now(); if (op.to !== 'done') delete it.evidence; } break;
    case 'tick': if (it) { it.from = it.section; it.section = 'done'; it.probable = false; it.evidence = it.evidence || 'ticked by you'; it.at = Date.now(); } break;
    case 'untick': if (it) { it.section = it.from && it.from !== 'done' ? it.from : 'next'; delete it.evidence; it.probable = false; it.at = Date.now(); } break;
    case 'pin': if (it) it.pinned = !!op.on; break;
    case 'delete': if (it) { b.items = b.items.filter(x => x !== it); b.removed.push(norm(it.text)); b.removed = b.removed.slice(-200); } break;
    case 'vision': b.vision = clean(op.text, 300); break;
    case 'track': b.tracked = op.on !== false; break;
  }
  return b;
}

// ---- reading the agent's new turns ----
function textOf(msg) {
  const c = msg && msg.content;
  const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x && x.type === 'text').map(x => x.text).join(' ') : '';
  return t.replace(/\s+/g, ' ').trim();
}
const realUser = (t) => t && !/^(Base directory for this skill|<|\[Request interrupted|Caveat:)/.test(t);
function toolLine(name, i) {
  const cut = (t, n) => clean(t, n);
  switch (name) {
    case 'Bash': {
      const cmd = String(i.command || '');
      const commit = /git commit[^\n]*?-m\s+["']([^"']{3,160})/.exec(cmd);
      if (commit) return 'COMMIT ' + cut(commit[1], 140);
      if (/git push/.test(cmd)) return 'PUSH ' + cut(i.description || cmd, 100);
      return 'RAN ' + cut(i.description || cmd, 110) + (i.run_in_background ? ' (background)' : '');
    }
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return 'EDITED ' + path.basename(String(i.file_path || i.notebook_path || ''));
    case 'Agent': case 'Task': return 'SUBAGENT ' + cut(i.description || i.prompt, 100);
    case 'AskUserQuestion': return 'ASKED YOU ' + cut((i.questions || []).map(q => q.question).join(' | '), 240);
    case 'ExitPlanMode': return 'PLAN ' + cut(i.plan, 600);
    case 'Read': case 'Grep': case 'Glob': case 'ToolSearch': case 'TodoWrite': return '';
    default: return name.startsWith('mcp__') ? 'USED ' + name.split('__').slice(1).join(' ') : '';
  }
}
const SUMMARY_PARTS = /(Pending Tasks|Current Work|Optional Next Step)[^\n]*\n([\s\S]*?)(?=\n\s*\d+\.\s+\*{0,2}[A-Z]|$)/g;

// The turns from byte `from` to the end of the chat, as short lines; plus the agent's latest own to-do list.
function excerpt(file, from) {
  const st = fs.statSync(file);
  const start = Math.max(0, Math.min(from || 0, st.size), st.size - 3 * 1024 * 1024);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(st.size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  let text = buf.toString('utf8');
  if (start > 0 && start !== from) text = text.slice(text.indexOf('\n') + 1);
  const out = [];
  let todos = null, turns = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch (_) { continue; }
    const m = r.message, c = m && m.content;
    if (r.type === 'user' && m && m.role === 'user') {
      const t = textOf(m);
      const nt = /<task-notification>[\s\S]*?<status>(\w+)<\/status>[\s\S]*?<summary>([\s\S]*?)<\/summary>/.exec(t);
      if (nt) { out.push('FINISHED (' + nt[1] + ') ' + clean(nt[2], 200)); continue; }
      if (/^(This session is being continued|.{0,40}Primary Request and Intent)/.test(t)) {
        const parts = []; let p; SUMMARY_PARTS.lastIndex = 0;
        while ((p = SUMMARY_PARTS.exec(String(typeof c === 'string' ? c : textOf(m)))) && parts.length < 3) parts.push(p[1] + ': ' + clean(p[2], 900));
        if (parts.length) out.push('SUMMARY ' + parts.join(' || '));
      } else if (realUser(t)) { out.push('USER ' + clean(t, 500)); turns++; }
    } else if (r.type === 'assistant' && m) {
      const t = textOf(m);
      if (t) out.push('AGENT ' + clean(t, 450));
      if (Array.isArray(c)) for (const b of c) if (b && b.type === 'tool_use') {
        if (b.name === 'TodoWrite' && b.input && Array.isArray(b.input.todos)) todos = b.input.todos;
        const l = toolLine(b.name, b.input || {}); if (l) out.push(l);
      }
    }
  }
  // collapse runs of RAN/EDITED lines, keep the newest text within the budget
  const lines = [];
  for (const l of out) {
    const prev = lines[lines.length - 1];
    if (prev && l.startsWith('EDITED ') && prev.startsWith('EDITED ')) { if (!prev.includes(l.slice(7))) lines[lines.length - 1] = clean(prev + ', ' + l.slice(7), 300); continue; }
    lines.push(l);
  }
  let budget = EXCERPT_CHARS; const kept = [];
  for (let i = lines.length - 1; i >= 0 && budget > 0; i--) { kept.unshift(lines[i]); budget -= lines[i].length + 1; }
  return { text: kept.join('\n'), end: st.size, todos, turns, lines: lines.length };
}

// ---- the agent's own to-do list (TodoWrite) wins: map it straight onto the board ----
function applyTodos(b, todos) {
  if (!Array.isArray(todos)) return 0;
  let n = 0;
  for (const t of todos) {
    const text = clean(t.content), sec = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'now' : 'next';
    if (!text || b.removed.includes(norm(text))) continue;
    const it = b.items.find(x => similar(x.text, text) >= SAME);
    if (!it) { addItem(b, sec, text, 'agent', sec === 'done' ? { evidence: 'its to-do list' } : {}); n++; }
    else if (it.section !== sec && !(it.pinned && sec !== 'done')) {
      it.section = sec; it.at = Date.now(); it.probable = false; if (sec === 'done') it.evidence = 'its to-do list'; n++;
    }
  }
  // only one thing is "now": older auto items in now go back to next
  return n;
}

// ---- Haiku's proposed changes, applied under the rules ----
function applyOps(b, ops) {
  const res = { added: 0, moved: 0, done: 0, skipped: 0 };
  if (!Array.isArray(ops)) return res;
  const maxAdds = b.items.length ? MAX_ADDS : MAX_ADDS + 4;   // a new board may start with a few more
  for (const o of ops.slice(0, 30)) {
    if (!o || typeof o !== 'object') { res.skipped++; continue; }
    if (o.op === 'add') {
      const text = clean(o.text, 120), sec = SECTIONS.includes(o.section) ? o.section : 'next';
      if (!text || res.added >= maxAdds || b.removed.includes(norm(text))) { res.skipped++; continue; }
      const dup = b.items.find(x => similar(x.text, text) >= SAME);
      if (dup) {        // the same thing again: treat as a move of the existing item
        if (dup.section !== sec && !dup.pinned && dup.src !== 'you' && (sec !== 'done' || o.evidence)) { dup.section = sec; dup.at = Date.now(); if (sec === 'done') dup.evidence = clean(o.evidence, 120); res.moved++; }
        else res.skipped++;
        continue;
      }
      addItem(b, sec, text, 'auto', sec === 'done' ? (o.evidence ? { evidence: clean(o.evidence, 120) } : { probable: true }) : {});
      res.added++;
    } else if (o.op === 'move' || o.op === 'done') {
      const it = find(b, o.id), to = o.op === 'done' ? 'done' : o.to;
      if (!it || !SECTIONS.includes(to) || it.section === to) { res.skipped++; continue; }
      if ((it.src === 'you' || it.pinned) && to !== 'done') { res.skipped++; continue; }   // yours: only ever ticked
      if (to === 'done') {
        it.from = it.section; it.section = 'done'; it.at = Date.now();
        if (o.evidence) { it.evidence = clean(o.evidence, 120); it.probable = false; } else it.probable = true;
        res.done++;
      } else { it.section = to; it.at = Date.now(); res.moved++; }
    } else if (o.op === 'vision' && !b.vision && clean(o.text)) {
      b.vision = clean(o.text, 300);
    } else res.skipped++;
  }
  // "now" holds one or two things: the oldest extra auto items step back to next
  const now = b.items.filter(x => x.section === 'now' && x.src !== 'you' && !x.pinned).sort((x, y) => y.at - x.at);
  for (const x of now.slice(2)) x.section = 'next';
  return res;
}

// ---- the Haiku request ----
function prompt(b, ex) {
  const items = b.items.filter(x => x.section !== 'done' || Date.now() - x.at < 3 * 86400e3)
    .map(x => ({ id: x.id, section: x.section, text: x.text, mine: x.src === 'you' || x.pinned }));
  return [
    'You keep a small work board for a person who supervises a Claude Code agent. The agent does not know about the board.',
    'Sections: now (what it is doing), waiting (questions or decisions it is waiting on the person for), next (agreed to-do), later (ideas, not yet agreed), done.',
    'Read the board and what happened since the last update, then reply with ONLY a JSON object: {"ops":[...]} with at most 12 ops:',
    '  {"op":"add","section":"next","text":"..."}   a new item, at most 12 words, starting with a verb; done items need "evidence"',
    '  {"op":"move","id":"...","to":"waiting"}      an item changed state',
    '  {"op":"done","id":"...","evidence":"commit 3fa2: ..."}   finished; evidence = at most 10 words: a commit, a file, a passing test, or the agent saying it is done',
    b.vision ? '' : '  {"op":"vision","text":"..."}   only if the overall goal is clear: one sentence',
    'Rules: prefer moving existing items over adding; never add something already on the board in other words; items marked mine:true are the person\'s: only mark them done.',
    'A question the agent asked that the person has not answered goes to waiting. A question that was answered leaves waiting. Do not add tiny steps (reading files, running ls).',
    'If nothing changed, reply {"ops":[]}.',
    '',
    'BOARD ' + JSON.stringify({ vision: b.vision, items }),
    '',
    'SINCE THE LAST UPDATE (USER = the person, AGENT = the agent, other lines = its actions):',
    ex.text || '(nothing)',
  ].filter(x => x !== '').join('\n');
}
function parseReply(out) {
  const s = String(out || ''); const a = s.indexOf('{'), z = s.lastIndexOf('}');
  if (a < 0 || z <= a) throw new Error('no JSON in the reply');
  const j = JSON.parse(s.slice(a, z + 1));
  if (!Array.isArray(j.ops)) throw new Error('the reply has no "ops" list');
  return j.ops;
}

// ---- background work: commands, subagents, workflows, monitors (no AI) ----
const JOB_TOOLS = { Bash: 'command', Agent: 'subagent', Task: 'subagent', Workflow: 'workflow', Monitor: 'monitor' };
function jobs(file, opts) {
  const o = opts || {};
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - (o.bytes || 8 * 1024 * 1024));
  const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(st.size - start); fs.readSync(fd, buf, 0, buf.length, start); fs.closeSync(fd);
  let text = buf.toString('utf8'); if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  const byUse = new Map(), byTask = new Map();
  const finish = (j, status, at, summary) => {
    if (!j || j.status !== 'running') return;
    j.status = status; j.ended = at;
    const r = clean(String(summary || '').replace(/^(Background command|Monitor|Dynamic workflow|Workflow|Agent|Subagent)\s+"[^"]*"\s*/i, ''), 200);
    if (r) j.result = r;
  };
  for (const line of text.split('\n')) {
    if (!line.includes('tool_use') && !line.includes('task-notification') && !line.includes('tool_result')) continue;
    let r; try { r = JSON.parse(line); } catch (_) { continue; }
    const at = r.timestamp ? Date.parse(r.timestamp) : 0, c = r.message && r.message.content;
    const blocks = Array.isArray(c) ? c : typeof c === 'string' ? [{ type: 'text', text: c }] : [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'tool_use' && JOB_TOOLS[b.name]) {
        const i = b.input || {};
        if (b.name === 'Bash' && !i.run_in_background) continue;
        byUse.set(b.id, { use: b.id, kind: JOB_TOOLS[b.name], title: clean(i.description || i.prompt || i.command || (i.script || '').replace(/[\s\S]*?description:\s*['"]([^'"]+)[\s\S]*/, '$1'), 90),
          started: at, status: 'running', sync: b.name === 'Agent' && !i.run_in_background });
      } else if (b.type === 'tool_result') {
        const j = byUse.get(b.tool_use_id);
        const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
        if (j) {
          const id = /background with ID: (\w+)|agentId: (\w+)|Task ID: (\w+)|Monitor started \(task (\w+)/.exec(t);
          if (id) { j.task = id.slice(1).find(Boolean); byTask.set(j.task, j); }
          else if (b.is_error) finish(j, 'failed', at, t.replace(/<[^>]+>/g, ' '));
          else finish(j, 'completed', at, '');      // it ran in the foreground after all (or a subagent that waited)
        }
        const stop = /Successfully stopped task: (\w+)/.exec(t);
        if (stop) finish(byTask.get(stop[1]), 'stopped', at, 'stopped');
      } else if (b.type === 'text' && b.text && b.text.includes('<task-notification>')) {
        for (const n of b.text.split('<task-notification>').slice(1)) {
          const g = (tag) => { const x = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>').exec(n); return x ? x[1].trim() : ''; };
          const j = byUse.get(g('tool-use-id')) || byTask.get(g('task-id'));
          if (!j) continue;
          const status = g('status');
          if (status) finish(j, status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'stopped', at, g('summary'));
          else { j.last = clean(g('summary') || g('event') || n.replace(/<[^>]+>/g, ' '), 140); j.lastAt = at; }   // a monitor's event
        }
      }
    }
  }
  const now = o.now || Date.now();
  const list = [...byUse.values()].filter(j => !(j.sync && j.status !== 'running'));
  if (o.offline) for (const j of list) if (j.status === 'running') { j.status = 'unknown'; j.result = 'the chat is not running'; }
  const running = list.filter(j => j.status === 'running' || j.status === 'unknown').sort((a, b) => b.started - a.started);
  const recent = list.filter(j => j.status !== 'running' && j.status !== 'unknown' && now - (j.ended || 0) < (o.recentMs || 6 * 3600e3)).sort((a, b) => b.ended - a.ended);
  return { running: running.slice(0, 12), recent: recent.slice(0, 8) };
}

// Should this tracked agent sync now? New turns, idle (or forced), and not too soon.
function due(b, s, now) {
  if (!b || !b.tracked || !s || !s.file) return false;
  if (s.state === 'busy') return false;
  if ((s.size || 0) <= (b.syncedSize || 0) + 200) return false;
  return (now || Date.now()) - (b.lastTry || 0) >= MIN_GAP_MS;
}

module.exports = { jobs, SECTIONS, dir, fileOf, empty, load, save, all, userEdit, excerpt, applyTodos, applyOps, prompt, parseReply, due, similar, norm, MIN_GAP_MS };
