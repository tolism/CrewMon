// CrewMon messenger: runs inside a background Claude Code session (tmux "crewmon-messenger").
// It never uses its model: it only forwards requests that CrewMon writes and records the replies.
//
//   outbox.jsonl  (CrewMon -> here)  one request per line:
//     { rid, kind: 'message', to, text }
//     { rid, kind: 'ask',     from, to, fromTitle, toTitle, text }      B answers, the answer goes to A too
//     { rid, kind: 'talk',    a, b, aTitle, bTitle, text, rounds }      A and B take turns through here
//     { rid, kind: 'handover',from, to, fromTitle, toTitle, file }      A writes a note, then B continues
//   inbox.jsonl   (here -> CrewMon)  { at, rid, kind: 'sent'|'reply'|'error'|'done', session?, text? }
//   active.json   the conversations in progress (for the arrows on the map)
//   heartbeat     touched every few seconds while this runs
import type { Register } from 'claude-code'

// CrewMon starts this session inside ~/.claude/crewmon/messenger, so the files are relative to it.
const DIR = '.'
const OUTBOX = DIR + '/outbox.jsonl'
const INBOX = DIR + '/inbox.jsonl'
const ACTIVE = DIR + '/active.json'
const BEAT = DIR + '/heartbeat'
const KEEP_INBOX = 400            // lines kept in the inbox

type Job = {
  rid: string; kind: string; to?: string; from?: string; a?: string; b?: string; text?: string
  fromTitle?: string; toTitle?: string; aTitle?: string; bTitle?: string; file?: string
  rounds?: number; turn?: number; waiting?: string; step?: string; transcript?: string[]
}

let offset = -1
let busy = false
let loaded = false
let jobs: Record<string, Job> = {}
const tag = (rid: string) => `[CrewMon ${rid}]`
const replyHint = (rid: string) =>
  `\n\n(Sent through CrewMon. Reply with SendMessage to the sender of this message, and start your reply with ${tag(rid)}.)`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tools($: any) {
    const save = async () => {
      await $.store.set('state', { offset, jobs })
      const active = Object.values(jobs).map(j => ({ rid: j.rid, kind: j.kind, a: j.a ?? j.from, b: j.b ?? j.to, waiting: j.waiting, turn: j.turn ?? 0, rounds: j.rounds ?? 0 }))
      await $.fs.write(ACTIVE, JSON.stringify(active))
    }
    const log = async (entry: Record<string, unknown>) => {
      let old = ''
      try { old = String(await $.fs.read(INBOX)) } catch { /* first entry */ }
      const lines = (old + JSON.stringify({ at: Date.now(), ...entry }) + '\n').split('\n').filter(Boolean)
      await $.fs.write(INBOX, lines.slice(-KEEP_INBOX).join('\n') + '\n')
    }
    const send = async (rid: string, sessionId: string, text: string) => {
      try {
        await $.session.send({ to: { sessionId }, text: text + replyHint(rid) })
        await log({ rid, kind: 'sent', session: sessionId })
        return true
      } catch (err) {
        await log({ rid, kind: 'error', session: sessionId, text: String((err as Error)?.message ?? err) })
        return false
      }
    }

    // a new request from CrewMon
    const start = async (j: Job) => {
      if (j.kind === 'message' && j.to) {
        await send(j.rid, j.to, j.text ?? '')
        jobs[j.rid] = { ...j, waiting: j.to }
      } else if (j.kind === 'ask' && j.from && j.to) {
        jobs[j.rid] = { ...j, waiting: j.to }
        await send(j.rid, j.to, `The agent "${j.fromTitle}" asks you: ${j.text}`)
      } else if (j.kind === 'talk' && j.a && j.b) {
        jobs[j.rid] = { ...j, turn: 1, waiting: j.a, transcript: [] }
        await send(j.rid, j.a, `CrewMon is starting a short discussion between you and the agent "${j.bTitle}" ` +
          `(${j.rounds} turns each, at most 150 words per turn). Topic: ${j.text}\nGive your opening view.`)
      } else if (j.kind === 'handover' && j.from && j.to) {
        jobs[j.rid] = { ...j, step: 'note', waiting: j.from }
        await send(j.rid, j.from, `Please write a hand-over note for another agent ("${j.toTitle}") who will continue ` +
          `part of your work. Save it as Markdown to ${j.file}. Include: the goal; what is done; key decisions and why; ` +
          `where things are (files, commands, data); open problems; and the exact next steps. When it is saved, reply "hand-over ready".`)
      }
      await save()
    }

    // a reply from one of the sessions
    const onReply = async (j: Job, text: string) => {
      const body = text.replace(/^[\s\S]*?\[CrewMon [a-z0-9]+\]\s*/i, '').trim()
      await log({ rid: j.rid, kind: 'reply', session: j.waiting, text: body })
      if (j.kind === 'message') { delete jobs[j.rid] }
      else if (j.kind === 'ask') {
        await send(j.rid, j.from!, `Answer from the agent "${j.toTitle}" to the question "${j.text}": ${body}`)
        await log({ rid: j.rid, kind: 'done' }); delete jobs[j.rid]
      } else if (j.kind === 'talk') {
        const speaker = j.waiting === j.a ? j.aTitle : j.bTitle
        j.transcript = [...(j.transcript ?? []), `${speaker}: ${body}`]
        const fromA = j.waiting === j.a
        if (!fromA) j.turn = (j.turn ?? 1) + 1
        if (j.turn! > (j.rounds ?? 2)) {
          j.waiting = j.a
          j.step = 'summary'
          await send(j.rid, j.a!, `The discussion with "${j.bTitle}" is over. Here it is:\n\n${j.transcript.join('\n\n')}\n\n` +
            `Summarise the outcome in at most 5 lines (agreements, disagreements, next steps).`)
        } else {
          const next = fromA ? j.b! : j.a!
          const other = fromA ? j.aTitle : j.bTitle
          j.waiting = next
          await send(j.rid, next, `"${other}" says (topic: ${j.text}):\n\n${body}\n\nReply in at most 150 words.`)
        }
        if (j.step === 'summary' && !fromA) { /* waiting for A's summary */ }
      } else if (j.kind === 'handover') {
        if (j.step === 'note') {
          j.step = 'continue'; j.waiting = j.to
          await send(j.rid, j.to!, `Read the hand-over note at ${j.file} from the agent "${j.fromTitle}" and continue from it. ` +
            `First reply with 2-3 lines on what you are taking over and what you will do next.`)
        } else { await log({ rid: j.rid, kind: 'done' }); delete jobs[j.rid] }
      }
      await save()
    }
    // a talk ends with A's summary
    const finishTalk = async (j: Job, text: string) => {
      const body = text.replace(/^[\s\S]*?\[CrewMon [a-z0-9]+\]\s*/i, '').trim()
      await log({ rid: j.rid, kind: 'reply', session: j.a, text: body })
      await log({ rid: j.rid, kind: 'done' })
      delete jobs[j.rid]
      await save()
    }
    return { save, log, start, onReply, finishTalk }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function load($: any) {
  if (loaded) return
  const saved = (await $.store.get('state')) as { offset?: number; jobs?: Record<string, Job> } | undefined
  offset = saved?.offset ?? -1
  jobs = saved?.jobs ?? {}
  loaded = true
}

export const register: Register = (on) => {
    on('session.receive', async ($, e, next) => {
      const k = (e.origin as { kind: string }).kind
      if (k !== 'peer' && k !== 'peer-send-message') return next(e)
      await load($)
      const { log, onReply, finishTalk } = tools($)
      const m = /\[CrewMon ([a-z0-9]+)\]/i.exec(e.text)
      const j = m && m[1] ? jobs[m[1]] : undefined
      if (!j) {   // not one of ours: keep it out of this session's model all the same
        await log({ kind: 'reply', text: e.text.slice(0, 2000) })
        return { consumed: 'crewmon: unmatched message logged' }
      }
      if (j.kind === 'talk' && j.step === 'summary') await finishTalk(j, e.text)
      else await onReply(j, e.text)
      return { consumed: 'crewmon: reply recorded' }
    }).catch(($, e, next) => (next.called ? next(e) : next(e)))

  on('session.start', async ($, e, next) => {
    const out = await next(e)
    await load($)
    const { save, log, start } = tools($)
    $.clock.every(1500, async () => {
      if (busy) return
      busy = true
      try {
        const st = await $.fs.stat(OUTBOX).catch(() => undefined)
        if (st) {
          if (offset < 0 || offset > st.size) offset = st.size     // first run: skip what was there before
          if (st.size > offset) {
            const added = String(await $.fs.read(OUTBOX, { offset, length: st.size - offset }))
            offset = st.size
            for (const line of added.split('\n')) {
              if (!line.trim()) continue
              try { await start(JSON.parse(line) as Job) } catch (err) { await log({ kind: 'error', text: 'bad request: ' + String(err) }) }
            }
            await save()
          }
        }
      } finally { busy = false }
    })
    $.clock.every(4000, () => { void $.fs.write(BEAT, String(Date.now())) })
    return out
  })
}
