// Tests the messenger (messenger/hooks/register.ts) and delivery.js with everything around them simulated: no Claude, no tmux.
//   node --experimental-strip-types tools/test-messenger.mjs      needs Node 22.6 or newer (it runs the TypeScript file as it is)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { pendingRequests } = createRequire(import.meta.url)(path.join(root, 'delivery.js'))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crewmon-test-'))
let n = 0, failed = 0
const check = (name, ok) => { n++; if (!ok) { failed++; console.log('FAIL ' + name) } }

// one messenger run on simulated files and store; a second boot on the same ones = a restart
async function boot(files = {}, store = {}) {
  const copy = path.join(tmp, 'register' + Math.random().toString(36).slice(2) + '.mts')
  fs.copyFileSync(path.join(root, 'messenger', 'hooks', 'register.ts'), copy)
  const { register } = await import(pathToFileURL(copy).href)
  fs.unlinkSync(copy)
  const sent = [], timers = [], hooks = {}, mtime = {}
  const need = (p) => { if (!(p in files)) throw new Error('ENOENT: ' + p) }
  const $ = {
    store: { get: async k => store[k], set: async (k, v) => { store[k] = structuredClone(v) } },
    fs: {
      exists: async p => p in files,
      read: async (p, o) => { need(p); const b = Buffer.from(files[p]); return (o && o.length != null ? b.subarray(o.offset, o.offset + o.length) : b).toString() },
      write: async (p, t) => { files[p] = t },
      stat: async p => { need(p); return { size: Buffer.byteLength(files[p]), mtimeMs: mtime[p] ?? 0 } },
    },
    session: { send: async m => { sent.push({ to: m.to.sessionId, text: m.text }) } },
    clock: { every: (ms, f) => { timers.push({ ms, f }) } }, tool: { call: async () => ({}) },
  }
  register((name, f) => { hooks[name] = f; return { catch() {} } })
  await hooks['session.start']($, {}, async () => ({}))
  return {
    files, store, sent, mtime, poll: timers.find(t => t.ms === 1500).f,
    put: (...jobs) => { for (const j of jobs) files['./outbox.jsonl'] = (files['./outbox.jsonl'] || '') + JSON.stringify(j) + '\n' },
    reply: (rid, t) => hooks['session.receive']($, { origin: { kind: 'peer' }, text: `<cross-session-message from="x">\n[CrewMon ${rid}] ${t}\n</cross-session-message>` }, async () => ({})),
    inbox: (rid) => (files['./inbox.jsonl'] || '').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => !rid || x.rid === rid),
    job: (rid) => store.state.jobs[rid],
  }
}
const NOTE = '/x/note.md'
const ho = (rid, more = {}) => ({ rid, at: 1, kind: 'handover', from: 'A', to: 'B', fromTitle: 'Aa', toTitle: 'Bb', file: NOTE, textA: 'go, {B}', textB: 'continue', approve: true, ...more })
const msg = (rid) => ({ rid, at: 1, kind: 'message', to: 'A', text: 'hi' })
let m

// ---- picking up requests ----
m = await boot(); await m.poll(); m.put(ho('a1')); await m.poll()
check('the first request ever is sent', m.sent.length === 1 && m.sent[0].to === 'A')
check('A gets the path of the note though {NOTE} was edited out', !!m.sent[0]?.text.includes(NOTE))
m = await boot(); m.put(ho('a2')); await m.poll(); await m.poll()
check('a request written before the first look is sent, once', m.sent.length === 1)
m = await boot({ './outbox.jsonl': JSON.stringify(ho('a3')) + '\n' }); await m.poll()
check('first run: what was there before is not sent', m.sent.length === 0)
m.put(ho('a4')); await m.poll()
check('first run: what comes next is sent', m.sent.length === 1 && m.sent[0].text.includes('a4'))
m = await boot({ './outbox.jsonl': '12345' }, { state: { offset: 5, jobs: {} } }); m.put(ho('a5')); await m.poll()
check('a restart goes on where it was', m.sent.length === 1)
m = await boot({}, { state: { offset: 815, jobs: {} } }); m.put(ho('a6')); await m.poll()
check('outbox deleted: the next request is sent', m.sent.length === 1)
m = await boot(); m.put({ ...msg('a7'), text: 'ÅΩ→' }); await m.poll(); m.put(msg('a8')); await m.poll()
check('text that is not ASCII does not shift the position', m.sent.length === 2 && m.sent[1].text.includes('a8'))

// ---- sent again, discarded ----
m = await boot(); m.put(msg('b1')); await m.poll(); m.put(msg('b1')); await m.poll()
check('the same request again is not sent twice', m.sent.length === 1)
await m.reply('b1', 'ok'); m.put(msg('b1')); await m.poll()
check('... nor after it was answered', m.sent.length === 1)
{ const r = await boot(m.files, m.store); r.put(msg('b1')); await r.poll(); check('... nor after a restart', r.sent.length === 0) }
m = await boot(); m.put(msg('b2'), { rid: 'b2', kind: 'cancel' }, msg('b3')); await m.poll()
check('discarded before it was picked up: not sent, the next one is', m.sent.length === 1 && m.sent[0].text.includes('b3'))
check('... and recorded as cancelled', m.inbox('b2').map(x => x.kind).join() === 'cancelled')
m = await boot(); m.put(ho('b4')); await m.poll(); m.put({ rid: 'b4', kind: 'resend' }); await m.poll()
check('Retry sends the last step again', m.sent.length === 2 && m.sent[1].text === m.sent[0].text)

// ---- hand-over ----
m = await boot({ [NOTE]: 'note' }); m.put(ho('c1', { textA: 'save to {NOTE}', textB: 'read {NOTE}' })); await m.poll()
check('default wording: the path appears once', m.sent[0].text.split(NOTE).length === 2)
await m.reply('c1', 'hand-over ready')
check('a reply has no wrapper left', m.inbox('c1').find(x => x.kind === 'reply').text === 'hand-over ready')
check('it waits for your check', m.sent.length === 1 && m.job('c1').step === 'review')
m.put({ rid: 'c1', kind: 'approve' }); await m.poll()
check('after approval B is told, with the path once', m.sent.length === 2 && m.sent[1].to === 'B' && m.sent[1].text.split(NOTE).length === 2)
await m.reply('c1', 'taking over')
check('it ends when B answers', !m.job('c1') && m.inbox('c1').at(-1).kind === 'done')
m = await boot(); m.put(ho('c2')); await m.poll(); await m.reply('c2', 'later'); await m.poll()
check('an answer without a note: goes on waiting for A', m.job('c2').step === 'note' && m.job('c2').waiting === 'A')
check('... and the map is told', JSON.parse(m.files['./active.json'])[0].replied === true)
m.files[NOTE] = 'half'; m.mtime[NOTE] = Date.now(); await m.poll()
check('a note still being written is not taken', m.job('c2').step === 'note')
m.mtime[NOTE] = Date.now() - 5000; await m.poll(); await m.poll()
check('saved later: ready for your check, announced once', m.job('c2').step === 'review' && m.inbox('c2').filter(x => x.kind === 'note-ready').length === 1)
m = await boot(); m.put(ho('c3')); await m.poll(); await m.reply('c3', 'later'); m.put({ rid: 'c3', kind: 'cancel' }); await m.poll(); m.files[NOTE] = 'n'; await m.poll()
check('cancelled: a later note does nothing', !m.job('c3') && m.sent.length === 1)
m = await boot(); m.put(ho('c4', { approve: false })); await m.poll(); await m.reply('c4', 'later'); m.files[NOTE] = 'n'; await m.poll(); await m.poll()
check('without your check: B is told once when it is saved', m.sent.length === 2 && m.sent[1].to === 'B')

// ---- ask, talk ----
m = await boot(); m.put({ rid: 'd1', kind: 'ask', from: 'A', to: 'B', fromTitle: 'Aa', toTitle: 'Bb', text: 'why?' }); await m.poll(); await m.reply('d1', 'because')
check('ask: the answer goes to A', m.sent.length === 2 && m.sent[1].to === 'A' && m.sent[1].text.includes('because') && !m.job('d1'))
m = await boot(); m.put({ rid: 'd2', kind: 'talk', a: 'A', b: 'B', aTitle: 'Aa', bTitle: 'Bb', text: 'topic', rounds: 1 }); await m.poll()
await m.reply('d2', 'one'); await m.reply('d2', 'two'); await m.reply('d2', 'summary')
check('talk: A, B, then A sums up', m.sent.map(x => x.to).join('') === 'ABA' && !m.job('d2') && m.inbox('d2').at(-1).kind === 'done')

// ---- requests not picked up (delivery.js) ----
const now = 1e12, late = (o, i = [], a = [], keep) => pendingRequests(o, i, a, now, keep).map(x => x.rid).join()
const req = (rid, ago, kind = 'handover') => ({ rid, kind, at: now - ago })
check('late after 10 s', late([req('e1', 12000), req('e2', 5000)]) === 'e1')
check('not once the messenger recorded it', late([req('e1', 12000)], [{ at: now, rid: 'e1', kind: 'sent' }]) === '')
check('not while it is in progress', late([req('e1', 12000)], [], [{ rid: 'e1' }]) === '')
check('an error counts as picked up', late([req('e1', 12000)], [{ at: now, rid: 'e1', kind: 'error' }]) === '')
check('not after Discard', late([req('e1', 12000), { rid: 'e1', kind: 'cancel', at: now }]) === '')
check('sent again: counted from then, listed once', late([req('e1', 60000), req('e1', 5000)]) === '' && late([req('e1', 60000), req('e1', 11000)]) === 'e1')
check('not older than a day', late([req('e1', 25 * 3600e3)]) === '')
check('not without a time (written by an older CrewMon)', late([{ rid: 'e1', kind: 'handover' }]) === '')
check('not before a full inbox begins', late([req('e1', 60000)], [{ at: now - 1000, rid: 'z' }], [], 1) === '')
check('Drive and control requests are not watched', late([req('e1', 60000, 'drive-list'), req('e2', 60000, 'resend'), req('e3', 60000, 'approve')]) === '')

fs.rmdirSync(tmp)
console.log(failed ? `${failed} of ${n} messenger tests failed` : `${n} messenger tests passed`)
process.exit(failed ? 1 : 0)
