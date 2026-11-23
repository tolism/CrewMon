// CrewMon messenger: runs inside a background Claude Code session (tmux "crewmon-messenger").
// It never uses its model: it only forwards requests that CrewMon writes and records the replies.
//
//   outbox.jsonl  (CrewMon -> here)  one request per line:
//     { rid, kind: 'message',  to, text }
//     { rid, kind: 'ask',      from, to, fromTitle, toTitle, text }      B answers, the answer goes to A too
//     { rid, kind: 'talk',     a, b, aTitle, bTitle, text, rounds }      A and B take turns through here
//     { rid, kind: 'handover', from, to, fromTitle, toTitle, file, textA?, textB?, approve? }
//                                         A writes a note; with approve, CrewMon shows it before B is told
//     { rid, kind: 'resend' }   send the last request of conversation rid again (its agent restarted)
//     { rid, kind: 'cancel' }   end conversation rid
//     { rid, kind: 'approve', zip? }  the note was checked: tell B to continue (or, for a Drive hand-over, upload it)
//   Google Drive (through the account's Google Drive connector; folder "CrewMon hand-overs"):
//     { rid, kind: 'drive-upload', file, title, description, zip? }   upload a note as a Google Doc (+ '<title> (files).zip')
//     { rid, kind: 'drive-list' }                               list the folder -> drive.json
//     { rid, kind: 'drive-read', id?, zipId?, title }           download a note -> handovers/drive-<id>.md, a zip -> .zip.b64
//     { rid, kind: 'drive-mark', id, text }                     set the Doc's description ("picked up by ...")
//   inbox.jsonl   (here -> CrewMon)  { at, rid, kind: 'sent'|'reply'|'error'|'done'|'resent'|'cancelled'|'note-ready', session?, text? }
//   active.json   the conversations in progress (arrows and Retry/Cancel on the map)
//   heartbeat     touched every few seconds while this runs
import type { Register } from 'claude-code'

// CrewMon starts this session inside ~/.claude/crewmon/messenger, so the files are relative to it.
const DIR = '.'
const OUTBOX = DIR + '/outbox.jsonl'
const INBOX = DIR + '/inbox.jsonl'
const ACTIVE = DIR + '/active.json'
const BEAT = DIR + '/heartbeat'
const KEEP_INBOX = 400            // lines kept in the inbox
const MOD_VERSION = '0.9.3'      // set by build_vsix.py to the extension version

type Job = {
  rid: string; kind: string; to?: string; from?: string; a?: string; b?: string; text?: string
  fromTitle?: string; toTitle?: string; aTitle?: string; bTitle?: string; file?: string
  textA?: string; textB?: string; approve?: boolean; dest?: string; description?: string; id?: string; title?: string
  zip?: string; zipId?: string; zipTitle?: string
  rounds?: number; turn?: number; waiting?: string; step?: string; transcript?: string[]
  replied?: boolean; lastTo?: string; lastText?: string; sentAt?: number
}

let offset = -1
let busy = false
let loaded = false
let jobs: Record<string, Job> = {}
let seen: string[] = []           // the last requests started: the same one sent again is ignored
const KEEP_SEEN = 300
const tag = (rid: string) => `[CrewMon ${rid}]`
const replyHint = (rid: string) =>
  `\n\n(Sent through CrewMon. Reply with SendMessage to the sender of this message, and start your reply with ${tag(rid)}.)`
const fill = (t: string, j: Job) => t.replace(/\{NOTE\}/g, j.file ?? '').replace(/\{A\}/g, j.fromTitle ?? '').replace(/\{B\}/g, j.toTitle ?? '')

const DEFAULT_A = 'Please write a hand-over note for another agent ("{B}") who will continue part of your work. ' +
  'Save it as Markdown to {NOTE}. Include: the goal; what is done; key decisions and why; where things are ' +
  '(files, commands, data); open problems; and the exact next steps. When it is saved, reply "hand-over ready".'
const DEFAULT_B = 'Read the hand-over note at {NOTE} from the agent "{A}" and continue from it. ' +
  'First reply with 2-3 lines on what you are taking over and what you will do next.'

// The wording can be edited in CrewMon: both agents are told where the note is even if {NOTE} was left out
const withNote = (t: string, j: Job, how: string) => !j.file || t.includes(j.file) ? t : t + '\n\n' + how.replace('{NOTE}', j.file)
const noteRequest = (j: Job) => withNote(fill(j.textA || DEFAULT_A, j), j, 'Save the note as Markdown to {NOTE}. When it is saved, reply "hand-over ready".')
const continueRequest = (j: Job) => withNote(fill(j.textB || DEFAULT_B, j), j, 'The hand-over note is at {NOTE}.')
// what an agent wrote, without our tag and the wrapper around messages between sessions
const bodyOf = (text: string) => text.replace(/^[\s\S]*?\[CrewMon [a-z0-9]+\]\s*/i, '').replace(/\s*<\/cross-session-message>\s*$/i, '').trim()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tools($: any) {
  const save = async () => {
    await $.store.set('state', { offset, jobs, seen })
    const active = Object.values(jobs).map(j => ({
      rid: j.rid, kind: j.kind, a: j.a ?? j.from, b: j.b ?? j.to, waiting: j.waiting, step: j.step ?? '',
      turn: j.turn ?? 0, replied: !!j.replied, rounds: j.rounds ?? 0, sentAt: j.sentAt ?? 0, file: j.file ?? '',
      aTitle: j.aTitle ?? j.fromTitle ?? '', bTitle: j.bTitle ?? j.toTitle ?? '',
    }))
    await $.fs.write(ACTIVE, JSON.stringify(active))
  }
  const log = async (entry: Record<string, unknown>) => {
    let old = ''
    try { old = String(await $.fs.read(INBOX)) } catch { /* first entry */ }
    const lines = (old + JSON.stringify({ at: Date.now(), ...entry }) + '\n').split('\n').filter(Boolean)
    await $.fs.write(INBOX, lines.slice(-KEEP_INBOX).join('\n') + '\n')
  }
  // send one step of a conversation; remembered so that it can be resent
  const send = async (j: Job, sessionId: string, text: string, kind = 'sent') => {
    j.lastTo = sessionId; j.lastText = text; j.sentAt = Date.now()
    try {
      await $.session.send({ to: { sessionId }, text: text + replyHint(j.rid) })
      await log({ rid: j.rid, kind, session: sessionId, text })
      return true
    } catch (err) {
      await log({ rid: j.rid, kind: 'error', session: sessionId, text: String((err as Error)?.message ?? err) })
      return false
    }
  }

  // ---- Google Drive ----
  const DRIVE = 'claude.ai Google Drive', FOLDER = 'CrewMon hand-overs'
  const parse = (r: { content?: { type: string; text?: string }[]; isError?: boolean }) => {
    const text = (r.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n')
    if (r.isError) throw new Error(text.slice(0, 300) || 'the Drive call failed')
    try { return JSON.parse(text) } catch { return { text } }
  }
  // A downloaded file's bytes, base64: in a resource block (blob), an image/audio block (data), or the JSON text
  const blobOf = (r: { content?: Record<string, unknown>[]; isError?: boolean }): string => {
    for (const b of r.content ?? []) {
      const res = b.resource as { blob?: string } | undefined
      if (res?.blob) return res.blob
      if (typeof b.data === 'string' && b.data) return b.data as string
    }
    const j = parse(r as { content?: { type: string; text?: string }[]; isError?: boolean })
    const c = j.content ?? j.base64Content ?? j.data
    if (typeof c === 'string' && /^[A-Za-z0-9+/=\s]+$/.test(c) && c.length > 8) return c
    throw new Error('Drive returned no file bytes')
  }
  const ZIP_SUFFIX = ' (files).zip'
  const folderId = async (): Promise<string> => {
    const saved = (await $.store.get('driveFolder')) as string | undefined
    if (saved) return saved
    const found = parse(await $.mcp.call(DRIVE, 'search_files', {
      query: `title = '${FOLDER}' and mimeType = 'application/vnd.google-apps.folder' and owner = 'me' and trashed = false`,
      excludeContentSnippets: true, pageSize: 5 }))
    const files = found.files ?? found.items ?? []
    let id = files[0]?.id
    if (!id) {
      const made = parse(await $.mcp.call(DRIVE, 'create_file', { title: FOLDER, contentMimeType: 'application/vnd.google-apps.folder' }))
      id = made.id
    }
    if (!id) throw new Error('could not find or create the Drive folder "' + FOLDER + '"')
    await $.store.set('driveFolder', id)
    return id
  }
  const docUrl = (f: { id?: string; viewUrl?: string; webViewLink?: string; alternateLink?: string; url?: string }) =>
    f.viewUrl ?? f.webViewLink ?? f.alternateLink ?? f.url ?? (f.id ? 'https://docs.google.com/document/d/' + f.id + '/edit' : '')
  const drive = async (req: Job) => {
    try {
      if (req.kind === 'drive-upload') {
        let text = String(await $.fs.read(req.file!))
        let zip: { id: string; title: string; url: string } | undefined
        if (req.zip) {      // the attached files go up first, so the note can link to them
          const { base64 } = await $.fs.read(req.zip, { as: 'bytes' }) as { base64: string }
          const zt = req.title + ZIP_SUFFIX
          const z = parse(await $.mcp.call(DRIVE, 'create_file', { title: zt, base64Content: base64, contentMimeType: 'application/zip',
            disableConversionToGoogleType: true, parentId: await folderId() }))
          if (!z.id) throw new Error('Drive did not return an id for the zip: ' + JSON.stringify(z).slice(0, 300))
          zip = { id: z.id, title: zt, url: docUrl(z) }
          text = `> **Files for this hand-over:** "${zt}", in the same Google Drive folder (${zip.url}). Download it and unzip it next to your work.\n\n` + text
        }
        const made = parse(await $.mcp.call(DRIVE, 'create_file', {
          title: req.title, textContent: text, contentMimeType: 'text/markdown', parentId: await folderId() }))
        if (!made.id) throw new Error('Drive did not return a file id: ' + JSON.stringify(made).slice(0, 300))
        if (req.description) await $.mcp.call(DRIVE, 'update_file', { fileId: made.id, description: req.description })
        await log({ rid: req.rid, kind: 'drive-uploaded', text: JSON.stringify({ id: made.id, title: req.title, url: docUrl(made), zip }) })
      } else if (req.kind === 'drive-list') {
        const res = parse(await $.mcp.call(DRIVE, 'search_files', {
          query: `parentId = '${await folderId()}' and trashed = false`, orderBy: 'modifiedTime desc', pageSize: 50,
          excludeContentSnippets: true, includeRichMetadata: true }))
        type Entry = { id: string; title: string; modified: string; description: string; owner: string; url: string; size?: number
          isZip?: boolean; zip?: { id: string; title: string; size: number } }
        const all: Entry[] = (res.files ?? res.items ?? []).filter((f: Record<string, unknown>) => f.mimeType !== 'application/vnd.google-apps.folder')
          .map((f: Record<string, unknown>) => ({
            id: f.id, title: String(f.title ?? f.name ?? ''), modified: String(f.modifiedTime ?? f.modified_time ?? ''), description: String(f.description ?? ''),
            owner: String(f.owner_name ?? ''), url: docUrl(f as { id?: string }), size: Number(f.fileSize ?? 0),
            isZip: f.mimeType === 'application/zip' || String(f.title ?? '').toLowerCase().endsWith('.zip') }))
        const notes = all.filter(f => !f.isZip)
        const files: Entry[] = [...notes]
        for (const z of all.filter(f => f.isZip)) {
          const note = notes.find(n => n.title + ZIP_SUFFIX === z.title)
          if (note) note.zip = { id: z.id, title: z.title, size: z.size ?? 0 }; else files.push(z)
        }
        files.sort((a, b) => b.modified.localeCompare(a.modified))
        await $.fs.write(DIR + '/drive.json', JSON.stringify({ at: Date.now(), files }))
        await log({ rid: req.rid, kind: 'drive-listed', text: String(files.length) })
      } else if (req.kind === 'drive-read') {
        let out = '', zipB64 = ''
        if (req.id) {       // the note (a Google Doc)
          const res = parse(await $.mcp.call(DRIVE, 'read_file_content', { fileId: req.id }))
          const body = res.fileContent ?? res.content ?? res.text ?? JSON.stringify(res)
          out = '../handovers/drive-' + req.id + '.md'
          await $.fs.write(out, `<!-- from Google Drive: ${req.title} (${req.id}) -->\n` + String(body))
        }
        if (req.zipId) {    // its files: handed to CrewMon as base64 text, which it unzips
          zipB64 = '../handovers/drive-' + (req.id || req.zipId) + '.zip.b64'
          await $.fs.write(zipB64, blobOf(await $.mcp.call(DRIVE, 'download_file_content', { fileId: req.zipId })))
        }
        await log({ rid: req.rid, kind: 'drive-read', text: JSON.stringify({ id: req.id || req.zipId, title: req.title, file: out, zipB64 }) })
      } else if (req.kind === 'drive-mark') {
        await $.mcp.call(DRIVE, 'update_file', { fileId: req.id, description: req.text })
        await log({ rid: req.rid, kind: 'drive-marked', text: req.text })
      }
    } catch (err) {
      await log({ rid: req.rid, kind: 'error', text: 'Google Drive: ' + String((err as Error)?.message ?? err) })
    }
  }

  // a new request from CrewMon
  const start = async (req: Job) => {
    if (req.kind.startsWith('drive-')) { await drive(req); return }
    const old = jobs[req.rid]
    if (['message', 'ask', 'talk', 'handover'].includes(req.kind)) {
      if (old || seen.includes(req.rid)) return
      seen = [...seen, req.rid].slice(-KEEP_SEEN)
    }
    if (req.kind === 'resend') {
      if (old && old.lastTo && old.lastText) await send(old, old.lastTo, old.lastText, 'resent')
      else if (old && old.kind === 'handover' && old.step === 'note' && old.from)      // started before resend existed
        await send(old, old.from, noteRequest(old), 'resent')
      else if (old && old.kind === 'handover' && old.step === 'continue' && old.to)
        await send(old, old.to, continueRequest(old), 'resent')
      else if (old && old.kind === 'message' && old.to) await send(old, old.to, old.text ?? '', 'resent')
    } else if (req.kind === 'cancel') {
      if (old) { delete jobs[req.rid]; await log({ rid: req.rid, kind: 'cancelled' }) }
      else if (!seen.includes(req.rid)) { seen = [...seen, req.rid].slice(-KEEP_SEEN); await log({ rid: req.rid, kind: 'cancelled' }) }   // discarded before it started
    } else if (req.kind === 'approve') {
      if (old && old.kind === 'handover' && old.step === 'review') {
        if (old.dest === 'drive') {      // the note goes to Google Drive instead of to an agent here
          await drive({ rid: old.rid, kind: 'drive-upload', file: old.file, title: req.title || old.title || ('Hand-over from ' + old.fromTitle),
            description: req.description || old.description || '', zip: req.zip } as Job)
          await log({ rid: old.rid, kind: 'done' }); delete jobs[old.rid]
        } else {
          old.step = 'continue'; old.waiting = old.to
          await send(old, old.to!, continueRequest(old))
        }
      }
    } else if (req.kind === 'message' && req.to) {
      const j = jobs[req.rid] = { ...req, waiting: req.to }
      await send(j, req.to, req.text ?? '')
    } else if (req.kind === 'ask' && req.from && req.to) {
      const j = jobs[req.rid] = { ...req, waiting: req.to }
      await send(j, req.to, `The agent "${req.fromTitle}" asks you: ${req.text}`)
    } else if (req.kind === 'talk' && req.a && req.b) {
      const j = jobs[req.rid] = { ...req, turn: 1, waiting: req.a, transcript: [] }
      await send(j, req.a, `CrewMon is starting a short discussion between you and the agent "${req.bTitle}" ` +
        `(${req.rounds} turns each, at most 150 words per turn). Topic: ${req.text}\nGive your opening view.`)
    } else if (req.kind === 'handover' && req.from && (req.to || req.dest === 'drive')) {
      const j = jobs[req.rid] = { ...req, step: 'note', waiting: req.from }
      await send(j, req.from, noteRequest(j))
    }
    await save()
  }

  // A's note is written
  const noteDone = async (j: Job) => {
    if (j.approve) {   // CrewMon shows the note first; B is told only after "approve"
      j.step = 'review'; j.waiting = ''
      await log({ rid: j.rid, kind: 'note-ready', session: j.from, text: j.file })
    } else {
      j.step = 'continue'; j.waiting = j.to
      await send(j, j.to!, continueRequest(j))
    }
  }
  const noteSaved = async (j: Job, quietMs = 0) => {
    if (!j.file) return true
    if (!await $.fs.exists(j.file)) return false
    const st = await $.fs.stat(j.file)
    return st.size > 0 && Date.now() - st.mtimeMs >= quietMs
  }
  const checkNotes = async () => {
    for (const j of Object.values(jobs)) {
      if (j.kind !== 'handover' || j.step !== 'note' || !j.replied || !await noteSaved(j, 4000)) continue
      if (j.step !== 'note' || jobs[j.rid] !== j) continue      // answered or cancelled meanwhile
      await noteDone(j)
      await save()
    }
  }
  // a reply from one of the sessions
  const onReply = async (j: Job, text: string) => {
    const body = bodyOf(text)
    await log({ rid: j.rid, kind: 'reply', session: j.waiting, text: body })
    if (j.kind === 'message') { delete jobs[j.rid] }
    else if (j.kind === 'ask') {
      await send(j, j.from!, `Answer from the agent "${j.toTitle}" to the question "${j.text}": ${body}`)
      await log({ rid: j.rid, kind: 'done' }); delete jobs[j.rid]
    } else if (j.kind === 'talk') {
      const speaker = j.waiting === j.a ? j.aTitle : j.bTitle
      j.transcript = [...(j.transcript ?? []), `${speaker}: ${body}`]
      const fromA = j.waiting === j.a
      if (!fromA) j.turn = (j.turn ?? 1) + 1
      if (j.turn! > (j.rounds ?? 2)) {
        j.waiting = j.a
        j.step = 'summary'
        await send(j, j.a!, `The discussion with "${j.bTitle}" is over. Here it is:\n\n${j.transcript.join('\n\n')}\n\n` +
          `Summarise the outcome in at most 5 lines (agreements, disagreements, next steps).`)
      } else {
        const next = fromA ? j.b! : j.a!
        const other = fromA ? j.aTitle : j.bTitle
        j.waiting = next
        await send(j, next, `"${other}" says (topic: ${j.text}):\n\n${body}\n\nReply in at most 150 words.`)
      }
    } else if (j.kind === 'handover') {
      if (j.step === 'note') {
        if (await noteSaved(j)) await noteDone(j)
        else j.replied = true      // an answer, but no note yet ("I'll do it later"): checkNotes goes on when it is saved
      } else { await log({ rid: j.rid, kind: 'done' }); delete jobs[j.rid] }
    }
    await save()
  }
  // a talk ends with A's summary
  const finishTalk = async (j: Job, text: string) => {
    const body = bodyOf(text)
    await log({ rid: j.rid, kind: 'reply', session: j.a, text: body })
    await log({ rid: j.rid, kind: 'done' })
    delete jobs[j.rid]
    await save()
  }
  return { save, log, start, onReply, finishTalk, checkNotes }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function load($: any) {
  if (loaded) return
  const saved = (await $.store.get('state')) as { offset?: number; jobs?: Record<string, Job>; seen?: string[] } | undefined
  offset = saved?.offset ?? -1
  jobs = saved?.jobs ?? {}
  seen = saved?.seen ?? []
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
    const { save, log, start, checkNotes } = tools($)
    // first run: skip what was there before. Decided here and not at the first request, which would then be skipped itself
    // (no outbox yet: everything that will be written to it is new)
    if (!await $.fs.exists(OUTBOX)) offset = 0
    else if (offset < 0) offset = (await $.fs.stat(OUTBOX)).size
    await save()   // publish active.json with the new fields straight away
    $.clock.every(1500, async () => {
      if (busy) return
      busy = true
      try {
        const st = await $.fs.stat(OUTBOX).catch(() => undefined)
        if (st) {
          if (offset < 0 || offset > st.size) offset = st.size     // the file was cut short: skip what is in it
          if (st.size > offset) {
            const added = String(await $.fs.read(OUTBOX, { offset, length: st.size - offset }))
            offset = st.size
            const lines = added.split('\n').filter(l => l.trim())
            const cancelled = (from: number, rid: string) => lines.slice(from + 1).some(l => {
              try { const r = JSON.parse(l) as Job; return r.kind === 'cancel' && r.rid === rid } catch { return false } })
            for (const [i, line] of lines.entries()) {
              try {
                const req = JSON.parse(line) as Job
                if (req.kind !== 'cancel' && cancelled(i, req.rid)) continue      // discarded while this was not running
                await start(req)
              } catch (err) { await log({ kind: 'error', text: 'bad request: ' + String(err) }) }
            }
            await save()
          }
        }
        await checkNotes()
      } finally { busy = false }
    })
    $.clock.every(4000, () => { void $.fs.write(BEAT, JSON.stringify({ at: Date.now(), version: MOD_VERSION })) })
    // the names and refs other sessions use (ListAgents), for CrewMon's "Copy ids"
    const listAgents = async () => {
      try {
        const r = await $.tool.call({ tool: 'ListAgents' })
        await $.fs.write(DIR + '/agents.json', JSON.stringify({ at: Date.now(), result: r }))
      } catch (err) {
        await $.fs.write(DIR + '/agents.json', JSON.stringify({ at: Date.now(), error: String((err as Error)?.message ?? err) }))
      }
    }
    void listAgents()
    $.clock.every(15000, () => { void listAgents() })
    return out
  })
}
