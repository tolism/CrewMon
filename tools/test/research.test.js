// node --test tools/test/*.test.js   (part of tools/check.sh)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const R = require('../../research.js');

const fresh = () => R.empty('/home/dev/speech');
const launch = (cmd) => R.launches(cmd, '/home/dev/speech');

test('runs: real launches are found, reading and testing is not', () => {
  assert.equal(launch('cd /x; uv run python -m kws train configs/a.yaml --seed 3')[0].configs[0], 'a');
  assert.equal(launch('cd /x; uv run python -m kws train configs/a.yaml --seed 3')[0].seed, '3');
  assert.equal(launch('nohup bash scripts/queue/finetune.sh > logs/ft.log 2>&1 &')[0].detached, true);
  assert.equal(launch('nohup bash scripts/queue/finetune.sh > logs/ft.log 2>&1 &')[0].log, '/home/dev/speech/logs/ft.log');
  assert.equal(launch('torchrun --nproc_per_node 4 train.py --config cfg/base.yaml')[0].script, 'train.py');
  assert.equal(launch('python train_model.py --lr 0.1')[0].kind, 'python');
  assert.equal(launch('sbatch jobs/sweep.slurm')[0].kind, 'sbatch');
  assert.deepEqual(launch('for c in a b c; do .venv/bin/python -m kws run configs/$c.yaml; done')[0].configs, ['a', 'b', 'c']);
  assert.equal(launch('uv run python -m kws run configs/a.yaml --smoke')[0].smoke, true);
  for (const no of ['cat scripts/queue/x.sh', 'python -m pytest tests -q', 'uv run python -m kws --version', 'bash -n scripts/queue/x.sh',
    "python3 - <<'E'\nimport train\nE", 'python scripts/report.py --out results.json', "pkill -f 'queue/.*\\.sh'", 'grep -n train scripts/train.py',
    'git commit -m "train"', 'pip install torch'])
    assert.equal(launch(no).length, 0, no);
});

test('runs from a chat: status, background output, metrics', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewmon-rs-'));
  const out = path.join(dir, 'task.output');
  fs.writeFileSync(out, 'epoch 3/10 loss=0.52 val_acc=0.71\nepoch 4/10 loss=0.41 val_acc=0.78\n');
  const t = (s) => new Date(Date.UTC(2026, 10, 27, 10, s)).toISOString();
  const lines = [
    { type: 'assistant', timestamp: t(0), cwd: '/home/dev/speech', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a1', name: 'Bash', input: { command: 'uv run python -m kws train configs/base.yaml --seed 1', description: 'Train the baseline', run_in_background: true } }] } },
    { type: 'user', timestamp: t(0), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a1', content: 'Command running in background with ID: b1. Output is being written to: ' + out + '. You will be notified.' }] } },
    { type: 'assistant', timestamp: t(1), cwd: '/home/dev/speech', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_b2', name: 'Bash', input: { command: 'python eval.py --config configs/noise.yaml', description: 'Evaluate in noise' } }] } },
    { type: 'user', timestamp: t(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b2', content: 'test_acc: 0.842\ndone' }] } },
    { type: 'assistant', timestamp: t(3), cwd: '/home/dev/speech', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_c3', name: 'Bash', input: { command: 'python train.py --config configs/big.yaml', description: 'Train the big model' } }] } },
    { type: 'user', timestamp: t(4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c3', is_error: true, content: 'Exit code 1\nRuntimeError: CUDA out of memory' }] } },
    { type: 'assistant', timestamp: t(5), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_d4', name: 'Bash', input: { command: 'cat configs/big.yaml', description: 'Read config' } }] } },
  ];
  const file = path.join(dir, 'chat.jsonl');
  fs.writeFileSync(file, lines.map(x => JSON.stringify(x)).join('\n') + '\n');
  const rs = R.runs(file, { now: Date.UTC(2026, 10, 27, 10, 6) });
  assert.equal(rs.length, 3);
  const [big, noise, base] = rs;
  assert.equal(big.status, 'failed'); assert.match(big.last, /CUDA out of memory/);
  assert.equal(noise.status, 'completed'); assert.equal(noise.metrics.test_acc, 0.842);
  assert.equal(base.status, 'running'); assert.equal(base.metrics.val_acc, 0.78); assert.equal(base.epoch, '4/10'); assert.equal(base.id, 'r' + 'toolu_a1'.slice(-6));
  assert.equal(R.runs(file, { offline: true })[2].status, 'unknown');
  const ex = R.excerpt(file, 0);
  assert.match(ex.text, /RUN \[rolu_a1\] Train the baseline/);
  assert.doesNotMatch(ex.text, /Read config/);
});

test('metrics: names, splits, percent, last value wins', () => {
  const m = R.metrics('val_acc=0.70 loss: 1.2\n{"test_macro_f1": 0.66}\nTest accuracy: 91.5%\nval_acc=0.75').metrics;
  assert.equal(m.val_acc, 0.75); assert.equal(m.loss, 1.2); assert.equal(m.test_macro_f1, 0.66); assert.equal(m.test_accuracy, 0.915);
});

test('Haiku adds questions and experiments with refs, links runs; duplicates merge', () => {
  const r = fresh();
  const res = R.applyOps(r, [
    { op: 'question', ref: 'q1', text: 'Does pretraining beat training from scratch?', why: 'Labels are scarce.' },
    { op: 'experiment', ref: 'e1', q: 'q1', title: 'Contrastive pretraining then fine-tune', why: 'Tests pretraining.', data: ['Speech Commands'], models: ['Conformer-S'], status: 'running' },
    { op: 'link', run: 'rabc123', exp: 'e1' },
    { op: 'question', text: 'Does pretraining beat training from scratch?' },
  ], 'agentA', { rabc123: 'toolu_xyzabc123' });
  assert.deepEqual([res.added, res.linked], [2, 1]);
  assert.equal(r.questions.length, 1);
  const e = r.experiments[0];
  assert.equal(e.q, r.questions[0].id); assert.equal(e.status, 'running'); assert.deepEqual(e.agents, ['agentA']);
  assert.equal(r.links.toolu_xyzabc123.exp, e.id);
  R.applyOps(r, [{ op: 'link', run: 'rnope', exp: e.id }], 'agentA', { rabc123: 'toolu_xyzabc123' });
  assert.equal(Object.keys(r.links).length, 1, 'only runs that exist can be linked');
  R.applyOps(r, [{ op: 'experiment', q: r.questions[0].id, title: 'Contrastive pretraining then fine tune', result: '91.8 vs 88.9', metrics: { test_acc: '0.918' } }], 'agentB');
  assert.equal(r.experiments.length, 1, 'the same experiment in other words is an update');
  assert.equal(e.result, '91.8 vs 88.9'); assert.equal(e.metrics.test_acc, 0.918); assert.deepEqual(e.agents, ['agentA', 'agentB']);
});

test('your fields stay yours; reasons are written once; verdict needs evidence', () => {
  const r = fresh();
  R.applyOps(r, [{ op: 'experiment', ref: 'e1', title: 'Noise augmentation', why: 'First reason.', status: 'running' }], 'a');
  const e = r.experiments[0];
  R.applyOps(r, [{ op: 'update', id: e.id, why: 'Another reason.' }], 'a');
  assert.equal(e.why, 'First reason.');
  R.userEdit(r, { op: 'set', kind: 'e', id: e.id, field: 'status', value: 'dropped' });
  R.userEdit(r, { op: 'set', kind: 'e', id: e.id, field: 'result', value: 'My reading of it.' });
  R.applyOps(r, [{ op: 'update', id: e.id, status: 'done', result: 'Haiku reading.' }], 'a');
  assert.equal(e.status, 'dropped'); assert.equal(e.result, 'My reading of it.');
  R.applyOps(r, [{ op: 'update', id: e.id, verdict: 'supports' }], 'a');
  assert.equal(e.verdict, 'supports'); assert.equal(e.vprobable, true);
  R.applyOps(r, [{ op: 'update', id: e.id, verdict: 'refutes', evidence: 'run r1 eval table' }], 'a');
  assert.equal(e.vprobable, false);
});

test('deleted items never come back; deleting a question keeps its experiments', () => {
  const r = fresh();
  R.applyOps(r, [{ op: 'question', ref: 'q', text: 'Is the model robust at 0 dB noise?' }, { op: 'experiment', q: 'q', title: 'Evaluate at 0 dB' }], 'a');
  R.userEdit(r, { op: 'delete', kind: 'q', id: r.questions[0].id });
  assert.equal(r.questions.length, 0); assert.equal(r.experiments[0].q, '');
  R.applyOps(r, [{ op: 'question', text: 'Is the model robust at 0 dB noise?' }], 'a');
  assert.equal(r.questions.length, 0);
  R.userEdit(r, { op: 'delete', kind: 'e', id: r.experiments[0].id });
  R.applyOps(r, [{ op: 'experiment', title: 'Evaluate at 0 dB' }], 'a');
  assert.equal(r.experiments.length, 0);
});

test('a link you set is never changed by the sync', () => {
  const r = fresh();
  R.applyOps(r, [{ op: 'experiment', ref: 'a', title: 'Experiment A' }, { op: 'experiment', ref: 'b', title: 'Totally different B' }], 'x');
  const [a, b] = r.experiments;
  R.userEdit(r, { op: 'link', run: 'toolu_1', exp: a.id });
  R.applyOps(r, [{ op: 'link', run: 'r1', exp: b.id }], 'x', { r1: 'toolu_1' });
  assert.equal(r.links.toolu_1.exp, a.id);
});

test('artifacts: table marks the best, chart and notes come from the log only', () => {
  const r = fresh();
  R.applyOps(r, [{ op: 'question', ref: 'q', text: 'Does pretraining help?' },
    { op: 'experiment', q: 'q', title: 'Pretrained', status: 'done', metrics: { test_acc: 0.918, loss: 0.3 }, result: 'better' },
    { op: 'experiment', q: 'q', title: 'From scratch', status: 'done', metrics: { test_acc: 0.889, loss: 0.2 } }], 'a');
  const t = R.tableMarkdown(r, []);
  assert.match(t, /\| Pretrained \| done .*\*\*0\.918\*\*/);
  assert.match(t, /\| From scratch \| done .*\*\*0\.2\*\*/, 'lower loss is better');
  R.applyOps(r, [{ op: 'experiment', q: r.questions[0].id, title: 'Only one with this number', metrics: { f1: 0.5 } }], 'a');
  assert.doesNotMatch(R.tableMarkdown(r, []), /\*\*0\.5\*\*/, 'nothing to compare: not bold');
  const svg = R.chartSVG(r, [], 'test_acc');
  assert.ok(svg.indexOf('Pretrained') < svg.indexOf('From scratch'), 'best first');
  assert.match(R.notesMarkdown(r, []), /### Pretrained {2}\[done\]/);
  assert.match(R.writeupPrompt(r, []), /Use only facts/);
});

test('storage round trip and project keys', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crewmon-rs-home-'));
  const r = fresh(); R.userEdit(r, { op: 'addQuestion', text: 'Q?' }); R.save(r, home);
  assert.equal(R.load(r.key, home).questions[0].text, 'Q?');
  assert.equal(Object.keys(R.all(home)).length, 1);
  assert.notEqual(R.keyOf('/a/speech'), R.keyOf('/b/speech'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crewmon-rs-repo-')); fs.mkdirSync(path.join(repo, '.git')); fs.mkdirSync(path.join(repo, 'paper'));
  assert.equal(R.projectRoot(path.join(repo, 'paper')), repo);
});

test('memory: what you add is written as Claude Code memory, read back with its kind, edited and deleted cleanly', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crewmon-mem-'));
  const dir = R.memoryDirOf('/home/dev/speech.v2', home);
  assert.match(dir, /-home-dev-speech-v2[/\\]memory$/);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '- [Old](old.md) — kept\n');
  fs.writeFileSync(path.join(dir, 'old.md'), '---\nname: old\ndescription: An agent wrote this rule\nmetadata:\n  type: feedback\n---\n\nRule text.\n');
  const rule = R.writeMemory(dir, 'behavior', 'Always report the mean of 3 seeds. With the spread.');
  const run = R.writeMemory(dir, 'run', 'Cluster run masked v2 seed 7: test_acc=0.774');
  const idea = R.writeMemory(dir, 'idea', 'Try 10 s windows');
  assert.ok(R.writeMemory(dir, 'behavior', 'Always report the mean of 3 seeds. Again.').endsWith('-2.md'), 'no file is overwritten');
  const idx = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
  assert.match(idx, /^- \[Old\]\(old\.md\) — kept\n- \[Behavior: Always report the mean of 3 seeds\. With the spread\]\(always-report-the-mean-of-3\.md\) — Always report the mean of 3 seeds\./);
  assert.match(fs.readFileSync(rule, 'utf8'), /type: feedback\n {2}crewmon: behavior/);
  const mem = R.readMemory([dir, dir]);
  assert.equal(mem.length, 5);
  assert.equal(mem.find(m => m.name === 'old').kind, 'behavior', 'feedback memories are behaviors');
  assert.equal(mem.find(m => m.file === idea).kind, 'idea');
  const mr = R.memoryRun(mem.find(m => m.file === run));
  assert.equal(mr.metrics.test_acc, 0.774); assert.equal(mr.manual, true); assert.match(mr.use, /^mem:/);
  R.editMemory(rule, 'Always report the mean of 5 seeds.');
  assert.match(fs.readFileSync(rule, 'utf8'), /description: Always report the mean of 5 seeds\.\n[\s\S]*\n\nAlways report the mean of 5 seeds\./);
  assert.match(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), /5 seeds/);
  assert.throws(() => R.editMemory(path.join(dir, 'old.md'), 'x'), /not written by CrewMon/);
  R.deleteMemory(idea);
  assert.equal(fs.existsSync(idea), false);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), /try-10-s-windows/);
  assert.throws(() => R.deleteMemory(path.join(dir, 'MEMORY.md')));
  const r = fresh(); R.userEdit(r, { op: 'ideaToExperiment', name: 'try-10-s-windows', title: 'Try 10 s windows' });
  assert.equal(r.experiments[0].status, 'planned'); assert.equal(r.ideas['try-10-s-windows'], r.experiments[0].id);
});
