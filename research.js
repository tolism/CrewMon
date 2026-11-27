// Research Companion: what a project's agents are researching, and why (see docs/RESEARCH.md).
// One JSON file per project in ~/.claude/crewmon/research/. The extension is the only writer.
// Everything comes from the agents' chats: runs are detected by fixed rules (no AI); questions, experiments, reasons and
// results are proposed by Haiku and applied here under rules it cannot break. No VS Code code: tested on its own
// (tools/test/research.test.js).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { similar, norm } = require('./board');

const STATUSES = ['planned', 'running', 'done', 'failed', 'stopped', 'dropped'];
const Q_STATUSES = ['open', 'answered', 'dropped'];
const VERDICTS = ['supports', 'refutes', 'unclear'];
const Q_FIELDS = ['text', 'why', 'status', 'answer'];
const E_FIELDS = ['title', 'why', 'expect', 'status', 'result', 'verdict', 'next', 'q', 'data', 'models'];
const MAX_ADDS = 8;              // new questions + experiments per sync
const EXCERPT_CHARS = 22000;     // what Haiku reads per sync, newest kept
const MIN_GAP_MS = 120e3;        // between automatic syncs of one agent
const SAME_Q = 0.72, SAME_E = 0.8;

const newId = (p) => p + crypto.randomBytes(3).toString('hex');
const clean = (t, n) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, n || 200);

// ---- where a project lives ----
const rootCache = new Map();
function projectRoot(cwd) {       // the git root above cwd, else cwd itself
  if (!cwd) return '';
  if (rootCache.has(cwd)) return rootCache.get(cwd);
  let d = cwd, found = '';
  for (let i = 0; i < 40 && d; i++) {
    try { if (fs.existsSync(path.join(d, '.git'))) { found = d; break; } } catch (_) { /* unreadable */ }
    const up = path.dirname(d); if (up === d) break; d = up;
  }
  const r = found || cwd;
  rootCache.set(cwd, r);
  return r;
}
function keyOf(root) {
  return (path.basename(root) || 'project').replace(/[^\w.-]+/g, '_').slice(0, 40) + '-' + crypto.createHash('sha1').update(root).digest('hex').slice(0, 8);
}
function dir(home) { return path.join(home || os.homedir(), '.claude', 'crewmon', 'research'); }
function fileOf(key, home) { return path.join(dir(home), key.replace(/[^\w.-]/g, '') + '.json'); }
function artifactDir(key, home) { return path.join(dir(home), key.replace(/[^\w.-]/g, ''), 'artifacts'); }

function empty(root, name) {
  return { v: 1, key: keyOf(root), root, name: name || path.basename(root), tracked: true,
    questions: [], experiments: [], links: {}, artifacts: [], removed: [], agents: {}, ideas: {},
    created: Date.now(), syncedAt: 0, lastError: '' };
}
function load(key, home) { try { return JSON.parse(fs.readFileSync(fileOf(key, home), 'utf8')); } catch (_) { return null; } }
function save(r, home) {
  fs.mkdirSync(dir(home), { recursive: true });
  const f = fileOf(r.key, home), tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(r, null, 1));
  fs.renameSync(tmp, f);                  // atomic: a half-written file is never read
}
function all(home) {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(dir(home)).filter(n => n.endsWith('.json')); } catch (_) { return out; }
  for (const n of names) { const r = load(n.slice(0, -5), home); if (r && r.key) out[r.key] = r; }
  return out;
}

const qOf = (r, id) => r.questions.find(x => x.id === id);
const eOf = (r, id) => r.experiments.find(x => x.id === id);
const locked = (it, f) => Array.isArray(it.locked) && it.locked.includes(f);
const lock = (it, f) => { it.locked = [...new Set([...(it.locked || []), f])]; };
function names(list, max) {
  const out = [];
  for (const x of Array.isArray(list) ? list : typeof list === 'string' ? list.split(',') : []) {
    const n = clean(x, 40); if (n && !out.some(y => y.toLowerCase() === n.toLowerCase())) out.push(n);
  }
  return out.slice(0, max || 8);
}
function cleanMetrics(m) {
  const out = {};
  if (!m || typeof m !== 'object') return out;
  for (const [k, v] of Object.entries(m).slice(0, 12)) {
    const key = clean(k, 40).toLowerCase().replace(/[^\w./@-]+/g, '_');
    const num = typeof v === 'number' ? v : parseFloat(String(v).replace('%', ''));
    if (key && Number.isFinite(num)) out[key] = num;
  }
  return out;
}

// ---- your edits (from the panel) ----
function userEdit(r, op) {
  const it = op.kind === 'q' ? qOf(r, op.id) : op.kind === 'e' ? eOf(r, op.id) : null;
  switch (op.op) {
    case 'addQuestion': {
      const text = clean(op.text, 240);
      if (text) r.questions.push({ id: newId('q'), text, why: clean(op.why, 300), status: 'open', answer: '', src: 'you', at: Date.now(), locked: ['text'] });
      break;
    }
    case 'addExperiment': {
      const title = clean(op.title, 140);
      if (title) r.experiments.push({ id: newId('e'), q: qOf(r, op.q) ? op.q : '', title, why: clean(op.why, 300), expect: '', status: 'planned',
        result: '', verdict: '', next: '', data: [], models: [], metrics: {}, agents: [], src: 'you', at: Date.now(), updated: Date.now(), locked: ['title'] });
      break;
    }
    case 'set': {
      if (!it) break;
      const f = op.field, fields = op.kind === 'q' ? Q_FIELDS : E_FIELDS;
      if (!fields.includes(f)) break;
      if (f === 'data' || f === 'models') it[f] = names(op.value);
      else if (f === 'status') { if (!(op.kind === 'q' ? Q_STATUSES : STATUSES).includes(op.value)) break; it.status = op.value; }
      else if (f === 'verdict') { if (op.value && !VERDICTS.includes(op.value)) break; it.verdict = op.value || ''; it.vprobable = false; it.evidence = op.value ? 'set by you' : ''; }
      else if (f === 'q') { if (op.value && !qOf(r, op.value)) break; it.q = op.value || ''; }
      else { const v = clean(op.value, f === 'result' || f === 'answer' ? 400 : 300); if (!v && (f === 'text' || f === 'title')) break; it[f] = v; }
      lock(it, f); it.updated = Date.now();
      break;
    }
    case 'delete': {
      if (!it) break;
      r.removed.push(norm(op.kind === 'q' ? it.text : it.title)); r.removed = r.removed.slice(-300);
      if (op.kind === 'q') { r.questions = r.questions.filter(x => x !== it); for (const e of r.experiments) if (e.q === it.id) e.q = ''; }
      else { r.experiments = r.experiments.filter(x => x !== it); for (const [k, v] of Object.entries(r.links)) if (v.exp === it.id) delete r.links[k]; }
      break;
    }
    case 'link': {        // a run to an experiment ('' = unlink)
      if (!op.run) break;
      if (!op.exp) { r.links[op.run] = { exp: '', src: 'you' }; break; }
      if (eOf(r, op.exp)) r.links[op.run] = { exp: op.exp, src: 'you' };
      break;
    }
    case 'ideaToExperiment': {     // an idea from the memory becomes a planned experiment
      const title = clean(op.title, 140);
      if (!title || !op.name) break;
      const e = { id: newId('e'), q: qOf(r, op.q) ? op.q : '', title, why: clean(op.why, 300), expect: '', status: 'planned', result: '', verdict: '', next: '',
        data: [], models: [], metrics: {}, agents: [], src: 'you', at: Date.now(), updated: Date.now(), locked: ['title'], idea: op.name };
      r.experiments.push(e); r.ideas = Object.assign({}, r.ideas, { [op.name]: e.id });
      break;
    }
    case 'memKind': if (op.name && MEM_KINDS.includes(op.value)) r.memKinds = Object.assign({}, r.memKinds, { [op.name]: op.value }); break;
    case 'track': r.tracked = op.on !== false; break;
  }
  return r;
}

// ---- Haiku's proposed changes, applied under the rules ----
function applyOps(r, ops, agent, runIds) {
  const res = { added: 0, updated: 0, linked: 0, skipped: 0 };
  if (!Array.isArray(ops)) return res;
  const refs = {};                       // "q1"/"e1" in this reply -> real ids
  const maxAdds = r.questions.length + r.experiments.length ? MAX_ADDS : MAX_ADDS + 8;
  const now = Date.now();
  const resolveQ = (x) => x && (qOf(r, x) ? x : refs[x] && qOf(r, refs[x]) ? refs[x] : '');
  const resolveE = (x) => x && (eOf(r, x) ? x : refs[x] && eOf(r, refs[x]) ? refs[x] : '');
  const touch = (e) => { e.updated = now; if (agent && !e.agents.includes(agent)) e.agents.push(agent); };
  const fill = (e, o) => {             // fields Haiku may set on an experiment; your locked fields are left alone
    let n = 0;
    for (const f of ['why', 'expect']) if (o[f] && !e[f] && !locked(e, f)) { e[f] = clean(o[f], 300); n++; }   // reasons are written once: stable wording
    if (o.status && STATUSES.includes(o.status) && o.status !== e.status && !locked(e, 'status')) { e.status = o.status; n++; }
    if (o.result && !locked(e, 'result')) { const v = clean(o.result, 400); if (v !== e.result) { e.result = v; n++; } }
    if (o.next && !locked(e, 'next')) { e.next = clean(o.next, 240); n++; }
    for (const f of ['data', 'models']) if (o[f] && !locked(e, f)) { const m = names([...(e[f] || []), ...names(o[f])]); if (m.length !== (e[f] || []).length) { e[f] = m; n++; } }
    const met = cleanMetrics(o.metrics);
    if (Object.keys(met).length) { e.metrics = Object.assign({}, e.metrics || {}, met); const ks = Object.keys(e.metrics); for (const k of ks.slice(0, Math.max(0, ks.length - 12))) delete e.metrics[k]; n++; }
    if (o.verdict && VERDICTS.includes(o.verdict) && !locked(e, 'verdict') && o.verdict !== e.verdict) {
      e.verdict = o.verdict; e.evidence = clean(o.evidence, 140); e.vprobable = !e.evidence; n++;
    }
    return n;
  };
  for (const o of ops.slice(0, 40)) {
    if (!o || typeof o !== 'object') { res.skipped++; continue; }
    if (o.op === 'question') {
      const text = clean(o.text, 240);
      if (!text || r.removed.includes(norm(text))) { res.skipped++; continue; }
      const dup = r.questions.find(x => similar(x.text, text) >= SAME_Q);
      if (dup) { if (o.ref) refs[o.ref] = dup.id; if (o.why && !dup.why && !locked(dup, 'why')) { dup.why = clean(o.why, 300); res.updated++; } else res.skipped++; continue; }
      if (res.added >= maxAdds) { res.skipped++; continue; }
      const q = { id: newId('q'), text, why: clean(o.why, 300), status: 'open', answer: '', src: 'auto', from: agent || '', at: now };
      r.questions.push(q); if (o.ref) refs[o.ref] = q.id; res.added++;
    } else if (o.op === 'experiment') {
      const title = clean(o.title, 140);
      if (!title || r.removed.includes(norm(title))) { res.skipped++; continue; }
      const q = resolveQ(o.q);
      const dup = r.experiments.find(x => similar(x.title, title) >= SAME_E && (!q || !x.q || x.q === q));
      if (dup) {
        if (o.ref) refs[o.ref] = dup.id;
        if (q && !dup.q && !locked(dup, 'q')) dup.q = q;
        const n = fill(dup, o); if (n) { touch(dup); res.updated++; } else res.skipped++;
        continue;
      }
      if (res.added >= maxAdds) { res.skipped++; continue; }
      const e = { id: newId('e'), q, title, why: '', expect: '', status: STATUSES.includes(o.status) ? o.status : 'planned', result: '', verdict: '', next: '',
        data: [], models: [], metrics: {}, agents: [], src: 'auto', from: agent || '', at: now, updated: now };
      fill(e, Object.assign({}, o, { status: undefined })); touch(e);
      r.experiments.push(e); if (o.ref) refs[o.ref] = e.id; res.added++;
    } else if (o.op === 'update') {
      const e = eOf(r, resolveE(o.id));
      if (!e) { res.skipped++; continue; }
      if (o.q && !locked(e, 'q')) { const q = resolveQ(o.q); if (q) e.q = q; }
      const n = fill(e, o); if (n) { touch(e); res.updated++; } else res.skipped++;
    } else if (o.op === 'answer') {
      const q = qOf(r, resolveQ(o.id));
      if (!q) { res.skipped++; continue; }
      let n = 0;
      if (o.status && Q_STATUSES.includes(o.status) && !locked(q, 'status') && o.status !== q.status) { q.status = o.status; n++; }
      if (o.answer && !locked(q, 'answer')) { q.answer = clean(o.answer, 400); q.evidence = clean(o.evidence, 140); q.aprobable = !q.evidence; n++; }
      if (n) res.updated++; else res.skipped++;
    } else if (o.op === 'link') {
      const run = runIds && runIds[o.run] ? runIds[o.run] : o.run, exp = resolveE(o.exp);
      const cur = r.links[run];
      if (!run || !exp || (runIds && !Object.values(runIds).includes(run)) || (cur && cur.src === 'you')) { res.skipped++; continue; }
      r.links[run] = { exp, src: 'auto' }; const e = eOf(r, exp); touch(e); res.linked++;
    } else res.skipped++;
  }
  return res;
}

// ---- runs: commands that launch experiments, found by fixed rules ----
const SKIP_WORDS = new Set(['cat', 'sed', 'grep', 'egrep', 'rg', 'head', 'tail', 'ls', 'echo', 'printf', 'less', 'more', 'wc', 'cut', 'awk', 'mkdir', 'cd',
  'git', 'rm', 'cp', 'mv', 'ln', 'find', 'ps', 'pgrep', 'pkill', 'kill', 'killall', 'curl', 'wget', 'du', 'df', 'sort', 'uniq', 'tr', 'test', '[', '[[',
  'for', 'while', 'if', 'then', 'else', 'fi', 'do', 'done', 'case', 'esac', 'diff', 'cmp', 'tee', 'xargs', 'chmod', 'touch', 'open', 'export', 'source', '.',
  'set', 'unset', 'read', 'sleep', 'wait', 'date', 'uptime', 'which', 'type', 'jq', 'zip', 'unzip', 'tar', 'shasum', 'md5', 'pip', 'pip3', 'brew', 'npm',
  'node', 'npx', 'code', 'ruff', 'black', 'mypy', 'pytest', 'true', 'false', 'basename', 'dirname', 'realpath', 'stat', 'file', 'sysctl', 'pmset', 'top']);
const NOT_RUN_MODULES = /^(pytest|pip|venv|http\.server|json\.tool|ruff|black|mypy|unittest|compileall|py_compile|ensurepip|site|timeit|cProfile|pydoc|doctest|tabnanny|zipfile|tarfile|webbrowser)$/;
const RUN_WORD = /^(run|train|sweep|fit|pretrain|finetune|fine-tune|evaluate|eval|experiment|launch|benchmark|bench|ablate|ablation)$/i;
const RUN_NAME = /(^|[\/_.-])(train|training|trainer|run|runs|runner|sweep|experiments?|exp|pretrain|finetune|fine_tune|eval|evaluate|bench|benchmark|ablations?|queue|grid|launch|fit|study)([\/_.-]|\d|$)/i;
const CONFIG = /^(?!-)\S*(\.(ya?ml|toml|cfg|gin)|config\S*\.json)$/i;   // a config file argument (an output .json is not one)
const WRAPPERS = new Set(['nohup', 'setsid', 'time', 'exec', 'command', 'builtin', 'disown']);

function words(seg) { return (seg.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(w => w.replace(/^["']|["']$/g, '')); }
function unwrap(w) {     // drop env assignments and wrappers such as nice -n 10, nohup, caffeinate -i, timeout 3600
  let i = 0;
  for (let guard = 0; guard < 20 && i < w.length; guard++) {
    const x = w[i];
    if (/^[A-Za-z_]\w*=/.test(x)) { i++; continue; }
    if (x === '(' || x === '{') { i++; continue; }
    if (WRAPPERS.has(x)) { i++; continue; }
    if (x === 'env') { i++; while (i < w.length && (/^[A-Za-z_]\w*=/.test(w[i]) || /^-/.test(w[i]))) i++; continue; }
    if (x === 'nice') { i++; if (w[i] === '-n') i += 2; else if (/^-\d+$/.test(w[i] || '')) i++; continue; }
    if (x === 'caffeinate' || x === 'stdbuf') { i++; while (i < w.length && /^-/.test(w[i])) i++; continue; }
    if (x === 'timeout' || x === 'gtimeout') { i++; while (i < w.length && /^-/.test(w[i])) i++; i++; continue; }
    break;
  }
  return w.slice(i).map(x => x.replace(/^\(+/, '')).filter(Boolean);
}
// Is this argument list (one simple command) a launch? Returns {kind, script} or null.
function launchOf(argv) {
  let w = argv.slice();
  if (!w.length) return null;
  let first = w[0], base = path.basename(first);
  if (SKIP_WORDS.has(base)) return null;
  if (['uv', 'poetry', 'pipenv', 'pixi', 'hatch', 'pdm', 'rye'].includes(base) && w[1] === 'run') {
    w = w.slice(2); while (w.length && /^-/.test(w[0])) { const f = w.shift(); if (/^--?(with|env|e|n|p|python|group|extra|project|directory)$/.test(f)) w.shift(); }
  } else if (base === 'conda' && w[1] === 'run') {
    w = w.slice(2); while (w.length && /^-/.test(w[0])) { const f = w.shift(); if (/^(-n|--name|-p|--prefix)$/.test(f)) w.shift(); }
  }
  if (!w.length) return null;
  first = w[0]; base = path.basename(first);
  if (SKIP_WORDS.has(base)) return null;
  if (w.some(x => /[*\\()`]/.test(x) && /\.(sh|py)\b/.test(x))) return null;     // a pattern (pkill -f 'queue/.*\.sh') or a fragment of $(…), not a script
  const scriptIn = (a) => a.find(x => /\.(py|sh)$/.test(x)) || a.find(x => !/^-/.test(x) && !/^\d+$/.test(x)) || '';
  if (/^(torchrun|deepspeed|horovodrun|mpirun|sbatch|srun|qsub|bsub)$/.test(base)) return { kind: base, script: scriptIn(w.slice(1)) };
  if (base === 'accelerate' && w[1] === 'launch') return { kind: 'accelerate', script: scriptIn(w.slice(2)) };
  if (/^(python[\d.]*|pypy3?)$/.test(base)) {
    const rest = w.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '-c' || a === '-') return null;           // inline code, not a run
      if (a === '-m') {
        const mod = rest[i + 1] || '';
        if (!mod || NOT_RUN_MODULES.test(mod.split('.')[0]) || NOT_RUN_MODULES.test(mod)) return null;
        const after = rest.slice(i + 2);
        if (RUN_NAME.test(mod.replace(/\./g, '/')) || after.some(x => RUN_WORD.test(x)) || after.some(x => CONFIG.test(x)) || after.some(x => /^--config/.test(x))) return { kind: 'python', script: '-m ' + mod + (after[0] && RUN_WORD.test(after[0]) ? ' ' + after[0] : '') };
        return null;
      }
      if (/^-/.test(a)) continue;
      if (/\.py$/.test(a)) {
        const after = rest.slice(i + 1);
        if (RUN_NAME.test(path.basename(a, '.py')) || RUN_NAME.test(a) && /experiments?\//.test(a) || after.some(x => CONFIG.test(x) || /^--config/.test(x))) return { kind: 'python', script: a };
        return null;
      }
      return null;
    }
    return null;
  }
  if (/^(bash|sh|zsh)$/.test(base)) {
    const rest = w.slice(1);
    if (rest.some(x => x === '-n' || x === '-c')) return null;
    const s = rest.find(x => !/^-/.test(x));
    return s && /\.(sh|bash)$/.test(s) && RUN_NAME.test(s) ? { kind: 'script', script: s } : null;
  }
  if (/\.(sh|bash)$/.test(first)) return RUN_NAME.test(first) ? { kind: 'script', script: first } : null;
  if (base === 'make') { const t = w.slice(1).find(x => !/^-/.test(x) && !x.includes('=')); return t && RUN_NAME.test(t) ? { kind: 'make', script: 'make ' + t } : null; }
  // a project's own command line: <tool> run|train … <config file>
  const k = w.findIndex((x, i) => i > 0 && RUN_WORD.test(x));
  if (k > 0 && k <= 2 && w.slice(k + 1).some(x => CONFIG.test(x) || /^--config/.test(x))) return { kind: 'cli', script: base + ' ' + w[k] };
  return null;
}
// Split a shell command into simple commands, following cd and NAME=value so paths can be resolved.
function launches(cmd, cwd) {
  const body = String(cmd || '').replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, ' ');   // heredoc bodies are data, not commands
  const vars = {}; let dirNow = cwd || '';
  const loops = {};
  const out = [];
  const segs = body.split(/\n|;|&&|\|\||\|/);
  const sub = (s) => s.replace(/\$\{?(\w+)\}?/g, (m, v) => vars[v] != null ? vars[v] : m);
  for (let raw of segs) {
    const seg = raw.trim();
    if (!seg) continue;
    const loop = /^for\s+(\w+)\s+in\s+(.+?)(\s+do\b.*)?$/.exec(seg);
    if (loop) { loops[loop[1]] = words(loop[2]).filter(x => x !== 'do'); continue; }
    const asg = /^(?:export\s+)?([A-Za-z_]\w*)=("[^"]*"|'[^']*'|\S*)$/.exec(seg);
    if (asg) { vars[asg[1]] = sub(asg[2].replace(/^["']|["']$/g, '')); continue; }
    const w = unwrap(words(seg.replace(/^do\s+/, '')));
    if (w[0] === 'cd' && w[1]) { dirNow = path.resolve(dirNow || '/', sub(w[1]).replace(/^~(?=\/|$)/, os.homedir())); continue; }
    const l = launchOf(w);
    if (!l) continue;
    const text = sub(seg);
    const tw = words(text), cfgs = tw.filter((x, i) => CONFIG.test(x) || (/^--config$/.test(tw[i - 1] || '') && /\.\w+$/.test(x)));
    for (const x of tw) { const c = /^--config=(\S+)/.exec(x); if (c) cfgs.push(c[1]); }
    let configs = cfgs.map(c => {
      const v = /\$\{?(\w+)\}?/.exec(c);
      if (v && loops[v[1]]) return loops[v[1]].map(x => path.basename(c.replace(v[0], x)).replace(/\.\w+$/, ''));
      return [path.basename(c).replace(/\.\w+$/, '')];
    }).flat();
    configs = [...new Set(configs)].slice(0, 12);
    const seedM = /--seed[= ](\d+)|\bseed=(\d+)|SEEDS?=["']?([\d ]+)/.exec(text) || /\bSEEDS?=["']?([\d ]+)/.exec(sub(body));
    const nameM = /(?:--set\s+|--)(?:run\.)?name[= ](\S+)|--run[-_]name[= ](\S+)|--exp(?:eriment)?[-_]?name[= ](\S+)/.exec(text);
    const logM = /(?:^|\s)(?:>>?|&>|1>)\s*(\S+)/.exec(text);
    const log = logM && !/^\/dev\//.test(logM[1]) && !/^&/.test(logM[1]) ? path.resolve(dirNow || '/', logM[1].replace(/^~(?=\/|$)/, os.homedir())) : '';
    out.push({ kind: l.kind, script: clean(sub(l.script), 120), configs, seed: seedM ? clean((seedM[1] || seedM[2] || seedM[3] || '').trim(), 20) : '',
      name: nameM ? clean(nameM[1] || nameM[2] || nameM[3], 60) : '', smoke: /--smoke\b|smoke=true|\bsmoke\b/i.test(text), log,
      detached: /\bnohup\b|\bsetsid\b|\bdisown\b/.test(raw) || /(^|[^&>])&(?!&)/.test(raw), cwd: dirNow });
  }
  return out;
}

// ---- metrics in a run's output ----
const METRIC = /(?:^|[\s,{(|"'\[])((?:val|valid|validation|test|train|eval|dev)[_\/ -]?)?(acc(?:uracy)?|bal(?:anced)?[_ ]acc(?:uracy)?|macro[_ -]?f1|f1(?:[_ -](?:macro|weighted|micro))?|weighted[_ -]f1|auroc|auc|loss|mae|rmse|mse|r2|precision|recall|kappa|miou|iou|map|bleu|rouge[-_]?\w*|perplexity|ppl|wer|cer|top[-_]?[15](?:[_ ]acc)?)["']?\s*[:=]\s*(-?\d+(?:\.\d+)?(?:e-?\d+)?)(%?)/gi;
function metrics(text) {
  const found = new Map();
  if (!text) return { metrics: {}, epoch: '' };
  let m; METRIC.lastIndex = 0;
  const t = String(text).slice(-200000);
  while ((m = METRIC.exec(t))) {
    const key = ((m[1] || '').replace(/[\/ -]/g, '_').replace(/_?$/, m[1] ? '_' : '') + m[2]).toLowerCase().replace(/[ -]/g, '_');
    const v = parseFloat(m[3]); if (!Number.isFinite(v)) continue;
    found.delete(key); found.set(key, m[4] === '%' ? v / 100 : v);   // newest last
  }
  const keys = [...found.keys()].slice(-8);
  const out = {}; for (const k of keys) out[k] = found.get(k);
  const ep = [...t.matchAll(/\bepoch\s*[:=]?\s*(\d+)(?:\s*\/\s*(\d+))?/gi)].pop();
  return { metrics: out, epoch: ep ? ep[1] + (ep[2] ? '/' + ep[2] : '') : '' };
}
function tailOf(file, bytes) {
  try {
    const st = fs.statSync(file); if (!st.isFile()) return null;
    const n = Math.min(st.size, bytes || 65536), fd = fs.openSync(file, 'r'), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, st.size - n); fs.closeSync(fd);
    return { text: buf.toString('utf8'), mtime: st.mtimeMs };
  } catch (_) { return null; }
}
const lastLine = (t) => clean(String(t || '').split('\n').map(x => x.replace(/\x1b\[[\d;]*m/g, '').trim()).filter(Boolean).pop() || '', 160);

// All runs in one chat, newest first: [{id, use, title, kind, script, configs, seed, name, smoke, status, started, ended, metrics, epoch, last, log}]
function runs(file, opts) {
  const o = opts || {};
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - (o.bytes || 24 * 1024 * 1024));
  const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(st.size - start); fs.readSync(fd, buf, 0, buf.length, start); fs.closeSync(fd);
  let text = buf.toString('utf8'); if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  const byUse = new Map(), byTask = new Map();
  const read = o.readFile || tailOf;
  const finish = (x, status, at, summary) => {
    if (!x || !(x.status === 'running' || x.status === 'starting')) return;
    x.status = status; x.ended = at;
    const s = clean(String(summary || '').replace(/^(Background command|Command)\s+"[^"]*"\s*/i, ''), 200); if (s) x.last = s;
  };
  for (const line of text.split('\n')) {
    if (!line.includes('"Bash"') && !line.includes('tool_result') && !line.includes('task-notification')) continue;
    let r; try { r = JSON.parse(line); } catch (_) { continue; }
    const at = r.timestamp ? Date.parse(r.timestamp) : 0, c = r.message && r.message.content;
    const blocks = Array.isArray(c) ? c : typeof c === 'string' ? [{ type: 'text', text: c }] : [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'tool_use' && b.name === 'Bash') {
        const i = b.input || {};
        const ls = launches(i.command, r.cwd);
        if (!ls.length) continue;
        const l = ls[0], configs = [...new Set(ls.flatMap(x => x.configs))].slice(0, 12);
        byUse.set(b.id, { id: 'r' + String(b.id).slice(-6), use: b.id, title: clean(i.description, 110), kind: l.kind, script: l.script, configs,
          seed: ls.map(x => x.seed).find(Boolean) || '', name: ls.map(x => x.name).find(Boolean) || '', smoke: ls.every(x => x.smoke), log: (ls.find(x => x.log) || {}).log || '',
          detached: ls.some(x => x.detached) && !i.run_in_background, background: !!i.run_in_background, status: 'starting', started: at, ended: 0, out: '', cmd: clean(i.command, 300) });
      } else if (b.type === 'tool_result') {
        const x = byUse.get(b.tool_use_id);
        const t = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map(y => (y && y.text) || '').join('\n') : '';
        if (x && x.status === 'starting') {
          const id = /background with ID: (\w+)/.exec(t);
          const of = /Output is being written to: (\S+?)\.?(?:\s|$)/.exec(t);
          if (id) { x.task = id[1]; byTask.set(x.task, x); x.status = 'running'; if (of) x.out = of[1]; }
          else if (x.detached) { x.status = 'detached'; x.output = t; }
          else if (b.is_error || /^Exit code [1-9]/m.test(t)) { x.status = /timed out|interrupted|^Exit code (130|137|143|144)\b/im.test(t) ? 'stopped' : 'failed'; x.ended = at; x.output = t; x.last = lastLine(t); }
          else { x.status = 'completed'; x.ended = at; x.output = t; x.last = lastLine(t); }
        }
        const stop = /Successfully stopped task: (\w+)/.exec(t);
        if (stop) finish(byTask.get(stop[1]), 'stopped', at, 'stopped');
      } else if (b.type === 'text' && b.text && b.text.includes('<task-notification>')) {
        for (const n of b.text.split('<task-notification>').slice(1)) {
          const g = (tag) => { const y = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>').exec(n); return y ? y[1].trim() : ''; };
          const x = byUse.get(g('tool-use-id')) || byTask.get(g('task-id'));
          if (!x) continue;
          if (g('output-file') && !x.out) x.out = g('output-file');
          const s = g('status');
          if (s) finish(x, s === 'completed' ? 'completed' : s === 'failed' && !/exit code (130|137|143|144)\b/i.test(g('summary')) ? 'failed' : s === 'failed' ? 'stopped' : 'stopped', at, g('summary'));
        }
      }
    }
  }
  const now = o.now || Date.now();
  const list = [...byUse.values()].sort((a, b) => b.started - a.started).slice(0, o.max || 40);
  for (const x of list) {
    let src = x.output || '';
    let best = null;                            // the run's own output, when it is still on disk: whichever says more
    for (const f of [x.out, x.log]) { const t = f ? read(f, 65536) : null; if (t && (!best || t.text.trim().length > best.text.trim().length)) best = t; }
    if (best && best.text.trim()) { src = best.text; x.logAt = best.mtime; }
    else if (best) x.logAt = best.mtime;
    const m = metrics(src);
    x.metrics = m.metrics; x.epoch = m.epoch;
    if (!x.last || x.status === 'running' || x.status === 'detached') x.last = lastLine(src) || x.last || '';
    if (x.status === 'detached') x.status = x.logAt && now - x.logAt < 5 * 60e3 ? 'running' : x.logAt ? 'unknown' : 'detached';
    if (x.status === 'starting') x.status = o.offline ? 'unknown' : 'running';
    if (o.offline && x.status === 'running' && x.background) x.status = 'unknown';
    delete x.output;
  }
  return list;
}

// ---- what Haiku reads: the research-relevant turns since byte `from` ----
const SUMMARY_PARTS = /(Primary Request and Intent|Key Technical Concepts|Problem Solving|Pending Tasks|Current Work|Optional Next Step)[^\n]*\n([\s\S]*?)(?=\n\s*\d+\.\s+\*{0,2}[A-Z]|$)/g;
function textOf(m) {
  const c = m && m.content;
  return (typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x && x.type === 'text').map(x => x.text).join(' ') : '').replace(/\s+/g, ' ').trim();
}
function excerpt(file, from) {
  const st = fs.statSync(file);
  const start = Math.max(0, Math.min(from || 0, st.size), st.size - 6 * 1024 * 1024);
  const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(st.size - start); fs.readSync(fd, buf, 0, buf.length, start); fs.closeSync(fd);
  let text = buf.toString('utf8');
  if (start > 0 && start !== from) text = text.slice(text.indexOf('\n') + 1);
  const out = [], asks = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch (_) { continue; }
    const m = r.message, c = m && m.content;
    if (r.type === 'user' && m && m.role === 'user') {
      if (Array.isArray(c)) for (const b of c) if (b && b.type === 'tool_result' && asks.has(b.tool_use_id)) {
        const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
        out.push('PERSON ANSWERED ' + clean(t.replace(/^User has answered your questions?:?/i, ''), 500));
      }
      const t = textOf(m);
      const nt = /<task-notification>[\s\S]*?<status>(\w+)<\/status>[\s\S]*?<summary>([\s\S]*?)<\/summary>/.exec(t);
      if (nt) { out.push('FINISHED (' + nt[1] + ') ' + clean(nt[2], 240)); continue; }
      if (/^(This session is being continued|.{0,40}Primary Request and Intent)/.test(t)) {
        const parts = []; let p; SUMMARY_PARTS.lastIndex = 0;
        const raw = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(x => x && x.type === 'text').map(x => x.text).join('\n') : '');
        while ((p = SUMMARY_PARTS.exec(raw)) && parts.length < 6) parts.push(p[1] + ': ' + clean(p[2], 1500));
        if (parts.length) out.push('SUMMARY OF EARLIER WORK ' + parts.join(' || '));
      } else if (t && !/^(Base directory for this skill|<|\[Request interrupted|Caveat:)/.test(t)) out.push('PERSON ' + clean(t, 700));
    } else if (r.type === 'assistant' && m) {
      const t = textOf(m);
      if (t) out.push('AGENT ' + clean(t, 1000));
      if (Array.isArray(c)) for (const b of c) if (b && b.type === 'tool_use') {
        const i = b.input || {};
        if (b.name === 'Bash') {
          const ls = launches(i.command, r.cwd);
          if (ls.length) out.push('RUN [r' + String(b.id).slice(-6) + '] ' + clean(i.description, 100) + ' | ' + clean([ls[0].script, ls.flatMap(x => x.configs).slice(0, 6).join(','), ls[0].seed ? 'seed ' + ls[0].seed : '', ls.every(x => x.smoke) ? 'smoke test' : ''].filter(Boolean).join(' · '), 200));
          else { const cm = /git commit[^\n]*?-m\s+["']([^"']{3,160})/.exec(String(i.command || '')); if (cm) out.push('COMMIT ' + clean(cm[1], 140)); }
        } else if (b.name === 'AskUserQuestion') { asks.add(b.id); out.push('ASKED THE PERSON ' + clean((i.questions || []).map(q => q.question).join(' | '), 300)); }
        else if (b.name === 'ExitPlanMode') out.push('PLAN ' + clean(i.plan, 900));
        else if (/^(Write|Edit)$/.test(b.name) && /\/memory\/[^/]+\.md$/.test(String(i.file_path || '')) && !/MEMORY\.md$/.test(String(i.file_path))) out.push('SAVED TO MEMORY ' + path.basename(String(i.file_path), '.md') + ': ' + clean(frontMatter(String(i.content || i.new_string || '')).meta.description || i.content || i.new_string, 200));
        else if (b.name === 'Write' && /\.(md|ya?ml|json|toml)$/i.test(String(i.file_path || ''))) out.push('WROTE ' + path.basename(String(i.file_path)));
      }
    }
  }
  let budget = EXCERPT_CHARS; const kept = [];
  for (let i = out.length - 1; i >= 0 && budget > 0; i--) { kept.unshift(out[i]); budget -= out[i].length + 1; }
  return { text: kept.join('\n'), end: st.size, lines: out.length };
}

// ---- the Haiku request ----
function prompt(r, ex, agentTitle, runList, memory) {
  const qs = r.questions.map(q => ({ id: q.id, text: q.text, why: q.why || undefined, status: q.status, answer: q.answer || undefined, locked: q.locked && q.locked.length ? q.locked : undefined }));
  const es = r.experiments.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, 50).map((e, i) => i < 30
    ? { id: e.id, q: e.q || undefined, title: e.title, status: e.status, why: e.why || undefined, result: e.result || undefined, verdict: e.verdict || undefined, locked: e.locked && e.locked.length ? e.locked : undefined }
    : { id: e.id, title: e.title, status: e.status });
  const rs = (runList || []).filter(x => !r.links[x.use]).slice(0, 20).map(x => ({ id: x.id, what: x.title, configs: x.configs.join(',') || undefined, seed: x.seed || undefined, status: x.status, smoke: x.smoke || undefined }));
  return [
    'You keep a research log for a person who supervises Claude Code agents doing research in the project "' + r.name + '". The agents do not know about the log.',
    'QUESTIONS are research questions the work tries to answer. EXPERIMENTS are concrete things tried to answer one (a training run, an ablation, an evaluation, an analysis), each with why it was done, what was expected, the data and models it uses, its status and its result. RUNS are commands that were detected launching experiments.',
    'Read the log and what happened since the last update in the chat of the agent "' + agentTitle + '", then reply with ONLY a JSON object {"ops":[...]} with at most 15 ops:',
    '  {"op":"question","ref":"q1","text":"...?","why":"..."}   a research question, at most 20 words, ending with ?; why = why it matters, one sentence',
    '  {"op":"experiment","ref":"e1","q":"<question id or ref>","title":"...","why":"...","expect":"...","data":["..."],"models":["..."],"status":"planned|running|done|failed|stopped|dropped"}   title at most 10 words; why = the reason it was done; expect = the hypothesis or expected outcome, if stated',
    '  {"op":"update","id":"<experiment id or ref>","status":"...","result":"...","metrics":{"name":0.81},"verdict":"supports|refutes|unclear","evidence":"...","next":"...","data":[],"models":[]}   only the fields that changed',
    '  {"op":"answer","id":"<question id>","status":"answered|dropped|open","answer":"...","evidence":"..."}',
    '  {"op":"link","run":"<run id>","exp":"<experiment id or ref>"}   a detected run belongs to this experiment',
    'Rules:',
    '- Only what the chat shows. Never invent numbers: copy metrics exactly as reported; put the dataset or split in the metric name when given (e.g. "dsads_macro_f1").',
    '- result = what came out, with its numbers, at most 30 words. verdict = whether the result supports the hypothesis; evidence = at most 12 words (a run, a table, the agent\'s report).',
    '- verdict is unclear while results are interim, from one seed only, or smaller than a margin the person or agent set; supports or refutes only when the agent or person concluded so.',
    '- Planned work that the person or the agent agreed to do is an experiment with status planned. Loose ideas: skip.',
    '- Engineering work (fixing bugs, refactoring, docs, installing, downloading) is not an experiment, unless it changes results: then update the affected experiments (e.g. a data bug invalidates runs: status failed, result says why).',
    '- Smoke tests only check that code runs: never an experiment of their own.',
    '- Prefer updating existing items over adding; never add an item already in the log in other words. Fields listed in "locked" are the person\'s: leave them.',
    '- If nothing research-related happened, reply {"ops":[]}.',
    '',
    memory && memory.length ? 'PROJECT MEMORY (rules, ideas and notes the agents load; context only: do not copy them into the log, and an idea here is not an experiment until it is agreed) ' + JSON.stringify(memory.slice(0, 40).map(m => m.kind + ': ' + (m.description || m.name)).map(t => t.slice(0, 160))) : '',
    'LOG ' + JSON.stringify({ questions: qs, experiments: es }),
    'RUNS NOT YET LINKED ' + JSON.stringify(rs),
    '',
    'SINCE THE LAST UPDATE (PERSON = the person, AGENT = the agent, RUN = a detected run, other lines = its actions):',
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

// Should this agent's chat be read now for this project? New turns, idle (or forced), and not too soon.
function due(r, s, now) {
  if (!r || !r.tracked || !s || !s.file || s.state === 'busy') return false;
  const a = r.agents[s.id] || {};
  if ((s.size || 0) <= (a.syncedSize || 0) + 200) return false;
  return (now || Date.now()) - (a.lastTry || 0) >= MIN_GAP_MS;
}

// ---- artifacts: made on request, from the log only ----
const LOWER_BETTER = /(^|_)(loss|mae|rmse|mse|wer|cer|ppl|perplexity|error|err)$/;
const better = (k, a, b) => LOWER_BETTER.test(k) ? a < b : a > b;
function bestOf(e, runList, links) {          // an experiment's numbers: its own reported metrics, else the best of its runs
  const m = Object.assign({}, e.metrics || {});
  for (const x of runList || []) if (links[x.use] && links[x.use].exp === e.id && !x.smoke) for (const [k, v] of Object.entries(x.metrics || {})) if (!(k in m) || better(k, v, m[k])) m[k] = v;
  return m;
}
const fmt = (v) => Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(3) : v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
function metricKeys(r, runList, exps) {
  const n = {};
  for (const e of exps || r.experiments) for (const k of Object.keys(bestOf(e, runList, r.links))) n[k] = (n[k] || 0) + 1;
  return Object.entries(n).sort((a, b) => b[1] - a[1]).map(x => x[0]);
}
const md = (t) => String(t || '').replace(/\|/g, '\\|');
function tableMarkdown(r, runList, qid) {
  const qs = qid ? r.questions.filter(q => q.id === qid) : r.questions.concat([{ id: '', text: 'Not tied to a question' }]);
  const out = ['# ' + r.name + ': results', '', '_Research Companion, ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + '. From the agents\' chats; check numbers against the runs before citing them._'];
  for (const q of qs) {
    const exps = r.experiments.filter(e => (e.q || '') === q.id);
    if (!exps.length) continue;
    const keys = metricKeys(r, runList, exps).slice(0, 6);
    out.push('', '## ' + q.text, '', '| Experiment | Status | Data | Models | ' + keys.map(md).join(' | ') + (keys.length ? ' | ' : '') + 'Result | Verdict |',
      '|---|---|---|---|' + keys.map(() => '---:|').join('') + '---|---|');
    for (const e of exps) {
      const m = bestOf(e, runList, r.links);
      const best = keys.map(k => { const v = m[k]; if (v == null) return ''; const vals = exps.map(o => bestOf(o, runList, r.links)[k]).filter(w => w != null); const top = vals.length > 1 && vals.every(w => !better(k, w, v)); return top ? '**' + fmt(v) + '**' : fmt(v); });
      out.push('| ' + [md(e.title), e.status, md((e.data || []).join(', ')), md((e.models || []).join(', '))].concat(best, [md(e.result), e.verdict ? e.verdict + (e.vprobable ? ' (probably)' : '') : '']).join(' | ') + ' |');
    }
  }
  return out.join('\n') + '\n';
}
function notesMarkdown(r, runList, memory) {
  const out = ['# ' + r.name + ': research notes', '', '_Research Companion, ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + '. Drawn from the agents\' chats; items marked (you) were written by you._'];
  const qs = r.questions.concat([{ id: '', text: 'Experiments not tied to a question', status: '' }]);
  for (const q of qs) {
    const exps = r.experiments.filter(e => (e.q || '') === q.id);
    if (!q.id && !exps.length) continue;
    out.push('', '## ' + q.text + (q.status ? '  [' + q.status + ']' : '') + (q.src === 'you' ? ' (you)' : ''));
    if (q.why) out.push('', '**Why it matters:** ' + q.why);
    if (q.answer) out.push('', '**Answer so far:** ' + q.answer + (q.aprobable ? ' (probably)' : ''));
    for (const e of exps) {
      out.push('', '### ' + e.title + '  [' + e.status + ']');
      if (e.why) out.push('- **Why:** ' + e.why);
      if (e.expect) out.push('- **Expected:** ' + e.expect);
      if ((e.data || []).length) out.push('- **Data:** ' + e.data.join(', '));
      if ((e.models || []).length) out.push('- **Models:** ' + e.models.join(', '));
      if (e.result) out.push('- **Result:** ' + e.result);
      const m = bestOf(e, runList, r.links); if (Object.keys(m).length) out.push('- **Numbers:** ' + Object.entries(m).map(([k, v]) => k + ' ' + fmt(v)).join(', '));
      if (e.verdict) out.push('- **Verdict:** ' + e.verdict + (e.evidence ? ' (' + e.evidence + ')' : '') + (e.vprobable ? ' (probably)' : ''));
      if (e.next) out.push('- **Next:** ' + e.next);
      const rl = (runList || []).filter(x => r.links[x.use] && r.links[x.use].exp === e.id);
      if (rl.length) out.push('- **Runs:** ' + rl.map(x => (x.name || x.configs.join(',') || x.script) + (x.seed ? ' seed ' + x.seed : '') + ' (' + x.status + ', ' + new Date(x.started).toISOString().slice(0, 10) + ')').join('; '));
    }
  }
  for (const [k, title] of [['behavior', 'Behaviors (rules for the agents)'], ['idea', 'Ideas'], ['run', 'Runs recorded by hand'], ['note', 'Notes']]) {
    const ms = (memory || []).filter(m => m.kind === k);
    if (ms.length) out.push('', '## ' + title + ' (from the project memory)', '', ...ms.map(m => '- ' + (m.description || m.name) + '  (' + new Date(m.at || m.mtime).toISOString().slice(0, 10) + ')'));
  }
  return out.join('\n') + '\n';
}
function chartSVG(r, runList, metric, qid) {
  const exps = r.experiments.filter(e => !qid || e.q === qid).map(e => ({ e, v: bestOf(e, runList, r.links)[metric] })).filter(x => x.v != null);
  exps.sort((a, b) => better(metric, a.v, b.v) ? -1 : 1);
  const W = 720, row = 26, top = 56, left = 260, H = top + exps.length * row + 40;
  const max = Math.max(...exps.map(x => Math.abs(x.v)), 1e-9);
  const escx = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const title = (qid && qOf(r, qid) ? qOf(r, qid).text : r.name) + ' · ' + metric + (LOWER_BETTER.test(metric) ? ' (lower is better)' : '');
  const bars = exps.map((x, i) => {
    const w = Math.max(2, Math.round((W - left - 90) * Math.abs(x.v) / max)), y = top + i * row;
    const col = i === 0 ? '#2F7D5B' : '#5B7FA6';
    return '<text x="' + (left - 10) + '" y="' + (y + 16) + '" text-anchor="end" font-size="12" fill="#222">' + escx(x.e.title.slice(0, 40)) + '</text>' +
      '<rect x="' + left + '" y="' + (y + 4) + '" width="' + w + '" height="16" rx="2" fill="' + col + '"/>' +
      '<text x="' + (left + w + 6) + '" y="' + (y + 16) + '" font-size="12" fill="#222">' + fmt(x.v) + '</text>';
  }).join('');
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" font-family="-apple-system, Segoe UI, sans-serif">' +
    '<rect width="100%" height="100%" fill="#fff"/><text x="16" y="28" font-size="15" font-weight="600" fill="#111">' + escx(title.slice(0, 90)) + '</text>' +
    '<text x="16" y="44" font-size="11" fill="#666">Best value per experiment, from the agents\' chats (Research Companion)</text>' + bars + '</svg>';
}
function writeupPrompt(r, runList, qid, memory) {
  return 'Write a short research summary in Markdown for the person who runs this project, from the notes below ONLY. ' +
    'Sections: "What we asked", "What we tried and why", "What we found", "Open ends". Use only facts and numbers that appear in the notes; ' +
    'where a number is needed but missing, write [missing]. Say which results are exploratory or uncertain. At most 400 words. No preamble.\n\n' +
    (qid ? notesMarkdown(Object.assign({}, r, { questions: r.questions.filter(q => q.id === qid), experiments: r.experiments.filter(e => e.q === qid) }), runList) : notesMarkdown(r, runList, memory));
}

// ---- Claude Code's memory for the project: read it, and write what you add (behaviors, ideas, runs, notes) ----
// Claude Code keeps one memory folder per start folder: ~/.claude/projects/<folder with / and . as ->/memory/,
// with one .md file per memory (front matter: name, description, metadata.type) and an index, MEMORY.md, that every new
// agent in that folder loads. What you add in Research Companion is written there, so the agents follow it.
const MEM_KINDS = ['behavior', 'idea', 'run', 'note'];
const KIND_TYPE = { behavior: 'feedback', idea: 'project', run: 'project', note: 'project' };
const TYPE_KIND = { feedback: 'behavior', user: 'note', project: 'note', reference: 'note' };
function memoryDirOf(folder, home) { return path.join(home || os.homedir(), '.claude', 'projects', String(folder || '').replace(/[^A-Za-z0-9-]/g, '-'), 'memory'); }
function frontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const l of m[1].split('\n')) { const kv = /^\s*([\w-]+):\s*(.*)$/.exec(l); if (kv && kv[2] !== '') meta[kv[1]] = kv[2].replace(/^["']|["']$/g, ''); }
  return { meta, body: m[2] };
}
function readMemory(dirs) {
  const out = [], seen = new Set();
  for (const dir of [...new Set(dirs)]) {
    let names = [];
    try { names = fs.readdirSync(dir).filter(n => n.endsWith('.md') && n !== 'MEMORY.md'); } catch (_) { continue; }
    for (const n of names) {
      const file = path.join(dir, n);
      if (seen.has(file)) continue; seen.add(file);
      let text, st;
      try { text = fs.readFileSync(file, 'utf8'); st = fs.statSync(file); } catch (_) { continue; }
      const { meta, body } = frontMatter(text);
      const kind = MEM_KINDS.includes(meta.crewmon) ? meta.crewmon : TYPE_KIND[meta.type] || 'note';
      out.push({ file, dir, name: meta.name || n.slice(0, -3), description: clean(meta.description, 300), type: meta.type || '', kind,
        body: body.trim().slice(0, 4000), mtime: st.mtimeMs, crewmon: !!meta.crewmon, at: Number(meta.added) || 0 });
    }
  }
  return out.sort((a, b) => (b.at || b.mtime) - (a.at || a.mtime));
}
const slugOf = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 6).join('-') || 'note';
const KIND_LABEL = { behavior: 'Behavior', idea: 'Idea', run: 'Run', note: 'Note' };
function memoryBody(kind, text, date) {
  const t = String(text).trim();
  if (kind === 'behavior') return t + '\n\n**Why:** the person added this rule in CrewMon Research Companion on ' + date + '.\n\n**How to apply:** follow it in this project from now on.\n';
  if (kind === 'idea') return t + '\n\nAn idea to try later, added by the person in CrewMon Research Companion on ' + date + '. Not agreed yet: ask before starting it.\n';
  if (kind === 'run') return t + '\n\nA run the person did outside these chats, recorded in CrewMon Research Companion on ' + date + '. Use its numbers as reported.\n';
  return t + '\n\nAdded by the person in CrewMon Research Companion on ' + date + '.\n';
}
function writeMemory(dir, kind, text, now) {
  if (!MEM_KINDS.includes(kind)) kind = 'note';
  const body = clean(text, 2000);
  if (!body) return null;
  fs.mkdirSync(dir, { recursive: true });
  const t = now || Date.now(), date = new Date(t).toISOString().slice(0, 10);
  let slug = slugOf(body), file = path.join(dir, slug + '.md');
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, slug + '-' + i + '.md');
  slug = path.basename(file, '.md');
  const desc = clean(body.split(/(?<=[.!?])\s/)[0], 140);
  fs.writeFileSync(file, '---\nname: ' + slug + '\ndescription: ' + desc.replace(/\n/g, ' ') + '\nmetadata:\n  type: ' + KIND_TYPE[kind] + '\n  crewmon: ' + kind + '\n  added: ' + t + '\n---\n\n' + memoryBody(kind, body, date));
  const index = path.join(dir, 'MEMORY.md');
  let idx = ''; try { idx = fs.readFileSync(index, 'utf8'); } catch (_) { /* first one */ }
  const line = '- [' + KIND_LABEL[kind] + ': ' + clean(body, 50).replace(/[\[\]]/g, '') + '](' + path.basename(file) + ') — ' + desc;
  fs.writeFileSync(index, (idx && !idx.endsWith('\n') ? idx + '\n' : idx) + line + '\n');
  return file;
}
function editMemory(file, text) {        // only files CrewMon wrote: their text and the index line
  const old = fs.readFileSync(file, 'utf8'), { meta } = frontMatter(old);
  if (!meta.crewmon) throw new Error('not written by CrewMon');
  const body = clean(text, 2000); if (!body) return;
  const desc = clean(body.split(/(?<=[.!?])\s/)[0], 140);
  const date = new Date(Number(meta.added) || Date.now()).toISOString().slice(0, 10);
  fs.writeFileSync(file, old.replace(/^description: .*$/m, 'description: ' + desc.replace(/\n/g, ' ')).replace(/\n---\n[\s\S]*$/, '\n---\n\n' + memoryBody(meta.crewmon, body, date)));
  const index = path.join(path.dirname(file), 'MEMORY.md'), b = path.basename(file);
  try {
    const idx = fs.readFileSync(index, 'utf8');
    fs.writeFileSync(index, idx.split('\n').map(l => l.includes('](' + b + ')') ? '- [' + KIND_LABEL[meta.crewmon] + ': ' + clean(body, 50).replace(/[\[\]]/g, '') + '](' + b + ') — ' + desc : l).join('\n'));
  } catch (_) { /* no index */ }
}
function deleteMemory(file) {
  if (!/\.md$/.test(file) || path.basename(file) === 'MEMORY.md' || path.basename(path.dirname(file)) !== 'memory') throw new Error('not a memory file');
  fs.unlinkSync(file);
  const index = path.join(path.dirname(file), 'MEMORY.md'), b = path.basename(file);
  try { const idx = fs.readFileSync(index, 'utf8'); fs.writeFileSync(index, idx.split('\n').filter(l => !l.includes('](' + b + ')')).join('\n')); } catch (_) { /* no index */ }
}
// Who saved which memory file, and when, from one chat (no AI): [{name, at, op: 'wrote'|'edited'}]
function memoryEvents(file) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - 24 * 1024 * 1024);
  const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(st.size - start); fs.readSync(fd, buf, 0, buf.length, start); fs.closeSync(fd);
  const out = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.includes('/memory/') || !line.includes('tool_use')) continue;
    let r; try { r = JSON.parse(line); } catch (_) { continue; }
    const c = r.message && r.message.content;
    if (Array.isArray(c)) for (const b of c) if (b && b.type === 'tool_use' && /^(Write|Edit|MultiEdit)$/.test(b.name)) {
      const f = String((b.input || {}).file_path || '');
      if (/\/memory\/[^/]+\.md$/.test(f) && !/\/MEMORY\.md$/.test(f) && r.timestamp) out.push({ name: path.basename(f, '.md'), file: f, at: r.timestamp ? Date.parse(r.timestamp) : 0, op: b.name === 'Write' ? 'wrote' : 'edited' });
    }
  }
  return out;
}
// A run you recorded in memory, shown with the others: its numbers come from its text
function memoryRun(m) {
  return { id: 'm' + crypto.createHash('sha1').update(m.file).digest('hex').slice(0, 6), use: 'mem:' + m.name, title: m.description || m.name, kind: 'manual', script: '',
    configs: [], seed: (/\bseeds?\s*[:=]?\s*([\d ,]+)/i.exec(m.body) || [])[1] ? clean(/\bseeds?\s*[:=]?\s*([\d ,]+)/i.exec(m.body)[1], 20) : '', name: '', smoke: false,
    status: 'completed', started: m.at || m.mtime, ended: m.at || m.mtime, metrics: metrics(m.body).metrics, epoch: '', last: '', manual: true, file: m.file };
}

module.exports = { STATUSES, Q_STATUSES, VERDICTS, projectRoot, keyOf, dir, fileOf, artifactDir, empty, load, save, all, userEdit, applyOps,
  launches, launchOf, metrics, runs, MEM_KINDS, memoryDirOf, readMemory, writeMemory, editMemory, deleteMemory, memoryEvents, memoryRun, excerpt, prompt, parseReply, due, bestOf, metricKeys, tableMarkdown, notesMarkdown, chartSVG, writeupPrompt, LOWER_BETTER, MIN_GAP_MS };
