# Work boards (CrewMon 1.0.0)

A work board is **your view** of what an agent is doing: where it is now, what waits on you, what comes next, what is
done. The agent is never asked to keep it and never sees it: it works the way it wants, and CrewMon watches its chat
and draws the board. Nothing is sent to an agent unless you click.

## Choices, and why

| Choice | Why |
|---|---|
| **Opt-in per agent** (Track on the card) | Most chats are short; a board for each would be noise and Haiku cost. |
| **CrewMon writes the board, not the agent** | Only 1 in 21 recent agents kept a to-do list. Asking agents to keep one costs their context, and they forget. |
| **Five sections**: Now · Waiting on you · Next · Later · Done, plus a **Vision** line | Now/Next/Done is what one glance needs; *Later* keeps ideas out of *Next*; *Vision* holds the longer-term goal. A list, not kanban columns: one agent has 5–15 items. |
| **Haiku proposes small changes** (add, move, done), code applies them | Asking for small changes instead of a rewrite keeps the wording stable; the code enforces the rules below, the model cannot break them. |
| **Sync when the agent goes idle** with new turns (at most every 90 s), or on *Sync now* | Never on a timer: no cost while nothing happens. |
| **One writer**: the extension | Your edits and Haiku's changes go through the same queue, so they cannot overwrite each other. |
| **Shows how fresh it is** ("synced 4 min ago") and marks "probably done" | A wrong board that looks certain is the main risk. |

## Where items come from

1. **The agent's own to-do list** (TodoWrite), when it keeps one: taken as is (`agent`).
2. **Haiku**, from the new turns since the last sync: your requests, the agent's replies, its tool calls, commits,
   questions to you, and compaction summaries (`auto`).
3. **You**: add, edit, tick, move, pin, delete, and the Vision line (`you`).
4. **Live, no AI**: *Now* also shows what the agent is doing this second, and *Waiting on you* shows an open question
   or approval prompt.

## Rules the code enforces

- Your items and pinned items are never reworded, moved or removed by Haiku. It may only tick one done, with evidence.
- Something you deleted is never added again.
- *Done* needs evidence (a commit, a file, a test result, the agent saying so); without it the item is shown as
  "probably done".
- The agent's own list wins over Haiku's guesses.
- At most 6 new items per sync; near-duplicates are merged.
- Untrack keeps the board file; Track again brings it back.

## Running in the background

Read straight from the chat, no AI: every command started with `run_in_background`, helper agent (async subagent),
workflow and watcher (Monitor) has a start and a finish record (`completed`, `failed`, `stopped`) that points back to
it. The board shows what is running and for how long, the latest event of a watcher, and what finished in the last 6
hours. When the chat is closed, anything still marked running is shown as *probably not running*. Finished work is
also given to the sync as proof for *Done*.

## Talking to the agent (only when you click)

- **Send Next to agent** and **Check with agent** send at once (through the messenger) and show *Waiting for its
  reply…*; only an answer that arrives after you sent counts, and the board re-syncs when it arrives.
- **Ask** on an item fills the message bar with that item, for you to finish and send.

Nothing is ever sent by the board on its own.

## Files

- `~/.claude/crewmon/boards/<session id>.json`: one board per tracked agent.
- `board.js`: storage, reading the new turns, the Haiku call and the rules (no VS Code code, so it is tested on its
  own: `node --test tools/test`).

## Later (not in 1.0.0)

1. **Project boards**: a vision and milestones per project that outlive agents; each agent's items hang under a milestone.
2. **Crew board**: every tracked agent's Now / Waiting / Next on one screen, the ones waiting on you first.
3. **Boards travel with hand-overs**: B starts with A's open items.
