# Notifications: "Waiting on you" — design

Date: 2026-09-30 · Status: design approved (variant A), spec awaiting review · Mockups: `../visualizer/notifications/` (a.html, alert.html, DECISION.md) · Lands after: `.worktree/chat-upgrade-23` (chat permission cards)

## Intent

Mission Control raises four desktop popups today, all through `osascript` in `server/notify.ts`: possible loop (`server/index.ts:152`, `onJobSlow`), needs you (`server/chat-reports.ts:200`, `:216`), landed (`server/routes/jobs.ts:434`) and, in the chat-upgrade worktree, permission asks (`.worktree/chat-upgrade-23/server/index.ts:153`). macOS attributes every `osascript` popup to Script Editor, so they show its icon and a "Show" button that opens Script Editor. They carry no link and no buttons, nothing is saved, and any server raises them, including throwaway test servers.

After this work, an alert exists only when something is waiting on the user, and one click either answers it or opens the exact place to answer it. Everything waiting is kept in one list in the cockpit, so a missed alert is never lost. FYI events (landed) never pop up.

Success looks like this: a chat agent asks to run `bun test test/chat-bridge.test.ts` while the cockpit tab is hidden. A Mac alert appears with the chat name as the title, "Wants to run: bun test …" on line two, and Allow once / Deny under Options. The bell in the top bar shows 1 and the tab title reads `(1) Mission Control`. The user clicks Allow once on the alert, the agent continues, the alert disappears from Notification Center, the bell goes back to empty, and the chat's permission card shows the answer.

## Decisions

| Area | Decision |
| --- | --- |
| Delivery | The cockpit page shows alerts through the browser's Notifications API and a service worker. No native app, no phone push, no `osascript`. |
| What alerts | Permission ask, needs you (reply failed / agent-round limit), possible loop. Landed is not an alert and not a list item. |
| One list | A server-side "Waiting on you" list, saved to `<config dir>/attention.json`. Every alert is an item on it. |
| Clearing | Items clear themselves when the underlying thing is handled. Needs-you and loop items can also be dismissed by hand (× on hover). Permission items cannot be dismissed, only answered. |
| Live updates | One server-sent-events stream, `GET /api/attention/stream`: a snapshot on connect, then `raise` / `resolve` events. No new polling timer (acceptance concern 6). |
| Placement | Variant A: a bell in the top bar after `#open-agents`, with a red `.count`; the list drops down top-right. See `visualizer/notifications/DECISION.md`. |
| Rail | Chats with a waiting item get `.sb-dot[data-s="needs"]` (already styled, `public/quiet.css:1022`). |
| Tab | Title `(N) Mission Control` while N > 0. Mission Control gets a real favicon (`public/favicon.svg`, purple square, white spark); today it is `data:,`. |
| Quiet while present | No Mac alert while a cockpit tab is visible and focused. The bell and the in-chat card are enough then. |
| Permission to alert | Asked only when the user clicks "Turn on" in the list's "Mac alerts are off" banner, never on page load. |
| Test servers | Can never alert: alerts come only from a browser tab that was granted permission, and Playwright's browser denies notifications by default. `server/notify.ts` is deleted. |
| App icon | The alert's left icon stays the browser's (Arc). A web page cannot change it. The Mission Control icon is passed as the notification `icon`, which shows on the right. |

## Design

### Server: the attention list (`server/attention.ts`)

An item:

```ts
type AttentionItem = {
  key: string                      // 'perm:<jobId>:<requestId>' | 'needs:<chatId>' | 'loop:<jobId>'
  kind: 'permission' | 'needs' | 'loop'
  title: string                    // chat label or job label
  detail: string                   // 'Wants to run: …' | 'Needs you: …' | 'May be stuck: 42 turns in 38 min'
  command: string | null           // permission only; shown in the cockpit, never truncated server-side
  chatId: string | null
  jobId: string | null
  requestId: string | null         // permission only
  createdAt: number
}
```

Store API: `raise(item)` (idempotent by `key`; raising an existing key refreshes `detail` without re-alerting), `resolve(key)`, `resolveWhere(predicate)`, `list()`, `subscribe(listener)`. Writes go to `attention.json` atomically, the same way the other config-dir stores write. On start, items whose job is no longer running are dropped for `permission` and `loop`, because a pending permission cannot survive a restart (the process that asked is gone).

Routes (`server/routes/attention.ts`, mounted with `requireLocal`):
- `GET /api/attention`: the list.
- `GET /api/attention/stream`: SSE; `event: snapshot` with the full list, then `event: raise` / `event: resolve` per change.
- `POST /api/attention/:key/dismiss`: needs and loop only; 409 for permission.

### Where items are raised and resolved

| Site | Today | After |
| --- | --- | --- |
| `onPermissionRequest` (`chat-upgrade-23/server/index.ts:153`) | `notifyChat(title, body)` | `raise({ kind: 'permission', … })` |
| `POST /api/jobs/:id/permission` (`chat-upgrade-23/server/routes/jobs.ts:866`) | — | `resolve('perm:<id>:<requestId>')` after the answer is sent |
| Job ends (any status) | — | `resolveWhere(kind = permission or loop, jobId = id)` |
| `chat-reports.ts:200`, `:216` | `notify('Needs you', …)` | `raise({ kind: 'needs', key: 'needs:<chatId>' })` |
| New user message in a chat, a retry, land, or kill of that chat's job | — | `resolve('needs:<chatId>')` |
| `onJobSlow` (`server/index.ts:152`) | `notifySlowJob` | `raise({ kind: 'loop', … })`; keep the existing `console.error` line |
| `POST /api/jobs/:id/kill` | — | covered by "job ends" |
| Landed (`routes/jobs.ts:434`) | `notify('Landed', …)` | removed; the chat already shows it |

### Cockpit (`client/attention.ts`)

- Opens one `EventSource('/api/attention/stream')` per page and keeps the list in memory.
- The bell: `.round.quiet-control` + `<symbol id="bell-icon">` + `.count` (red). Clicking it toggles the panel; Escape and clicking outside close it.
- The panel, per DECISION.md:
  - items newest first;
  - permission shows the command in a mono row with Deny / Open chat / Allow once;
  - loop shows Stop job / Open job;
  - needs shows Open chat;
  - the empty state and the "Mac alerts are off · Turn on" banner as mocked.
- Ages ("2 min") are computed when the panel renders. There is no ticking timer.
- Panel actions use the existing endpoints: `POST /api/jobs/:id/permission`, `POST /api/jobs/:id/kill`. Open chat uses `?chat=<id>`. Open job uses the job's chat when it has one; otherwise a new `?job=<id>` param opens the agents panel and scrolls to that job.
- Updates `document.title` and the rail dots from the list.
- Button feedback: a pressed button disables until the server answers. On failure the item stays and shows one line in red ("Couldn't allow: the job already ended"), never a silent no-op.

### Mac alerts (`client/attention.ts` + `public/sw.js`)

- The page registers `public/sw.js` (scope `/`). On a `raise` event it calls `registration.showNotification` when all of these hold:
  - notification permission is granted;
  - the alerts toggle is on;
  - the page is not visible, or not focused.
- Notification fields:
  - `tag` = item key, so the same item never shows twice, even with several tabs open;
  - `renotify: false`;
  - `icon` = `/favicon.svg`;
  - `data` = `{ key, kind, chatId, jobId, requestId }`;
  - `actions`: permission → `allow`, `deny`; loop → `stop`; needs → none.
- On a `resolve` event, the page closes the matching notification (`getNotifications({ tag })`).
- `notificationclick` in the service worker:
  - `allow` / `deny` → `POST /api/jobs/:jobId/permission`; `stop` → `POST /api/jobs/:jobId/kill`. These are same-origin requests to 127.0.0.1, so the existing local-request rule admits them.
  - On failure it shows one follow-up notification: "Couldn't allow · Open the chat", whose click opens the chat.
  - A body click focuses an open cockpit tab and tells it to open the deep link; with no tab open it opens a new one.
- The alerts toggle ("Alert settings" in the panel footer) is a per-browser setting in `localStorage`. The browser's own permission stays the real gate.

### Removed

`server/notify.ts` and its test, plus the `notify` options threaded through `routes/jobs.ts` and `chat-reports.ts`.

## Error handling

- **Stream drops:** `EventSource` reconnects on its own, and each reconnect starts with a fresh snapshot, so the bell cannot drift.
- **Broken `attention.json`:** the server starts with an empty list and logs one line. Needs-you items from before are lost, but the chat list still marks failed replies (`client/chat-view.ts:83`), and running jobs raise new permission and loop items as usual.
- **Permission already answered elsewhere** (the endpoint returns 409): the alert or panel item closes quietly, because the item is already resolved.
- **Notifications blocked, or the browser has no service worker:** the banner explains how to allow it in the browser. The bell, the list and the tab count still work.

## Testing

- **Store (`test/attention.test.ts`):**
  - `raise` is idempotent by key;
  - `resolve` and `resolveWhere`;
  - persistence round-trip;
  - start-up drops permission and loop items for jobs that are not running;
  - a corrupt file starts empty.
- **Routes:** the stream sends a snapshot, then raise and resolve events; dismiss returns 409 for permission.
- **Wiring:**
  - a permission request raises;
  - answering it resolves;
  - killing the job resolves its permission and loop items;
  - `chat-reports` raises a needs item;
  - a new user message resolves it;
  - slow job raises a loop item;
  - land raises nothing.
- **Client pure functions:** the title text, the should-alert decision (permission × toggle × visibility × focus), the notification options per kind, the item view model and the age text.
- **Service worker click handler:** written as a pure function of `(event data, action, fetch, clients)`, tested with fakes (allow, deny, stop, body click with and without an open tab, failed fetch).
- **Browser check (Playwright, fake engine):**
  - the bell count;
  - the panel matches `visualizer/notifications/a.html`;
  - Allow once from the panel reaches the job;
  - the empty state;
  - the alerts-off banner;
  - with permission granted and `showNotification` stubbed, a raise while the page is hidden calls it with the right tag and actions, and a resolve closes it.
- **Manual, once, in Arc:** confirm that the Options buttons appear on a real alert. If Arc hides them, the alert still opens the chat. Record the result in the landing notes.

## Out of scope

- Phone push (ntfy) and any remote access (Tailscale).
- A native menu-bar app.
- The cockpit's existing polling timers (`client/chat.ts:11-13`, `client/outcome-strip.ts:19`).
- Per-kind alert settings, sounds and snooze.
