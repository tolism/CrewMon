// CrewMon: requests the messenger has not picked up (pure functions, tested by tools/test-messenger.mjs).
'use strict';
const STARTS = ['message', 'ask', 'talk', 'handover'];
const LATE_MS = 10000;                 // the messenger looks every 1.5 s; this long without a sign of it is worth telling
const DAY_MS = 24 * 3600e3;

// outbox: what CrewMon asked for (file order); inbox: what the messenger recorded; active: conversations in progress.
// A request without a time (an older CrewMon wrote it) is never reported: we cannot tell how long it has been waiting.
function pendingRequests(outbox, inbox, active, now, keepInbox = 400) {
  const known = new Set(active.map(a => a.rid));
  for (const x of inbox) if (x.rid) known.add(x.rid);
  // the inbox keeps its last lines only: before its first one we cannot tell
  const since = Math.max(now - DAY_MS, inbox.length >= keepInbox ? inbox[0].at : 0);
  const byRid = new Map();
  for (const o of outbox) {
    if (o.kind === 'cancel') byRid.delete(o.rid);
    else if (STARTS.includes(o.kind) && o.at) byRid.set(o.rid, o);      // sent again: the same rid, the newest time
  }
  return [...byRid.values()].filter(o => !known.has(o.rid) && o.at >= since && now - o.at >= LATE_MS);
}

module.exports = { pendingRequests, STARTS, LATE_MS };
