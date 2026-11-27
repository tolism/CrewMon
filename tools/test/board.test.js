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
