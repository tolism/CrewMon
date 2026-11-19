// CrewMon: the list of Claude Code sessions on this machine (read-only).
// Sessions = chat files in ~/.claude/projects/<project>/<id>.jsonl; running state from /proc.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const KEEPER_STATE = path.join(os.homedir(), '.claude', 'keeper', 'state.json');
const ROLES = path.join(os.homedir(), '.claude', 'crewmon', 'roles.json');   // user-written descriptions
const AUTO = path.join(os.homedir(), '.claude', 'crewmon', 'auto.json');     // AI one-liners, keyed by summary
const GROUPS = path.join(os.homedir(), '.claude', 'crewmon', 'groups.json'); // your groups: {sessionId: group}
const BUSY_S = 20; // file written in the last 20 s while running = busy

function readSlice(file, start, len) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.slice(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function lines(text, dropFirst) {
  const ls = text.split('\n');
  if (dropFirst) ls.shift();           // a tail read starts mid-line
  const out = [];
  for (const l of ls) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch (_) { /* partial line */ }
  }
  return out;
}

function textOf(msg) {
  if (!msg) return '';
  const c = msg.content;
  let t = typeof c === 'string' ? c
    : Array.isArray(c) ? c.filter(x => x && x.type === 'text').map(x => x.text).join(' ') : '';
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

// A short "what this agent is for" from its first request: no markdown, no pasted logs, one or two sentences.
function describe(first, title) {
  let t = (first || '').replace(/```[\s\S]*?```/g, ' ').replace(/[#*_`>|]/g, ' ').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  if (!t || /^(This session is being continued|Base directory for this skill)/.test(t)) return title || '';
  const cut = t.slice(0, 180);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '));
  return end > 60 ? cut.slice(0, end + 1) : (t.length > 180 ? cut.replace(/\s+\S*$/, '') + '…' : cut);
}

function isRealUserText(t) {
  return t && !t.startsWith('Base directory for this skill') && !t.startsWith('<') && !t.startsWith('[Request interrupted') && !t.startsWith('Caveat:');
}

// A few words on what a tool call is doing, for the speech bubble.
function toolText(name, input) {
  const base = (p) => path.basename(String(p || ''));
  const cut = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  switch (name) {
    case 'Bash': return input.description ? cut(input.description, 38) : 'running ' + cut(input.command, 30);
    case 'Read': return 'reading ' + base(input.file_path);
    case 'Edit': case 'MultiEdit': return 'editing ' + base(input.file_path);
    case 'Write': return 'writing ' + base(input.file_path);
    case 'NotebookEdit': return 'editing ' + base(input.notebook_path);
    case 'Grep': return 'searching for ' + cut(input.pattern, 24);
    case 'Glob': return 'looking for ' + cut(input.pattern, 24);
    case 'Agent': case 'Task': return 'subagent: ' + cut(input.description || input.prompt, 28);
    case 'WebSearch': return 'searching the web';
    case 'WebFetch': return 'reading a web page';
    case 'AskUserQuestion': return 'asking you a question';
    case 'TodoWrite': return 'updating its to-do list';
    case 'Skill': return 'using a skill: ' + cut(input.skill, 24);
    case 'Workflow': return 'running a workflow';
    case 'SendMessage': return 'messaging another agent';
    default: return name.startsWith('mcp__') ? 'using ' + name.split('__')[1] : cut(name, 30);
  }
}

function readSession(file) {
  const st = fs.statSync(file);
  const head = lines(readSlice(file, 0, Math.min(st.size, 128 * 1024)), false);
  const tailStart = Math.max(0, st.size - 512 * 1024);
  const tail = lines(readSlice(file, tailStart, st.size - tailStart), tailStart > 0);
  const s = { title: '', firstRequest: '', lastRequest: '', lastReply: '', cwd: '', startCwd: '', branch: '', lastTs: null };
  for (const r of head) {
    if (!s.startCwd && r.cwd) s.startCwd = r.cwd;
    if (!s.firstRequest && r.type === 'user' && r.message && r.message.role === 'user') {
      const t = textOf(r.message);
      if (isRealUserText(t)) s.firstRequest = t.slice(0, 300);
    }
  }
  let aiTitle = '', customTitle = '';
  for (const r of head.concat(tail)) {
    if (r.type === 'ai-title' && r.aiTitle) aiTitle = r.aiTitle;
    if (r.type === 'custom-title' && r.customTitle) customTitle = r.customTitle;
    if (r.type === 'summary' && r.summary && !aiTitle) aiTitle = r.summary;
  }
  const pending = new Map();   // tool_use id -> {name, input} without a result yet
  let last = null;             // what the newest record was: {kind: 'tool'|'text'|'result'|'user', ...}
  for (const r of tail) {
    if (r.cwd) s.cwd = r.cwd;
    if (r.gitBranch) s.branch = r.gitBranch;
    if (r.timestamp) s.lastTs = r.timestamp;
    const c = r.message && r.message.content;
    if (r.type === 'user' && r.message && r.message.role === 'user') {
      const t = textOf(r.message);
      if (isRealUserText(t)) { s.lastRequest = t.slice(0, 400); last = { kind: 'user' }; }
      if (Array.isArray(c)) for (const b of c) if (b && b.type === 'tool_result') { pending.delete(b.tool_use_id); last = { kind: 'result' }; }
    }
    if (r.type === 'assistant' && r.message) {
      const t = textOf(r.message);
      if (t) { s.lastReply = t.slice(0, 400); last = { kind: 'text' }; }
      if (Array.isArray(c)) for (const b of c) if (b && b.type === 'tool_use') {
        pending.set(b.id, { name: b.name, input: b.input || {} });
        last = { kind: 'tool', name: b.name, input: b.input || {} };
      }
    }
  }
  const open = [...pending.values()];
  s.pendingAsk = open.some(p => p.name === 'AskUserQuestion');
  s.pendingTool = open.length ? open[open.length - 1].name : '';
  s.activity = last && last.kind === 'tool' ? toolText(last.name, last.input)
    : last && last.kind === 'result' ? 'thinking' : last && last.kind === 'user' ? 'reading your message' : 'writing a reply';
  s.title = customTitle || aiTitle || s.firstRequest.slice(0, 60) || '(untitled)';
  s.desc = describe(s.firstRequest, s.title);
  s.size = st.size;
  s.mtime = st.mtimeMs;
  return s;
}

function cmdline(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`).toString().split('\0').filter(Boolean); }
  catch (_) { return []; }
}
function ppid(pid) {
  try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return parseInt(s.slice(s.lastIndexOf(')') + 2).split(' ')[1], 10); }
  catch (_) { return 0; }
}
function isClaude(argv) { return argv.length > 0 && /(^|\/)claude$/.test(argv[0]); }

// {sessionId: [{pid, host}]}  host = 'vscode' | 'machine' (keeper/tmux) | 'terminal'
function runningSessions() {
  const out = {};
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    const a = cmdline(pid);
    if (!isClaude(a)) continue;
    const parent = cmdline(ppid(pid));
    if (isClaude(parent)) continue;                       // a subagent or helper of a chat
    let id = null;
    for (let i = 0; i < a.length; i++) {
      if (a[i].startsWith('--resume=')) id = a[i].slice(9);
      else if (a[i] === '--resume' && a[i + 1]) id = a[i + 1];
    }
    if (!id) continue;
    const pj = parent.join(' ');
    const host = pj.includes('.vscode-server') ? 'vscode'
      : (a.includes('--remote-control') && !a.includes('stream-json')) ? 'machine' : 'terminal';
    (out[id] = out[id] || []).push({ pid: Number(pid), host });
  }
  return out;
}

function roles() {
  try { return JSON.parse(fs.readFileSync(ROLES, 'utf8')); } catch (_) { return {}; }
}

function keeperState() {
  try { return JSON.parse(fs.readFileSync(KEEPER_STATE, 'utf8')); } catch (_) { return null; }
}

const cache = new Map(); // file -> {mtime, size, data}
const summaries = new Map(); // file -> {scannedSize, text}

// The newest compaction summary's "Primary Request and Intent" section: what the agent has been asked to do.
// Searched backwards from the end of the file (at most 32 MB), and again only after the file grew by 2 MB.
// Real summaries number it as the first section ("1. " + optional bold); built in pieces so this file never matches itself.
const MARKS = ['1. ' + '**' + 'Primary Request', '1. ' + 'Primary Request'];
function lastSummary(file, size) {
  const prev = summaries.get(file);
  if (prev && size - prev.scannedSize < 2 * 1024 * 1024) return prev.text;
  let text = prev ? prev.text : '';
  const CH = 4 * 1024 * 1024;
  for (let end = size; end > 0 && size - end < 32 * 1024 * 1024; end -= CH) {
    const start = Math.max(0, end - CH - 8192);
    const chunk = readSlice(file, start, end - start);
    const i = Math.max(...MARKS.map(m => chunk.lastIndexOf(m)));
    if (i >= 0) {
      let raw = chunk.slice(i + 3, i + 4000).replace(/^\*\*/, '');
      const sec2 = raw.search(/\\n\s*2\. /);           // stop at section 2 of the summary
      if (sec2 > 0) raw = raw.slice(0, sec2);
      text = raw.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, ' ').slice(0, 3000);
      break;
    }
  }
  summaries.set(file, { scannedSize: size, text });
  return text;
}
function hashStr(t) { let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }

function snapshot(days) {
  const since = Date.now() - days * 86400e3;
  const running = runningSessions();
  const keeper = keeperState();
  const role = roles();
  let groups = {};
  try { groups = JSON.parse(fs.readFileSync(GROUPS, 'utf8')); } catch (_) { /* none yet */ }
  let auto = {};
  try { auto = JSON.parse(fs.readFileSync(AUTO, 'utf8')); } catch (_) { /* none yet */ }
  const sessions = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS); } catch (_) { return { sessions, at: Date.now() }; }
  for (const d of dirs) {
    const dir = path.join(PROJECTS, d);
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch (_) { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      let st;
      try { st = fs.statSync(file); } catch (_) { continue; }
      const id = f.slice(0, -6);
      if (d.includes('-claude-crewmon')) continue;   // CrewMon's own helper sessions (messenger, one-liners) are not crew
      if (st.mtimeMs < since && !running[id]) continue;
      let c = cache.get(file);
      if (!c || c.mtime !== st.mtimeMs || c.size !== st.size) {
        try { c = { mtime: st.mtimeMs, size: st.size, data: readSession(file) }; } catch (_) { continue; }
        cache.set(file, c);
      }
      const r = running[id] || [];
      const hosts = [...new Set(r.map(x => x.host))];
      const ageS = (Date.now() - st.mtimeMs) / 1000;
      const state = r.length === 0 ? 'offline' : ageS < BUSY_S ? 'busy' : 'idle';
      const k = keeper && keeper.chats && keeper.chats[id];
      sessions.push(Object.assign({}, c.data, {
        id, project: d, file, hosts, state, ageS: Math.round(ageS),
        keeper: k ? (k.status || '') : '',
        role: role[id] || '',
        group: groups[id] || '',
        // needs you: waiting on your answer (AskUserQuestion) or, likely, on a permission prompt (tool call unanswered for 20 s)
        needsYou: r.length > 0 && (c.data.pendingAsk || (!!c.data.pendingTool && ageS > 20)),
      }));
      const last = sessions[sessions.length - 1];
      try { last.summary = lastSummary(file, st.size); } catch (_) { last.summary = ''; }
      if (!last.summary && last.firstRequest)   // no compaction yet: describe it from its requests
        last.summary = 'Title: ' + last.title + '\nFirst request: ' + last.firstRequest +
          (last.lastRequest && last.lastRequest !== last.firstRequest ? '\nLatest request: ' + last.lastRequest : '');
      last.summaryKey = last.summary ? hashStr(last.summary) : '';
      const a = auto[id];
      last.auto = a && a.text ? a.text : '';
      last.autoFresh = !!(a && a.key === last.summaryKey);
    }
  }
  sessions.sort((a, b) => (a.state === 'offline') - (b.state === 'offline') || b.mtime - a.mtime);
  return { sessions, at: Date.now() };
}

module.exports = { snapshot, runningSessions, ROLES, AUTO, GROUPS };

if (require.main === module) {   // `node snapshot.js [days]` prints the list
  const s = snapshot(Number(process.argv[2] || 7)).sessions;
  for (const x of s) console.log(`${x.id.slice(0, 8)}  ${x.state.padEnd(7)}  ${(x.hosts.join(',') || '-').padEnd(8)}  ${path.basename(x.startCwd || '').padEnd(28)}  ${x.title}`);
}
