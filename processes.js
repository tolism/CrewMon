// CrewMon: which Claude Code chats are running, on Linux, macOS and Windows (read-only).
//   Linux    /proc
//   macOS    `ps`, plus Claude Code's own session files
//   Windows  Claude Code's own session files only
// Session files = ~/.claude/sessions/<pid>.json, written by Claude Code for each running chat. They are not a documented
// interface, so every field is optional here, and where `ps` exists a chat found there counts even without one.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SESSIONS = path.join(os.homedir(), '.claude', 'sessions');

function isClaude(argv) { return argv.length > 0 && /(^|\/)claude$/.test(argv[0]); }

// ---- the process table: Map pid -> { pid, ppid, argv, start (ms since the epoch, 0 = unknown), started (UTC text) } ----
function procTable() {   // Linux
  const out = new Map();
  let bootMs = 0;
  try { bootMs = Number(/btime (\d+)/.exec(fs.readFileSync('/proc/stat', 'utf8'))[1]) * 1000; } catch (_) { /* unknown */ }
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`).toString().split('\0').filter(Boolean);
      const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const f = st.slice(st.lastIndexOf(')') + 2).split(' ');   // f[1] = parent, f[19] = start (clock ticks since boot)
      out.set(Number(pid), { pid: Number(pid), ppid: Number(f[1]), argv, started: '',
        start: bootMs ? bootMs + Number(f[19]) * 10 : 0 });     // USER_HZ is 100 on Linux
    } catch (_) { /* the process ended meanwhile */ }
  }
  return out;
}
// One line of `ps -o pid=,ppid=,lstart=,args=` (C locale, UTC): "  12   1 Mon Nov 16 08:10:06 2026     /path/claude --x"
function parsePs(text) {
  const out = new Map();
  for (const l of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(l);
    if (!m) continue;
    const started = m[3].replace(/\s+/g, ' ');
    out.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), argv: m[4].trim().split(/\s+/), started,
      start: Date.parse(started + ' UTC') || 0 });
  }
  return out;
}
function psTable() {   // macOS and other Unix
  return parsePs(execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,lstart=,args='], {
    env: Object.assign({}, process.env, { LC_ALL: 'C', TZ: 'UTC' }), encoding: 'utf8', timeout: 5000,
    maxBuffer: 32 << 20, stdio: ['ignore', 'pipe', 'ignore'] }));
}
function processTable() {   // null = this system has none we can read
  try {
    if (process.platform === 'linux') return procTable();
    if (process.platform === 'win32') return null;
    return psTable();
  } catch (_) { return null; }
}

// ---- Claude Code's session files ----
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function sessionFiles(dir) {   // those whose process is alive
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir || SESSIONS).filter(f => f.endsWith('.json')); } catch (_) { return out; }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir || SESSIONS, f), 'utf8'));
      if (d.sessionId && pidAlive(d.pid)) out.push(d);
    } catch (_) { /* being written, or not ours */ }
  }
  return out;
}

// ---- running chats: {sessionId: [{pid, host, start, status}]} ----
// host = 'vscode' | 'machine' (keeper/tmux) | 'terminal';  status = 'busy' | 'idle' | '' (unknown: go by the chat file)
function collect(table, files, linux) {
  const byPid = new Map();
  for (const p of table ? table.values() : []) {
    const a = p.argv;
    if (!isClaude(a)) continue;
    const parent = (table.get(p.ppid) || { argv: [] }).argv;
    if (isClaude(parent)) continue;                       // a subagent or helper of a chat
    let id = null;
    for (let i = 0; i < a.length; i++) {
      if (a[i].startsWith('--resume=')) id = a[i].slice(9);
      else if (a[i] === '--resume' && a[i + 1]) id = a[i + 1];
    }
    if (!id) continue;
    const pj = parent.join(' ');
    const inVS = pj.includes('.vscode-server') || (!linux && /Helper \(Plugin\)/.test(pj));
    const host = inVS ? 'vscode' : (a.includes('--remote-control') && !a.includes('stream-json')) ? 'machine' : 'terminal';
    byPid.set(p.pid, { id, pid: p.pid, host, start: p.start, status: '' });
  }
  if (!linux) for (const d of files) {                    // also finds a new chat, whose command line has no --resume
    const p = table && table.get(d.pid);
    if (table && !p) continue;
    if (p && d.procStart && /^\w{3} \w{3}/.test(d.procStart) &&
        Math.abs(Date.parse(d.procStart.replace(/\s+/g, ' ') + ' UTC') - p.start) > 2000) continue;   // the pid was reused
    if (p && isClaude((table.get(p.ppid) || { argv: [] }).argv)) continue;
    const known = byPid.get(d.pid);
    const a = p ? p.argv : [];
    const host = d.entrypoint === 'claude-vscode' ? 'vscode' : known ? known.host
      : (a.includes('--remote-control') && !a.includes('stream-json')) ? 'machine' : 'terminal';
    byPid.set(d.pid, { id: d.sessionId, pid: d.pid, host, start: p ? p.start : d.startedAt || 0,
      status: d.status === 'busy' || d.status === 'idle' ? d.status : '' });
  }
  const out = {};
  for (const { id, pid, host, start, status } of byPid.values()) (out[id] = out[id] || []).push({ pid, host, start, status });
  return out;
}
function runningSessions() {
  const linux = process.platform === 'linux';
  return collect(processTable(), linux ? [] : sessionFiles(), linux);
}

// ---- where things are installed ----
// the Claude binary shipped with the newest installed Claude Code extension (Remote-SSH or desktop VS Code)
function claudeBin(home) {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const found = [];
  for (const root of ['.vscode-server', '.vscode-server-insiders', '.vscode', '.vscode-insiders']) {
    const dir = path.join(home || os.homedir(), root, 'extensions');
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const d of names) {
      const m = /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/.exec(d);
      const bin = path.join(dir, d, 'resources', 'native-binary', exe);
      if (m && fs.existsSync(bin)) found.push({ bin, v: m.slice(1).map(Number) });
    }
  }
  found.sort((p, q) => q.v[0] - p.v[0] || q.v[1] - p.v[1] || q.v[2] - p.v[2]);
  return found.length ? found[0].bin : null;
}
// tmux: an app started from the Dock may not have Homebrew on its PATH
function tmuxBin() {
  for (const d of (process.env.PATH || '').split(path.delimiter).concat('/opt/homebrew/bin', '/usr/local/bin')) {
    if (!d) continue;
    const f = path.join(d, 'tmux');
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch (_) { /* next */ }
  }
  return 'tmux';
}

module.exports = { runningSessions, sessionFiles, claudeBin, tmuxBin, collect, parsePs };
