# Research Companion (CrewMon 1.0.2)

When several agents run experiments for one project, it gets hard to say **what was tried, why, and what came of it**.
Research Companion keeps that record for you, per project, drawn from the agents' chats. The agents are never asked
to keep it and never see it.

## What it holds

```
Research question ──► Experiment (why, expected) ──► Runs (one launch each: config, seed, status, numbers)
                         │
                         ├── Data, Models
                         ├── Result, Verdict (supports / refutes / unclear, with evidence), Next
                         └── Artifacts: results table, chart, notes, write-up (made when you ask)
```

- **Questions**: what the work tries to answer, why it matters, the answer so far (*open · answered · dropped*).
- **Experiments**: a concrete thing tried to answer a question (a training run, an ablation, an evaluation, an
  analysis), with its reason, its hypothesis, the data and models, status (*planned · running · done · failed ·
  stopped · dropped*), result with numbers, verdict and next step.
- **Runs**: commands that launched experiments, found in the chats **without AI**, with their status, how long they ran,
  the latest line of their output and the metrics in it (*val_acc=0.81*, *test_macro_f1: 0.66*, …).

## Choices, and why

| Choice | Why |
|---|---|
| **One record per project** (the git root of the agent's folder), opened from any of its agents | A question outlives the agent that started it; several agents often work on one study. |
| **Opened from an agent** (Research on the card, **E**, or the card's ⚗ line), showing *This agent* or *Whole project* | You usually arrive from the agent you are looking at; the whole project is one click away. |
| **Everything from the chats** | No setup and no dependency on one tracking tool; it works for any project. Run output files the chat points to (a background command's output, a `> log` redirect) are read for live numbers. |
| **Runs by fixed rules, meaning by Haiku** | Whether a command launched a run is decidable by rules (tested on real chats: queue scripts, `python -m pkg run cfg.yaml`, torchrun, sbatch…); questions, reasons and results need reading. Haiku proposes small changes; code applies them under rules it cannot break. |
| **Sync when an agent goes idle** with new turns (at most every 2 min per agent), or on *Sync now* | Never on a timer: no cost while nothing happens. The first read of an agent also uses its latest compaction summary, so earlier work is not lost. |
| **Four tabs**: Questions · Plan · Compare · Runs | *Questions* answers "why", *Plan* answers "what is running and what is next", *Compare* answers "which is better", *Runs* answers "who ran what". |
| **Artifacts only on request** | No surprise cost; each one says where it came from and that numbers should be checked against the runs. |

## Rules the code enforces

- **Never invented numbers**: Haiku is told to copy metrics as reported; runs' metrics are parsed from their output.
- **Your fields stay yours**: anything you edit (a title, a reason, a status, a result, a verdict, a link) is never
  changed by the sync. Reasons (*why*, *expected*) are written once and not reworded.
- **A verdict needs evidence** (a run, a table, the agent's report); without it, it shows as *probably*.
- **Deleted items never come back.** Deleting a question keeps its experiments (under *Not tied to a question*).
- **No duplicates**: the same question or experiment in other words updates the existing one.
- **Smoke tests are not experiments**, and are hidden in *Runs* unless you ask for them.
- At most 8 new items per sync (16 on the first one).

## Using it

- **Questions** tab: each question with its experiments. Click an experiment to open it: why, expected, data,
  models, result, verdict, next, numbers, its runs and which agents worked on it. Click any field to edit it; **Status**,
  **Ask agent** (fills the message bar), **Question…** (move it), **Rename**, delete. Add a question at the bottom, or
  an experiment with **+** on a question.
- **Plan** tab: experiments by status: running, planned, then done, failed, stopped and dropped (folded). Add a planned
  experiment at the bottom.
- **Compare** tab: pick a question and a metric: bars (best first, lower-is-better metrics such as loss handled) and a
  table with the best value per column marked.
- **Runs** tab: every run of the agent (or project): ⟳ running · ✓ done · ✗ failed · ■ stopped · ? probably not running.
  **Link to an experiment…** files a run under an experiment (the sync also does this; yours wins).
- **Make…**: a **results table** (Markdown), a **chart** of the chosen metric (SVG), **research notes** (Markdown), or a
  **write-up** by Haiku from the notes only. They open in VS Code and are listed under *Artifacts*.
- A critter with a flask is running an experiment.

## Memory

The **Memory** tab is Claude Code's own memory for the project (`~/.claude/projects/<folder>/memory/`, the files every
new agent in that folder loads), shown and added to from CrewMon:

- **Add to memory**: pick **Behavior** (a rule for the agents), **Idea** (to try later, not agreed), **Run** (done
  elsewhere, with its numbers) or **Note**, type it, press Enter. It is written as a normal memory file (behaviors as
  `feedback`, the rest as `project`, plus `crewmon: <kind>`) and added to `MEMORY.md`, so the agents follow it.
- **What the agents saved** (when you told them "remember…") shows too, with **who saved it and when**, read from the
  chats; behaviors are the `feedback` memories, the rest notes. **Kind** re-files one (only in CrewMon; the file is not
  changed).
- **Send to agent** sends the behaviors to the agent the panel was opened from, for a chat that started before them.
- An **idea** shows in *Plan* with **+** to make it a planned experiment; a **run** shows in *Runs* (*by hand*) with
  the numbers in its text, and can be linked to an experiment like any run.
- Edit changes only what CrewMon wrote (the agents' files open in the editor); Delete asks first and removes the file
  and its line in `MEMORY.md`. The sync reads the memory as context, so ideas there are not turned into experiments
  until they are agreed. Notes, *Copy notes* and the write-up include it.

## Files

- `~/.claude/crewmon/research/<project>-<hash>.json`: one record per project.
- `~/.claude/crewmon/research/<project>-<hash>/artifacts/`: what *Make…* writes.
- `~/.claude/projects/<folder>/memory/`: Claude Code's memory, read for every folder the project's agents started in; what you add goes to the project root's.
- `research.js`: storage, run detection, metrics, the Haiku request and the rules (no VS Code code; tested with
  `node --test tools/test/*.test.js`).

## Later

1. Read MLflow / Weights & Biases / TensorBoard runs too, when a project uses them.
2. Paired comparisons with confidence intervals across seeds.
3. Hand-overs carry the experiment's record, so the agent taking over starts with its question and runs.
