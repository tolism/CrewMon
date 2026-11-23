// CrewMon (Crew Monitor): a VS Code tab showing your Claude Code agents as a map.
// Read-only towards sessions, except Rename (the same custom-title line /rename writes, only for a chat nothing runs).
// Click = open the chat via the Claude extension's own command; "Message" = open it with the text typed in.
'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile, execFileSync } = require('child_process');
const { snapshot, runningSessions, ROLES, AUTO, GROUPS } = require('./snapshot');

// The keeper (keeps chats running on the machine when VS Code closes them): ~/.local/bin/keeper, else the bundled copy.
function keeperPath(root) {
  const user = path.join(os.homedir(), '.local', 'bin', 'keeper');
  return fs.existsSync(user) ? user : path.join(root, 'keeper', 'keeper');
}
function runKeeper(root, args, input) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env);
    for (const k of Object.keys(env)) if (k.startsWith('CLAUDE')) delete env[k];   // not a child of any chat
    const p = execFile('python3', [keeperPath(root), ...args], { env, timeout: 60000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || (err && err.message) || '').trim() }));
    if (input !== undefined) { p.stdin.write(input + '\n'); }
    p.stdin.end();
  });
}

const CLAUDE_OPEN = 'claude-vscode.primaryEditor.open';   // (sessionId, prompt) per the Claude extension
let panel = null;
let timer = null;

function cfg(key, dflt) { return vscode.workspace.getConfiguration('crewmon').get(key, dflt); }

let extRoot = '';
let extVersion = '';
let lastModCheck = 0;
const DEFAULT_CHIPS = ['Status?', 'Continue', 'Summarise where you are in 5 lines', 'Stop after this step',
  'Commit your work (no Claude co-author line)', 'What do you need from me?'];
const HANDOVERS = path.join(os.homedir(), '.claude', 'crewmon', 'handovers');

// ---- the messenger: a background Claude session (tmux "crewmon-messenger") running the crewmon-messenger mod ----
const MSG_DIR = path.join(os.homedir(), '.claude', 'crewmon', 'messenger');
const MSG_TMUX = 'crewmon-messenger';
function tmuxHas(name) {
  return new Promise(r => execFile('tmux', ['has-session', '-t', name], (err) => r(!err)));
}
function heartbeat() {   // {at, version}; older messengers wrote only the time
  try {
    const t = fs.readFileSync(path.join(MSG_DIR, 'heartbeat'), 'utf8').trim();
    return t.startsWith('{') ? JSON.parse(t) : { at: Number(t), version: '' };
  } catch (_) { return null; }
}
async function messengerStatus() {
  if (!(await tmuxHas(MSG_TMUX))) return 'off';
  const hb = heartbeat();
  return hb && Date.now() - hb.at < 15000 ? 'on' : 'starting';
}
// The messenger runs from a fixed folder, refreshed from this version of the extension, so an update never leaves it
// pointing at an old (later deleted) extension folder.
const MOD_HOME = path.join(os.homedir(), '.claude', 'crewmon', 'messenger-mod');
function syncMod(root) {
  const src = path.join(root, 'messenger');
  for (const rel of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.ts']) {
    const to = path.join(MOD_HOME, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, rel), to);
  }
}
async function messengerUpToDate(root) {
  syncMod(root);
  if ((await messengerStatus()) !== 'on') return;
  const hb = heartbeat();
  const mine = extVersion;
  let busy = [];
  try { busy = JSON.parse(fs.readFileSync(path.join(MSG_DIR, 'active.json'), 'utf8')); } catch (_) { /* none */ }
  if (busy.length) return;              // a conversation is in progress: a reply could arrive while it restarts, so wait
  if (hb && hb.version !== mine) {      // an older messenger is running: restart it on this version (its conversations are kept)
    await new Promise(r => execFile('tmux', ['kill-session', '-t', MSG_TMUX], () => r()));
    await startMessenger(root, true);
    vscode.window.setStatusBarMessage('CrewMon: messenger updated to v' + mine, 6000);
  }
}
async function startMessenger(root, quiet) {
  if (await tmuxHas(MSG_TMUX)) return;
  syncMod(root);
  const bin = claudeBin();
  if (!bin) { vscode.window.showErrorMessage('CrewMon: no Claude Code binary found to run the messenger.'); return; }
  fs.mkdirSync(MSG_DIR, { recursive: true });
  const mod = MOD_HOME;
  const cmd = `exec env $(env | grep -oE "^CLAUDE[A-Z_]*" | sed "s/^/-u /") '${bin}' --plugin-dir '${mod}' --permission-mode auto`;
  execFile('tmux', ['new-session', '-d', '-s', MSG_TMUX, '-c', MSG_DIR, '-x', '200', '-y', '50', cmd], (err) => {
    if (err) vscode.window.showErrorMessage('CrewMon: could not start the messenger: ' + err.message);
    else if (!quiet) vscode.window.showInformationMessage('CrewMon: messenger starting. The first time, Claude asks whether to trust its folder: ' +
      'run "tmux attach -t crewmon-messenger" in a terminal, choose "Yes, I trust this folder", then press Ctrl+b d.');
  });
}
function stopMessenger() { execFile('tmux', ['kill-session', '-t', MSG_TMUX], () => push()); }
function queue(job) {
  const rid = crypto.randomBytes(3).toString('hex');
  fs.mkdirSync(MSG_DIR, { recursive: true });
  fs.appendFileSync(path.join(MSG_DIR, 'outbox.jsonl'), JSON.stringify(Object.assign({ rid }, job)) + '\n');
  return rid;
}
let inboxSeen = Date.now();
let noteSeen = Date.now();
function openNote(file) {
  if (file && fs.existsSync(file)) vscode.window.showTextDocument(vscode.Uri.file(file));
  else vscode.window.showWarningMessage('CrewMon: the note is not there yet.');
}
// A request is lost when its agent restarts before answering (VS Code reload, keeper hand-back). Watch the process
// running the agent each conversation waits for; if it changes and no reply came, send the last request again, once per change.
// A request is lost when its agent restarts before answering (VS Code reload, keeper hand-back). Rule: if the
// process now running the agent a conversation waits for started AFTER the request was last sent, and no reply came,
// send it again, once per process. Works whenever CrewMon looks, not only if it watched the restart happen.
const resentFor = {};   // rid -> pid it was resent to
function autoResend(active, lines) {
  const run = runningSessions();
  for (const a of active) {
    if (!a.waiting) continue;
    const procs = run[a.waiting] || [];
    if (!procs.length) continue;                          // asleep: Retry after waking it, or it is resent when it starts
    const sentAt = Math.max(a.sentAt || 0, ...lines.filter(x => x.rid === a.rid && (x.kind === 'sent' || x.kind === 'resent')).map(x => x.at));
    const replied = lines.some(x => x.rid === a.rid && x.kind === 'reply' && x.at > sentAt);
    const newest = procs.reduce((p, q) => (q.start > p.start ? q : p));
    if (!sentAt || replied || !newest.start || newest.start < sentAt + 2000) continue;
    if (resentFor[a.rid] === newest.pid) continue;
    resentFor[a.rid] = newest.pid;
    queue({ kind: 'resend', rid: a.rid });
    vscode.window.setStatusBarMessage(`CrewMon: "${a.waitingTitle}" restarted before answering; its request was sent again`, 8000);
  }
}
let lastSessions = [];
function readInbox() {
  const replies = {}, now = Date.now();
  let lines = [];
  try { lines = fs.readFileSync(path.join(MSG_DIR, 'inbox.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) { /* none yet */ }
  for (const x of lines) {
    if (x.kind === 'reply' && x.session && now - x.at < 30 * 60e3) replies[x.session] = (x.text || '').slice(0, 300);
    if (x.at > inboxSeen && x.kind === 'drive-uploaded') {
      let d = {}; try { d = JSON.parse(x.text); } catch (_) { /* */ }
      const pick = pickupText(d.title, d.url, d.zip);
      vscode.window.showInformationMessage(`CrewMon: uploaded to Google Drive: "${d.title}".`, 'Copy pickup message', 'Open in Drive')
        .then(p => { if (p === 'Open in Drive') vscode.env.openExternal(vscode.Uri.parse(d.url)); else if (p) { vscode.env.clipboard.writeText(pick); vscode.window.setStatusBarMessage('CrewMon: pickup message copied', 4000); } });
    }
    if (x.at > inboxSeen && x.kind === 'drive-read' && pickups[x.rid]) {
      let d = {}; try { d = JSON.parse(x.text); } catch (_) { /* */ }
      const p = pickups[x.rid]; delete pickups[x.rid];
      const local = path.join(HANDOVERS, 'drive-' + d.id + '.md');
      let dir = '';
      if (d.zipB64) {
        try { dir = unzipPickup(path.join(HANDOVERS, path.basename(d.zipB64)), d.id); }
        catch (e) { vscode.window.showErrorMessage('CrewMon: could not unzip the files from Google Drive: ' + (e.message || e)); }
      }
      const files = dir ? ` Its files are unzipped in ${dir}.` : '';
      const msg = p.id
        ? `Read the hand-over note at ${local} (from Google Drive: "${p.title}") and continue from it.${files} First reply with 2-3 lines on what you are taking over and what you will do next.`
        : `Files from Google Drive ("${p.title}") are unzipped in ${dir || '(the unzip failed)'}. Look at what is there and reply with 2-3 lines on what it holds and how you would use it here.`;
      sendMessage({ ids: [p.to], text: msg });
      if (p.id) queue({ kind: 'drive-mark', id: p.id, text: 'Picked up by "' + p.toTitle + '" on ' + new Date().toISOString().slice(0, 16).replace('T', ' ') });
    }
    if (x.at > inboxSeen && (x.kind === 'reply' || x.kind === 'error')) {
      const s = lastSessions.find(y => y.id === x.session);
      const who = s ? s.title : (x.session || 'an agent').slice(0, 8);
      if (x.kind === 'error') vscode.window.showErrorMessage(`CrewMon: could not deliver to "${who}": ${x.text}`);
      else vscode.window.showInformationMessage(`💬 ${who}: ${(x.text || '').slice(0, 160)}`, 'Open chat')
        .then(p => { if (p && x.session) openChat(x.session); });
    }
  }
  if (lines.length) inboxSeen = Math.max(inboxSeen, lines[lines.length - 1].at);
  let active = [];
  try { active = JSON.parse(fs.readFileSync(path.join(MSG_DIR, 'active.json'), 'utf8')); } catch (_) { /* none */ }
  // the Activity log: what CrewMon asked for (outbox) and what happened (inbox), newest first
  let out = [];
  try { out = fs.readFileSync(path.join(MSG_DIR, 'outbox.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) { /* none */ }
  const title = (id) => { const s = lastSessions.find(y => y.id === id); return s ? s.title : (id ? id.slice(0, 8) : ''); };
  const activity = lines.filter(x => ['sent', 'resent', 'reply', 'error', 'done', 'cancelled', 'note-ready', 'drive-uploaded', 'drive-marked'].includes(x.kind)).map(x => {
    const req = out.find(o => o.rid === x.rid) || {};
    return { at: x.at, rid: x.rid || '', kind: x.kind, convo: req.kind || '', who: title(x.session), text: (x.text || '').slice(0, 4000) };
  }).reverse().slice(0, 80);
  for (const a of active) { a.aTitle = a.aTitle || title(a.a); a.bTitle = a.bTitle || title(a.b); a.waitingTitle = title(a.waiting); }
  // notes waiting for your check
  for (const x of lines) if (x.kind === 'note-ready' && x.at > noteSeen) {
    noteSeen = x.at;
    const a = active.find(y => y.rid === x.rid);
    const toDrive = a && !a.b;
    vscode.window.showInformationMessage(`CrewMon: the hand-over note from "${title(x.session)}" is ready.`, 'Read the note',
      toDrive ? 'Upload to Google Drive' : 'Send to ' + (a ? a.bTitle.slice(0, 24) : 'B'), 'Cancel hand-over')
      .then(p => { if (!p) return; if (p === 'Read the note') openNote(x.text);
        else if (p.startsWith('Upload')) driveApprove(x.rid, x.text, title(x.session));
        else if (p.startsWith('Send')) queue({ kind: 'approve', rid: x.rid }); else queue({ kind: 'cancel', rid: x.rid }); setTimeout(push, 1500); });
  }
  autoResend(active, lines);
  let drive = null;
  try { drive = JSON.parse(fs.readFileSync(path.join(MSG_DIR, 'drive.json'), 'utf8')); } catch (_) { /* not listed yet */ }
  return { replies, active, activity, drive };
}

// ---- Google Drive hand-overs ----
// What to flag before a note leaves the machine (a warning, not a filter: you decide).
const SENSITIVE = [
  [/\bPATNO\b|\bparticipant[s]?\b.{0,20}\b\d{4,6}\b|\bsubject[s]?\b.{0,12}\b\d{4,6}\b/i, 'participant ids'],
  [/\b[a-z]{2}0[123]\d{3}\b/, 'study participant codes'],
  [/\/home\/[^\s/]+|\/media\/[^\s]+/, 'local file paths'],
  [/[\w.+-]+@[\w-]+\.[\w.]+/, 'email addresses'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/, 'IP addresses'],
  [/(?:password|passwd|secret|token|api[_-]?key)\s*[:=]/i, 'secrets'],
];
function sensitiveHits(text) { return SENSITIVE.filter(([re]) => re.test(text)).map(([, label]) => label); }
function driveBlocked(cwd) { return (cfg('driveBlockedFolders', []) || []).some(f => f && (cwd || '').includes(f)); }
const pickups = {};     // rid -> { to, toTitle, title, id } while a Drive note is being downloaded for a local agent
function pickupText(title, url, zip, isZip) {
  if (isZip) return `Download "${title}" from Google Drive (${url}), unzip it next to your work, and reply with 2-3 lines on what it holds.`;
  const files = zip ? ` Its files are in "${zip.title}" in the same Google Drive folder: download it and unzip it next to your work.` : '';
  return `Open the CrewMon hand-over "${title}" in Google Drive (${url}).${files} Confirm in 3 lines what you are taking over and what you will do next, then continue from it.`;
}
// ---- Files attached to a Drive hand-over: one zip, built here, checked by you ----
const ZIP_MAX = 20 * 1024 * 1024;
const SKIP_DIR = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.ipynb_checkpoints', '.claude']);
const DATA_EXT = /\.(parquet|csv|tsv|pkl|pickle|h5|hdf5|npy|npz|jsonl|feather|arrow|sqlite|db|edf|bin|cwa|gt3x|mat|sav|xlsx?)$/i;
const SECRET_FILE = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_(rsa|ed25519)(\.pub)?|credentials.*\.json)$/i;
function walkPick(paths) {
  const root = paths.length === 1 ? path.dirname(paths[0]) : paths.reduce((a, b) => { while (!(b + path.sep).startsWith(a + path.sep)) a = path.dirname(a); return a; }, path.dirname(paths[0]));
  const keep = [], left = [];
  const walk = (p) => {
    let st; try { st = fs.lstatSync(p); } catch (_) { return; }
    const rel = path.relative(root, p);
    if (st.isSymbolicLink()) { left.push(rel + ' (link)'); return; }
    if (st.isDirectory()) {
      if (SKIP_DIR.has(path.basename(p))) { left.push(rel + '/'); return; }
      for (const n of fs.readdirSync(p).sort()) walk(path.join(p, n));
    } else if (st.isFile()) {
      if (DATA_EXT.test(p) || SECRET_FILE.test(rel)) left.push(rel); else keep.push({ rel, size: st.size });
    }
  };
  for (const p of paths) walk(p);
  return { root, keep, left };
}
// A zip fetched from Drive (base64 text from the messenger) -> handovers/drive-<id>-files/
function unzipPickup(b64file, id) {
  const zip = b64file.replace(/\.b64$/, '');
  fs.writeFileSync(zip, Buffer.from(fs.readFileSync(b64file, 'utf8'), 'base64'));
  const names = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n').filter(Boolean);
  if (names.some(n => n.startsWith('/') || n.split(/[\\/]/).includes('..'))) throw new Error('the zip holds paths outside its folder; not unpacked');
  const dir = path.join(HANDOVERS, 'drive-' + id + '-files');
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
  return dir;
}
function mb(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
// Ask for files, zip them, show you what goes; returns the zip path, '' for "note only", null for "stop"
async function attachFiles(rid, cwd) {
  const pick = await vscode.window.showInformationMessage('Attach files to this hand-over? They go to Google Drive as one zip next to the note.',
    { modal: true }, 'Upload the note only', 'Attach files or folders…');
  if (!pick) return null;
  if (pick === 'Upload the note only') return '';
  const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: true,
    openLabel: 'Attach', title: 'Files for the hand-over (zipped)', defaultUri: cwd && fs.existsSync(cwd) ? vscode.Uri.file(cwd) : undefined });
  if (!uris || !uris.length) return null;
  const paths = uris.map(u => u.fsPath);
  if (paths.some(p => driveBlocked(p))) { vscode.window.showErrorMessage('CrewMon: one of these is in a folder blocked from Google Drive (setting crewmon.driveBlockedFolders).'); return null; }
  const { root, keep, left } = walkPick(paths);
  if (!keep.length) { vscode.window.showErrorMessage('CrewMon: nothing to attach: ' + (left.length ? 'everything picked is data, secrets or caches.' : 'the selection is empty.')); return null; }
  const raw = keep.reduce((a, f) => a + f.size, 0);
  if (raw > 10 * ZIP_MAX) { vscode.window.showErrorMessage(`CrewMon: ${mb(raw)} is too much to hand over through Drive (zip limit ${mb(ZIP_MAX)}).`); return null; }
  const zip = path.join(HANDOVERS, `attach-${rid}.zip`);
  try { fs.rmSync(zip, { force: true }); } catch (_) { /* fresh */ }
  try { execFileSync('zip', ['-q', '-X', zip, '-@'], { cwd: root, input: keep.map(f => f.rel).join('\n') }); }
  catch (e) { vscode.window.showErrorMessage('CrewMon: could not build the zip: ' + (e.message || e)); return null; }
  const size = fs.statSync(zip).size;
  if (size > ZIP_MAX) { vscode.window.showErrorMessage(`CrewMon: the zip is ${mb(size)}; the limit for a Drive hand-over is ${mb(ZIP_MAX)}. Pick less.`); return null; }
  const hits = new Set();
  for (const f of keep) if (f.size < 300e3 && !/\.(png|jpe?g|gif|pdf|zip|gz|pt|pth|onnx|whl)$/i.test(f.rel)) {
    try { for (const h of sensitiveHits(fs.readFileSync(path.join(root, f.rel), 'utf8'))) hits.add(h); } catch (_) { /* unreadable */ }
  }
  const detail = keep.slice(0, 14).map(f => '• ' + f.rel + '  (' + mb(f.size) + ')').join('\n') + (keep.length > 14 ? `\n…and ${keep.length - 14} more` : '') +
    (left.length ? `\n\nLeft out (${left.length}): ` + left.slice(0, 6).join(', ') + (left.length > 6 ? ', …' : '') + '\n(data files, secrets, links, .git, caches)' : '') +
    (hits.size ? '\n\n⚠ The files mention ' + [...hits].join(', ') + '.' : '');
  const ok = await vscode.window.showWarningMessage(`Upload ${keep.length} file${keep.length > 1 ? 's' : ''} (${mb(size)} zipped) to your Google Drive with the note?`,
    { modal: true, detail }, 'Upload note + files');
  return ok ? zip : null;
}
// Upload a reviewed note: check it, then tell the messenger to continue the hand-over (which uploads it)
async function driveApprove(rid, file, fromTitle, cwd) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { vscode.window.showWarningMessage('CrewMon: the note is not there yet.'); return; }
  const hits = sensitiveHits(text);
  if (hits.length) {
    const ok = await vscode.window.showWarningMessage(`The note mentions ${hits.join(', ')}. Uploading puts it in your Google Drive, outside this machine.`,
      { modal: true }, 'Upload anyway', 'Open the note');
    if (ok === 'Open the note') { openNote(file); return; }
    if (ok !== 'Upload anyway') return;
  }
  if (!cwd) {       // where agent A works: the file picker starts there
    let act = []; try { act = JSON.parse(fs.readFileSync(path.join(MSG_DIR, 'active.json'), 'utf8')); } catch (_) { /* none */ }
    const j = (Array.isArray(act) ? act : Object.values(act)).find(x => x && x.rid === rid);
    const s = j && lastSessions.find(y => y.id === j.a);
    cwd = s ? (s.cwd || s.startCwd) : '';
  }
  const zip = await attachFiles(rid, cwd);
  if (zip === null) return;
  const title = 'Hand-over from ' + fromTitle + ' · ' + new Date().toISOString().slice(0, 10);
  queue({ kind: 'approve', rid, title, description: 'CrewMon hand-over, not picked up yet', zip: zip || undefined });
  vscode.window.setStatusBarMessage('CrewMon: uploading the note to Google Drive…', 6000);
}

// Send a message. Without the messenger: open the chat with the text typed in (you press Enter); several -> one after another.
async function sendMessage(m) {
  const ids = m.ids || [];
  if ((await messengerStatus()) === 'on') {
    for (const id of ids) queue({ kind: 'message', to: id, text: m.text });
    vscode.window.setStatusBarMessage(`CrewMon: sent to ${ids.length} agent${ids.length > 1 ? 's' : ''}`, 3000);
    return;
  }
  for (let i = 0; i < ids.length; i++) {
    await openChat(ids[i], m.text);
    if (ids.length > 1) {
      const more = i < ids.length - 1;
      const pick = await vscode.window.showInformationMessage(
        `CrewMon: message typed into ${i + 1} of ${ids.length}. Press Enter in the chat to send it.`, ...(more ? ['Next agent', 'Stop'] : []));
      if (more && pick !== 'Next agent') break;
    }
  }
}

// Groups: your own grouping on the map, kept in ~/.claude/crewmon/groups.json. group null = ask for a new name, '' = none.
async function setGroup(m) {
  let g = m.group;
  if (g === null) {
    g = await vscode.window.showInputBox({ title: 'New group', placeHolder: 'e.g. Paper, Deployment, Sleep' });
    if (!g || !g.trim()) return;
    g = g.trim().slice(0, 40);
  }
  let all = {};
  try { all = JSON.parse(fs.readFileSync(GROUPS, 'utf8')); } catch (_) { /* first one */ }
  for (const id of m.ids || []) { if (g) all[id] = g; else delete all[id]; }
  fs.mkdirSync(path.dirname(GROUPS), { recursive: true });
  fs.writeFileSync(GROUPS, JSON.stringify(all, null, 1));
  push();
}

// Hand-over A -> B: A writes a note to a file (its chat opens with the request typed in); when the file appears,
// CrewMon offers to open B with "read it and continue" typed in.
async function handover(m) {
  fs.mkdirSync(HANDOVERS, { recursive: true });
  const file = path.join(HANDOVERS, `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}-${m.from.slice(0, 8)}-to-${m.to.slice(0, 8)}.md`);
  const fillT = (t) => (t || '').replace(/\{NOTE\}/g, file).replace(/\{A\}/g, m.fromTitle).replace(/\{B\}/g, m.toTitle);
  const withNote = (t, how) => t.includes(file) ? t : t + '\n\n' + how + file + '.';   // {NOTE} may have been edited out
  if (m.dest === 'drive') {
    if ((await messengerStatus()) !== 'on') { vscode.window.showErrorMessage('CrewMon: a Google Drive hand-over needs the messenger (start it in the top bar).'); return; }
    if (driveBlocked(m.fromCwd)) { vscode.window.showErrorMessage('CrewMon: Google Drive hand-overs are turned off for this folder (setting crewmon.driveBlockedFolders).'); return; }
    queue({ kind: 'handover', dest: 'drive', from: m.from, to: '', fromTitle: m.fromTitle, toTitle: 'someone else (via Google Drive)', file,
      textA: m.textA || '', approve: true });
    vscode.window.showInformationMessage(`CrewMon: "${m.fromTitle}" writes the note; you check it before it goes to Google Drive.`);
    return;
  }
  if ((await messengerStatus()) === 'on') {
    queue({ kind: 'handover', from: m.from, to: m.to, fromTitle: m.fromTitle, toTitle: m.toTitle, file,
      textA: m.textA || '', textB: m.textB || '', approve: !!m.approve });
    vscode.window.showInformationMessage(`CrewMon: hand-over started: "${m.fromTitle}" writes the note, then "${m.toTitle}" continues.`);
    return;
  }
  const ask = m.textA ? withNote(fillT(m.textA), 'Save the note as Markdown to ') : `Please write a hand-over note for another agent ("${m.toTitle}") who will continue part of your work. ` +
    `Save it as Markdown to ${file}. Include: the goal; what is done; key decisions and why; where things are (files, commands, ` +
    `data); open problems; and the exact next steps. Reply "hand-over ready" when it is saved.`;
  await openChat(m.from, ask);
  vscode.window.showInformationMessage(`CrewMon: hand-over request typed into "${m.fromTitle}". Press Enter there; CrewMon tells you when the note is ready.`);
  const started = Date.now();
  const timer = setInterval(async () => {
    if (fs.existsSync(file) && fs.statSync(file).size > 0 && Date.now() - fs.statSync(file).mtimeMs > 4000) {
      clearInterval(timer);
      const pick = await vscode.window.showInformationMessage(`CrewMon: the hand-over note from "${m.fromTitle}" is ready.`, `Open "${m.toTitle.slice(0, 30)}" with it`, 'Show the note');
      if (pick === 'Show the note') { vscode.window.showTextDocument(vscode.Uri.file(file)); }
      else if (pick) {
        await openChat(m.to, m.textB ? withNote(fillT(m.textB), 'The hand-over note is at ') : `Read the hand-over note at ${file} from the agent "${m.fromTitle}" and continue from it. ` +
          `First confirm in 2-3 lines what you are taking over and what you will do next.`);
      }
    } else if (Date.now() - started > 3 * 3600e3) clearInterval(timer);
  }, 3000);
}

// ---- "In charge of" one-liners: made by a small model from each session's latest summary, cached in auto.json ----
function claudeBin() {   // the Claude binary shipped with the newest installed Claude Code extension
  const dir = path.join(os.homedir(), '.vscode-server', 'extensions');
  const found = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .map(d => ({ m: /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/.exec(d), bin: path.join(dir, d, 'resources', 'native-binary', 'claude') }))
    .filter(x => x.m && fs.existsSync(x.bin))
    .map(x => ({ bin: x.bin, v: x.m.slice(1).map(Number) }))
    .sort((p, q) => q.v[0] - p.v[0] || q.v[1] - p.v[1] || q.v[2] - p.v[2]);
  return found.length ? found[0].bin : null;
}
const describing = new Set();
let describeBusy = false;
function describeQueue(sessions) {
  if (!cfg('aiDescriptions', true) || describeBusy) return;
  const next = sessions.find(s => s.summary && !s.autoFresh && !describing.has(s.id + s.summaryKey));
  if (!next) return;
  const bin = claudeBin();
  if (!bin) return;
  describeBusy = true;
  describing.add(next.id + next.summaryKey);
  const prompt = 'In one sentence of at most 20 words, say what this Claude Code agent is in charge of, based on the ' +
    'summary of its work below. Start with a verb such as Builds, Maintains, Analyses, Writes. No preamble, no quotes.\n\n' +
    'Project folder: ' + path.basename(next.startCwd || '') + '\n' + next.summary;
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE')) delete env[k];
  const cwd = path.dirname(AUTO);
  fs.mkdirSync(cwd, { recursive: true });
  execFile(bin, ['-p', prompt, '--model', 'haiku', '--no-session-persistence', '--tools', '', '--strict-mcp-config',
                 '--setting-sources', 'user'], { env, cwd, timeout: 90000, maxBuffer: 1 << 20 }, (err, stdout) => {
    describeBusy = false;
    const line = (stdout || '').split('\n').map(x => x.trim()).filter(x => x && !x.startsWith('Permission ')).pop() || '';
    if (!err && line) {
      let all = {};
      try { all = JSON.parse(fs.readFileSync(AUTO, 'utf8')); } catch (_) { /* first one */ }
      all[next.id] = { key: next.summaryKey, text: line.replace(/^["']|["']$/g, '').slice(0, 220), at: Date.now() };
      fs.writeFileSync(AUTO, JSON.stringify(all, null, 1));
      push();
    }
  });
}

// Rename a session the way Claude Code's /rename does: a {"type":"custom-title"} line in its chat file.
// Open in VS Code -> type /rename there (you press Enter); keeper copy -> type /rename into its tmux;
// not running -> append the line ourselves, after checking again that no process runs it.
async function renameSession(m) {
  const hosts = (runningSessions()[m.id] || []).map(x => x.host);
  if (hosts.includes('vscode')) {
    // open in VS Code: use the Claude extension's own rename (it writes the title and tells the running chat)
    await openChat(m.id);
    await new Promise(r => setTimeout(r, 900));
    try { await vscode.commands.executeCommand('claude-vscode.renameSessionTab'); return; }
    catch (e) { /* fall back to writing the title line below */ }
  }
  const name = await vscode.window.showInputBox({ title: 'Rename session', prompt: m.title, value: m.title,
    validateInput: (v) => v.trim() ? null : 'Enter a name' });
  if (!name || name.trim() === m.title) return;
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, 120);
  if (hosts.includes('machine')) {   // the keeper's copy in tmux: the CLI's own /rename
    const t = 'cc-' + m.id.slice(0, 8);
    execFile('tmux', ['send-keys', '-t', t, '-l', '/rename ' + clean], (err) => {
      if (err) { vscode.window.showErrorMessage('CrewMon: could not reach the keeper copy: ' + err.message); return; }
      execFile('tmux', ['send-keys', '-t', t, 'Enter'], () => setTimeout(push, 1500));
    });
    return;
  }
  if (hosts.includes('terminal')) {
    vscode.window.showWarningMessage('CrewMon: this session is running in a terminal; rename it there with /rename.');
    return;
  }
  try {   // not running (or the extension command failed): the same custom-title line Claude writes
    const line = JSON.stringify({ type: 'custom-title', sessionId: m.id, customTitle: clean });
    fs.appendFileSync(m.file, '\n'.repeat(needsNewline(m.file) ? 1 : 0) + line + '\n');
    vscode.window.setStatusBarMessage('CrewMon: renamed to ' + clean, 3000);
    push();
  } catch (e) {
    vscode.window.showErrorMessage('CrewMon: could not rename: ' + e.message);
  }
}
function needsNewline(file) {   // the file should end with a newline before we add a line
  const st = fs.statSync(file);
  if (!st.size) return false;
  const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(1);
  try { fs.readSync(fd, b, 0, 1, st.size - 1); } finally { fs.closeSync(fd); }
  return b[0] !== 10;
}

// "In charge of": the user's own description of a session, kept in ~/.claude/crewmon/roles.json.
async function editRole(m) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(ROLES, 'utf8')); } catch (_) { /* first one */ }
  const v = await vscode.window.showInputBox({
    title: 'What is this agent in charge of?', prompt: m.title, value: all[m.id] || m.desc || '',
    placeHolder: 'e.g. Owns the manuscript edits for the SAM-PD paper (empty = automatic)' });
  if (v === undefined) return;
  if (v.trim()) all[m.id] = v.trim(); else delete all[m.id];
  fs.mkdirSync(path.dirname(ROLES), { recursive: true });
  fs.writeFileSync(ROLES, JSON.stringify(all, null, 1));
  push();
}
async function push() {
  if (!panel) return;
  let data;
  try { data = snapshot(cfg('days', 7)); } catch (e) { data = { sessions: [], error: String(e) }; }
  const k = await runKeeper(extRoot, ['status', '--json']);
  try { data.keeper = k.ok ? JSON.parse(k.out) : null; } catch (_) { data.keeper = null; }
  describeQueue(data.sessions || []);
  if (Date.now() - lastModCheck > 30000) { lastModCheck = Date.now(); messengerUpToDate(extRoot).catch(() => {}); }
  data.chips = cfg('quickMessages', DEFAULT_CHIPS);
  data.critter = cfg('critter', 'bot');
  const hbv = heartbeat();
  let bundledKeeper = '';
  try { bundledKeeper = require('crypto').createHash('sha1').update(fs.readFileSync(fs.realpathSync(keeperPath(extRoot)))).digest('hex').slice(0, 10); } catch (_) { /* none */ }
  data.versions = { crewmon: extVersion, messenger: hbv ? hbv.version || 'old' : '',
    keeperLoop: data.keeper && data.keeper.loop ? data.keeper.loop.code : '', keeperCode: bundledKeeper };
  data.messengerStatus = await messengerStatus();
  data.messenger = data.messengerStatus === 'on';
  lastSessions = data.sessions || [];
  const ib = readInbox();
  data.replies = ib.replies;
  data.active = ib.active;
  data.activity = ib.activity;
  data.drive = ib.drive;
  const slim = Object.assign({}, data, { sessions: (data.sessions || []).map(s => Object.assign({}, s, { summary: undefined })) });
  if (panel) panel.webview.postMessage({ type: 'data', data: slim });
}

// Keeper actions from the map. Delete asks in a VS Code dialog, then types the confirmation keeper asks for.
async function keeperAction(m) {
  const id = m.id, short = (id || '').slice(0, 8);
  let args, input;
  switch (m.action) {
    case 'start': args = ['start']; break;
    case 'stop': args = ['stop']; break;
    case 'hold': args = ['hold', id]; break;
    case 'end': args = ['end', id]; break;
    case 'watch': args = ['watch', id]; break;
    case 'unwatch': args = ['unwatch', id]; break;
    case 'restore': args = ['restore', id]; break;
    case 'delete': {
      const pick = await vscode.window.showWarningMessage(
        `Delete chat "${m.title || short}"? Its files go to the keeper's trash (Restore brings them back). Delete it in the Claude app too.`,
        { modal: true }, 'Move to trash');
      if (pick !== 'Move to trash') return;
      args = ['delete', id]; input = short; break;
    }
    default: return;
  }
  const r = await runKeeper(extRoot, args, input);
  const text = (r.out || r.err || '').split('\n').filter(Boolean).pop() || (r.ok ? 'done' : 'failed');
  (r.ok ? vscode.window.showInformationMessage : vscode.window.showErrorMessage)('Keeper: ' + text);
  push();
}

function html(webview, root) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const page = fs.readFileSync(path.join(root, 'media', 'map.html'), 'utf8');
  const critters = webview.asWebviewUri(vscode.Uri.file(path.join(root, 'media', 'critters.js'))).toString();
  return page.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{csp\}\}/g, webview.cspSource).replace(/\{\{critters\}\}/g, critters);
}

async function openChat(id, prompt) {
  const all = await vscode.commands.getCommands(true);
  if (!all.includes(CLAUDE_OPEN)) {
    vscode.window.showErrorMessage('CrewMon: the Claude Code extension command to open a session was not found.');
    return;
  }
  try {
    await (prompt === undefined ? vscode.commands.executeCommand(CLAUDE_OPEN, id)
                                : vscode.commands.executeCommand(CLAUDE_OPEN, id, prompt));
  } catch (e) {
    vscode.window.showErrorMessage('CrewMon: could not open the session: ' + e.message);
  }
}

function open(context) {
  if (panel) { panel.reveal(); push(); return; }
  panel = vscode.window.createWebviewPanel('crewmon', 'CrewMon', vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))] });
  panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, 'media', 'icon.png'));
  panel.webview.html = html(panel.webview, context.extensionPath);
  panel.webview.onDidReceiveMessage(async (m) => {
    if (m.type === 'ready' || m.type === 'refresh') push();
    else if (m.type === 'open') await openChat(m.id);
    else if (m.type === 'message') await openChat(m.id, m.text);
    else if (m.type === 'keeper') await keeperAction(m);
    else if (m.type === 'role') await editRole(m);
    else if (m.type === 'rename') await renameSession(m);
    else if (m.type === 'send') await sendMessage(m);
    else if (m.type === 'group') await setGroup(m);
    else if (m.type === 'handover') await handover(m);
    else if (m.type === 'ask') {
      const q = await vscode.window.showInputBox({ title: `Ask "${m.toTitle}"`, prompt: `The answer goes to you and to "${m.fromTitle}".` });
      if (q && q.trim()) queue({ kind: 'ask', from: m.from, to: m.to, fromTitle: m.fromTitle, toTitle: m.toTitle, text: q.trim() });
    } else if (m.type === 'talk') {
      const topic = await vscode.window.showInputBox({ title: `"${m.fromTitle}" and "${m.toTitle}" discuss…`, placeHolder: 'the topic or question' });
      if (!topic || !topic.trim()) return;
      const r = await vscode.window.showQuickPick(['1', '2', '3', '4'], { title: 'Turns each (keeps the cost bounded)' });
      if (!r) return;
      queue({ kind: 'talk', a: m.from, b: m.to, aTitle: m.fromTitle, bTitle: m.toTitle, text: topic.trim(), rounds: Number(r) });
      vscode.window.showInformationMessage('CrewMon: discussion started; replies appear over the critters and A sends a summary at the end.');
    }
    else if (m.type === 'convo' && m.action === 'approve' && m.drive) { await driveApprove(m.rid, m.file, m.fromTitle); setTimeout(push, 1500); }
    else if (m.type === 'convo') { queue({ kind: m.action, rid: m.rid }); setTimeout(push, 1500); }
    else if (m.type === 'driveList') { if ((await messengerStatus()) === 'on') queue({ kind: 'drive-list' }); else vscode.window.showWarningMessage('CrewMon: the Drive inbox needs the messenger (start it in the top bar).'); }
    else if (m.type === 'drivePickup') { const rid = queue({ kind: 'drive-read', id: m.id || undefined, zipId: m.zipId || undefined, title: m.title }); pickups[rid] = { to: m.to, toTitle: m.toTitle, title: m.title, id: m.id };
      vscode.window.setStatusBarMessage(`CrewMon: fetching "${m.title}" from Google Drive for "${m.toTitle}"…`, 6000); }
    else if (m.type === 'openUrl') vscode.env.openExternal(vscode.Uri.parse(m.url));
    else if (m.type === 'copyPickup') { await vscode.env.clipboard.writeText(pickupText(m.title, m.url, m.zipTitle ? { title: m.zipTitle } : null, m.isZip)); vscode.window.setStatusBarMessage('CrewMon: pickup message copied', 4000); }
    else if (m.type === 'opennote') openNote(m.file);
    else if (m.type === 'restartKeeper') { await runKeeper(extRoot, ['stop']); await runKeeper(extRoot, ['start']); setTimeout(push, 2000); }
    else if (m.type === 'messenger') { if (m.on) await startMessenger(extRoot); else stopMessenger(); setTimeout(push, 1500); }
    else if (m.type === 'copy') { await vscode.env.clipboard.writeText(m.text); vscode.window.setStatusBarMessage('Copied ' + m.text.split('\n').join('  '), 3000); }
  });
  timer = setInterval(push, Math.max(2, cfg('refreshSeconds', 5)) * 1000);
  panel.onDidDispose(() => { clearInterval(timer); timer = null; panel = null; });
}

function activate(context) {
  extRoot = context.extensionPath;
  extVersion = context.extension.packageJSON.version;
  messengerUpToDate(extRoot).catch(() => {});
  context.subscriptions.push(vscode.commands.registerCommand('crewmon.open', () => open(context)));
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  item.text = '$(organization) Crew';
  item.tooltip = 'Open CrewMon (Ctrl+Alt+A)';
  item.command = 'crewmon.open';
  item.show();
  context.subscriptions.push(item);
}

function deactivate() { if (timer) clearInterval(timer); }

module.exports = { activate, deactivate };
