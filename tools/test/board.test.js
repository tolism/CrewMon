// node --test tools/test   (part of tools/check.sh)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const B = require('../../board.js');

const fresh = () => B.empty('s1', 'Test agent');
const sec = (b, text) => (b.items.find(x => x.text === text) || {}).section;

test('your items: Haiku can only tick them done', () => {
  const b = fresh();
  B.userEdit(b, { op: 'add', section: 'next', text: 'Write the README' });
  const mine = b.items[0];
  B.applyOps(b, [{ op: 'move', id: mine.id, to: 'later' }]);
  assert.equal(mine.section, 'next');
  B.applyOps(b, [{ op: 'done', id: mine.id, evidence: 'commit ab12: README' }]);
  assert.equal(mine.section, 'done');
  assert.equal(mine.probable, false);
});

test('done without evidence is only "probably done"', () => {
  const b = fresh();
  B.applyOps(b, [{ op: 'add', section: 'next', text: 'Fix the expiry test' }]);
  const it = b.items[0];
  B.applyOps(b, [{ op: 'done', id: it.id }]);
  assert.equal(it.section, 'done');
  assert.equal(it.probable, true);
});

test('deleted items never come back; near-duplicates merge', () => {
  const b = fresh();
  B.applyOps(b, [{ op: 'add', section: 'next', text: 'Update the payment form tests' }]);
  B.userEdit(b, { op: 'delete', itemId: b.items[0].id });
  B.applyOps(b, [{ op: 'add', section: 'next', text: 'Update the payment form tests' }]);
  assert.equal(b.items.length, 0);
  B.applyOps(b, [{ op: 'add', section: 'next', text: 'Run the full test suite again' }]);
  B.applyOps(b, [{ op: 'add', section: 'now', text: 'Run the full test suite' }]);
  assert.equal(b.items.length, 1);
  assert.equal(b.items[0].section, 'now');
});

test('at most 6 new items per sync (10 on a new board), bad ops ignored', () => {
  const b = fresh();
  B.applyOps(b, [{ op: 'add', section: 'next', text: 'Existing item first' }]);
  const ops = Array.from({ length: 10 }, (_, i) => ({ op: 'add', section: 'later', text: 'Idea number ' + ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'][i] }));
  const r = B.applyOps(b, ops.concat([null, { op: 'explode' }, { op: 'move', id: 'nope', to: 'done' }]));
  assert.equal(r.added, 6);
  assert.equal(b.items.length, 7);
  const n = fresh();
  assert.equal(B.applyOps(n, ops).added, 10);
});

test('the agent\'s own to-do list maps onto the board and wins', () => {
  const b = fresh();
  B.applyOps(b, [{ op: 'add', section: 'later', text: 'Rebuild the tiled arm' }]);
  B.applyTodos(b, [
    { content: 'Rebuild the tiled arm', status: 'in_progress' },
    { content: 'Regenerate Figure 4', status: 'pending' },
    { content: 'Apply the red edits', status: 'completed' },
  ]);
  assert.equal(sec(b, 'Rebuild the tiled arm'), 'now');
  assert.equal(sec(b, 'Regenerate Figure 4'), 'next');
  assert.equal(sec(b, 'Apply the red edits'), 'done');
});

test('tick and untick restore the section', () => {
  const b = fresh();
  B.userEdit(b, { op: 'add', section: 'waiting', text: 'Decide 121 or 114' });
  const it = b.items[0];
  B.userEdit(b, { op: 'tick', itemId: it.id });
  assert.equal(it.section, 'done');
  B.userEdit(b, { op: 'untick', itemId: it.id });
  assert.equal(it.section, 'waiting');
});

test('reply parsing', () => {
  assert.deepEqual(B.parseReply('Here you go:\n{"ops":[{"op":"add","section":"next","text":"x"}]}\n'), [{ op: 'add', section: 'next', text: 'x' }]);
  assert.throws(() => B.parseReply('no json'));
  assert.throws(() => B.parseReply('{"nope":1}'));
});

test('excerpt reads only the new turns, finds commits, questions and the to-do list', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crewmon-board-')), 'c.jsonl');
  const rec = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(f, rec({ type: 'user', message: { role: 'user', content: 'old request, already synced' } }));
  const from = fs.statSync(f).size;
  fs.appendFileSync(f, rec({ type: 'user', message: { role: 'user', content: 'Please fix the checkout tests' } }) +
    rec({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fixing them now.' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git commit -m "Fix expiry test"', description: 'Commit' } },
      { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/x/a.js' } },
      { type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/x/b.js' } },
      { type: 'tool_use', id: 't4', name: 'AskUserQuestion', input: { questions: [{ question: 'Stripe or Adyen first?' }] } },
      { type: 'tool_use', id: 't5', name: 'TodoWrite', input: { todos: [{ content: 'Fix tests', status: 'completed' }] } }] } }));
  const ex = B.excerpt(f, from);
  assert.ok(!ex.text.includes('old request'));
  assert.ok(ex.text.includes('USER Please fix the checkout tests'));
  assert.ok(ex.text.includes('COMMIT Fix expiry test'));
  assert.ok(ex.text.includes('EDITED a.js, b.js'));
  assert.ok(ex.text.includes('ASKED YOU Stripe or Adyen first?'));
  assert.equal(ex.todos.length, 1);
  assert.equal(ex.end, fs.statSync(f).size);
});

test('due: idle, new turns, not too soon', () => {
  const b = Object.assign(fresh(), { syncedSize: 1000, lastTry: 0 });
  const s = { file: '/x', state: 'idle', size: 5000 };
  assert.equal(B.due(b, s, Date.now()), true);
  assert.equal(B.due(b, Object.assign({}, s, { state: 'busy' }), Date.now()), false);
  assert.equal(B.due(b, Object.assign({}, s, { size: 1100 }), Date.now()), false);
  assert.equal(B.due(Object.assign({}, b, { lastTry: Date.now() }), s, Date.now()), false);
  assert.equal(B.due(Object.assign({}, b, { tracked: false }), s, Date.now()), false);
});

test('save is atomic and all() reads boards back', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crewmon-home-'));
  const b = fresh(); B.userEdit(b, { op: 'vision', text: 'Ship 1.0' });
  B.save(b, home);
  assert.equal(B.all(home).s1.vision, 'Ship 1.0');
  assert.ok(!fs.existsSync(B.fileOf('s1', home) + '.tmp'));
});

test('background work: running, finished, failed, stopped, workflow, subagent, monitor', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crewmon-jobs-')), 'c.jsonl');
  const T = (m) => new Date(Date.now() - m * 60e3).toISOString();
  const use = (id, name, input, m) => ({ type: 'assistant', timestamp: T(m), message: { content: [{ type: 'tool_use', id, name, input }] } });
  const res = (id, text, m) => ({ type: 'user', timestamp: T(m), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
  const note = (use, task, status, summary, m) => ({ type: 'user', timestamp: T(m), message: { role: 'user', content:
    '<task-notification>\n<task-id>' + task + '</task-id>\n<tool-use-id>' + use + '</tool-use-id>\n' + (status ? '<status>' + status + '</status>\n' : '') + '<summary>' + summary + '</summary>\n</task-notification>' } });
  const recs = [
    use('u1', 'Bash', { command: 'python long.py', description: 'Run the long job', run_in_background: true }, 50), res('u1', 'Command running in background with ID: b1. Output…', 50),
    use('u2', 'Bash', { command: 'make', description: 'Build it', run_in_background: true }, 40), res('u2', 'Command running in background with ID: b2.', 40),
    note('u2', 'b2', 'completed', 'Background command "Build it" completed (exit code 0)', 30),
    use('u3', 'Bash', { command: 'pytest', description: 'Run tests', run_in_background: true }, 40), res('u3', 'Command running in background with ID: b3.', 40),
    note('u3', 'b3', 'failed', 'Background command "Run tests" failed with exit code 1', 35),
    use('u4', 'Bash', { command: 'sleep 999', description: 'Wait', run_in_background: true }, 20), res('u4', 'Command running in background with ID: b4.', 20),
    use('u5', 'TaskStop', { task_id: 'b4' }, 19), res('u5', '{"message":"Successfully stopped task: b4 (sleep 999)"}', 19),
    use('u6', 'Workflow', { script: "export const meta = { name: 'x', description: 'Verify the tables' }" }, 15), res('u6', 'Workflow launched in background. Task ID: w1\nSummary: Verify the tables', 15),
    use('u7', 'Agent', { description: 'Find the data', prompt: 'find', run_in_background: true }, 10), res('u7', [{ type: 'text', text: 'Async agent launched successfully.\nagentId: a1 (internal ID)' }], 10),
    note('u7', 'a1', 'completed', 'Agent "Find the data" finished', 5),
    use('u8', 'Agent', { description: 'Quick look', prompt: 'look' }, 9), res('u8', 'It is in data/', 8),
    use('u9', 'Monitor', { command: 'until …', description: 'Watch the log' }, 6), res('u9', 'Monitor started (task m1, expires in 30m…)', 6),
    note('u9', 'm1', '', 'stage 3 of 5 done', 2),
    use('u10', 'Bash', { command: 'ls', description: 'List' }, 1),
  ];
  fs.writeFileSync(f, recs.map(r => JSON.stringify(r)).join('\n') + '\n');
  const j = B.jobs(f);
  const st = (t) => { const x = j.running.concat(j.recent).find(y => y.title === t); return x && x.status; };
  assert.equal(st('Run the long job'), 'running');
  assert.equal(st('Build it'), 'completed');
  assert.equal(j.recent.find(y => y.title === 'Build it').result, 'completed (exit code 0)');
  assert.equal(st('Run tests'), 'failed');
  assert.equal(st('Wait'), 'stopped');
  assert.equal(st('Verify the tables'), 'running');
  assert.equal(st('Find the data'), 'completed');
  assert.equal(st('Quick look'), undefined);        // a subagent that ran while the agent waited is not background work
  assert.equal(st('List'), undefined);              // a normal command is not background work
  assert.equal(j.running.find(y => y.title === 'Watch the log').last, 'stage 3 of 5 done');
  assert.equal(j.running.length, 3);
  const off = B.jobs(f, { offline: true });
  assert.equal(off.running.find(y => y.title === 'Run the long job').status, 'unknown');
  const ex = B.excerpt(f, 0);
  assert.ok(ex.text.includes('FINISHED (failed) Background command "Run tests" failed with exit code 1'));
});
