import { card, grow, morph } from './morph.js'

document.body.insertAdjacentHTML('afterbegin', await (await fetch('sprite.html')).text())
const $ = (demo, selector) => demo.querySelector(selector)
const change = (el, animate, apply) => (animate ? morph(el, apply) : apply())

const CARDS = [
  {
    area: 'Sidebar', shipped: true, title: 'Status dot → ✕ → Remove', source: 'client/sidebar.ts · public/quiet.css (.sb-morph)',
    how: 'The reference every other card follows: one element that reshapes. Already in the app.',
    markup: `<div class="sb-item"><a class="sb-row" data-kind="terminal"><span class="sb-ic"><svg><use href="#terminal-icon"/></svg></span><span class="sb-t">shell-lane-quota-fix</span><span class="sb-trail"><kbd class="sb-key">⌘1</kbd><span class="sb-slot"></span></span></a><button type="button" class="sb-morph" data-s="live"><svg><use href="#close-icon"/></svg><span>Remove</span></button></div>`,
    labels: ['At rest', 'Hover', 'Clicked ✕'],
    states: [
      (demo) => { $(demo, '.sb-item').classList.remove('is-hover'); $(demo, '.sb-morph').dataset.armed = 'false' },
      (demo) => { $(demo, '.sb-item').classList.add('is-hover') },
      (demo) => { $(demo, '.sb-morph').dataset.armed = 'true' },
    ],
  },
  {
    area: 'Terminal', title: 'Connection status pill', source: 'client/terminals.ts:110 setStatus · .term-bar-status',
    how: 'Connecting… → Live → Disconnected · Reconnect. Now the words and colour snap; morphed, the pill stretches or shrinks to its new width while the colour blends and the words cross-fade.',
    markup: `<div class="term-bar"><span class="term-bar-logo" data-engine="claude"><img src="assets/providers_claude.svg" alt=""></span><span class="term-bar-name">api · moni runtime</span><button class="term-bar-status tap" type="button" data-kind="muted"><i></i><span>Connecting…</span></button><span class="term-bar-sep"></span><button class="term-bar-find" type="button"><svg><use href="#search-icon"/></svg></button></div>`,
    labels: ['Connecting…', 'Live', 'Disconnected', 'Reconnecting…'],
    states: [['muted', 'Connecting…'], ['live', 'Live'], ['down', 'Disconnected · Reconnect'], ['muted', 'Reconnecting…']].map(([kind, text]) => (demo, animate) => {
      const pill = $(demo, '.term-bar-status')
      change(pill, animate, () => { pill.dataset.kind = kind; pill.lastElementChild.textContent = text })
    }),
  },
  {
    area: 'Terminal', title: 'Find in terminal', source: 'client/terminals.ts:257 openFind · .term-bar .find',
    how: 'Clicking 🔍 swaps the status pill and buttons for the find field in one frame. Morphed, the bar itself widens from the 🔍 into the field, and shrinks back on close.',
    markup: `<div class="term-bar"><span class="term-bar-logo" data-engine="claude"><img src="assets/providers_claude.svg" alt=""></span><span class="term-bar-name">api · moni runtime</span><button class="term-bar-status" type="button" data-kind="live"><i></i><span>Live</span></button><span class="term-bar-sep"></span><button class="term-bar-find" type="button"><svg><use href="#search-icon"/></svg></button><div class="find" hidden><input type="text" placeholder="Find" value="runtime"><span>2 of 14</span><button class="round" type="button"><svg><use href="#up-icon"/></svg></button><button class="round" type="button"><svg><use href="#down-icon"/></svg></button><button class="round" type="button"><svg><use href="#close-icon"/></svg></button></div></div>`,
    labels: ['Closed', 'Find open'],
    states: [false, true].map((open) => (demo, animate) => {
      const bar = $(demo, '.term-bar')
      change(bar, animate, () => { $(demo, '.find').hidden = !open })
    }),
  },
  {
    area: 'Access', title: 'Copy API token → ✓ Copied', source: 'client/access.ts:43 copy.onclick',
    how: 'Today only the note under the field changes to "Copied.". Morphed, the Copy button itself becomes a green ✓ Copied pill, then settles back.',
    markup: `<div class="token-row"><input value="mc_7f3a…c91e" readonly style="width:200px"><button type="button" class="text-button copy tap"><span style="padding:0">Copy</span></button></div><p class="muted hint note">For scripts and the dispatch skill.</p>`,
    labels: ['Ready', 'Copied', 'Settles back'],
    states: [
      (demo, animate, side) => { const b = $(demo, '.copy'); change(b, animate, () => { b.removeAttribute('style'); b.firstElementChild.textContent = 'Copy' }); $(demo, '.note').textContent = 'For scripts and the dispatch skill.' },
      (demo, animate, side) => {
        const b = $(demo, '.copy')
        if (side === 'now') { $(demo, '.note').textContent = 'Copied.'; return }
        change(b, animate, () => { b.style.cssText = 'padding:4px 10px;border-radius:8px;background:#dcece1;color:#3f7352;font-weight:600'; b.firstElementChild.textContent = '✓ Copied' })
      },
      (demo, animate, side) => { const b = $(demo, '.copy'); if (side === 'morph') change(b, animate, () => { b.removeAttribute('style'); b.firstElementChild.textContent = 'Copy' }) },
    ],
  },
  {
    area: 'Agents panel', title: 'Stop a running agent', source: 'client/shell-activity.ts:224 stop.onclick',
    how: 'Now one click stops the agent straight away. Morphed, Stop fills red and reads "Stop agent" (second click confirms), then shrinks into Stopping… and settles as a Stopped pill.',
    markup: `<div class="ag-actions0" style="display:flex;gap:8px;align-items:center"><span class="muted" style="font-size:12px">Codex · backoffice · export button</span><button type="button" class="ag-btn danger stop">Stop</button></div>`,
    labels: ['Running', 'Clicked Stop', 'Stopping', 'Stopped'],
    states: [
      (demo, animate) => { const b = $(demo, '.stop'); change(b, animate, () => { b.removeAttribute('style'); b.disabled = false; b.textContent = 'Stop' }) },
      (demo, animate, side) => { const b = $(demo, '.stop'); change(b, animate, () => { if (side === 'now') { b.disabled = true; b.textContent = 'Stop' } else { b.style.cssText = 'background:#b0556a;color:#fff;border-color:#b0556a;font-weight:600'; b.textContent = 'Stop agent' } }) },
      (demo, animate) => { const b = $(demo, '.stop'); change(b, animate, () => { b.disabled = true; b.style.cssText = 'color:var(--muted)'; b.textContent = 'Stopping…' }) },
      (demo, animate) => { const b = $(demo, '.stop'); change(b, animate, () => { b.disabled = true; b.style.cssText = 'border:0;background:#eceef3;color:var(--muted);border-radius:12px'; b.textContent = 'Stopped' }) },
    ],
  },
  {
    area: 'Access', title: 'Rotate API token', source: 'client/access.ts:47 rotate.onclick · #access-rotate-confirm',
    how: 'Now Rotate opens a "Make a new API token?" dialog over everything. Morphed, Rotate fills red and cross-fades to "Make new token"; the second click rotates and the token field blends to the new value.',
    markup: `<div class="token-row"><input class="token" value="mc_7f3a…c91e" readonly style="width:170px"><button type="button" class="confirm-morph rotate"><span>Rotate</span><span>Make new token</span></button></div><div class="dialog-sim" hidden style="position:absolute;inset:8px;display:grid;place-content:center;gap:8px;padding:12px;border-radius:12px;background:var(--paper);box-shadow:6px 8px 22px #b4c1d677,-3px -3px 12px #ffffff99;font-size:13px"><b>Make a new API token?</b><span class="muted" style="font-size:12px">Scripts using the current token stop working.</span><span style="display:flex;gap:8px;justify-content:flex-end"><span class="pill" style="padding:4px 10px">Cancel</span><span class="pill danger" style="padding:4px 10px">Make a new token</span></span></div>`,
    labels: ['Ready', 'Asks to confirm', 'Rotated'],
    states: [
      (demo) => { $(demo, '.rotate').dataset.armed = 'false'; $(demo, '.dialog-sim').hidden = true; $(demo, '.token').value = 'mc_7f3a…c91e' },
      (demo, animate, side) => { if (side === 'now') $(demo, '.dialog-sim').hidden = false; else $(demo, '.rotate').dataset.armed = 'true' },
      (demo, animate, side) => { $(demo, '.dialog-sim').hidden = true; $(demo, '.rotate').dataset.armed = 'false'; const token = $(demo, '.token'); if (animate) token.animate([{ opacity: .2, filter: 'blur(2px)' }, { opacity: 1, filter: 'none' }], { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' }); token.value = 'mc_d41c…08ab' },
    ],
  },
  {
    area: 'Toasts', title: 'Toast (uploads, saves, errors)', source: 'client/terminals.ts:298 toast() · #toast',
    how: 'The one toast shared by Terminal, Studio and chat pops in and vanishes. Morphed, it grows up out of a small pill (scale + blur clear) and shrinks away.',
    markup: `<div style="height:70px"></div><div class="toast tap" style="position:absolute;left:50%;bottom:14px" hidden>Added 2 files</div><button type="button" class="pill tap" style="position:absolute;top:10px;left:12px;padding:4px 10px;font-size:12px">Drop 2 files</button>`,
    labels: ['Nothing', 'Toast shows', 'Toast leaves'],
    states: [
      (demo) => { $(demo, '.toast').hidden = true },
      (demo, animate) => { const t = $(demo, '.toast'); if (animate) grow(t, true); else t.hidden = false },
      (demo, animate) => { const t = $(demo, '.toast'); if (animate) grow(t, false); else t.hidden = true },
    ],
  },
  {
    area: 'Chat', title: 'Agent report · Show report', source: 'client/chat.ts:162 toggle.onclick',
    how: 'The report body appears and the label flips in one frame, shoving the chat down. Morphed, the card eases open to its new height while "Show report" cross-fades to "Hide report".',
    markup: `<div class="agent-report compact report" style="--engine:#bfd38b"><div class="agent-report-head"><span class="engine-tile"><img src="assets/providers_codex.svg" alt=""></span><span class="agent-report-label">backoffice · export button</span><span class="outcome-pill" data-tone="done">Done</span><button type="button" class="text-button toggle">Show report</button></div><div class="md agent-report-body" hidden><p>Added an Export CSV button to the rules page and a system test; <code>bin/rails test:system</code> 6 runs, 0 failures.</p></div></div>`,
    labels: ['Collapsed', 'Expanded'],
    states: [false, true].map((open) => (demo, animate) => {
      const report = $(demo, '.report')
      change(report, animate, () => { $(demo, '.agent-report-body').hidden = !open; $(demo, '.toggle').textContent = open ? 'Hide report' : 'Show report' })
    }),
  },
  {
    area: 'Composer', title: 'Project / model menu', source: 'client/shell-composer.ts:83 · #project-menu .chip-menu',
    how: 'The menu blinks into existence above the chip. Morphed, it grows out of the chip (from its corner) and folds back into it on close.',
    markup: `<div style="height:150px"></div><div class="popover chip-menu" style="bottom:52px;left:12px;width:240px" hidden><button class="row current" type="button"><svg><use href="#folder-icon"/></svg><span>mission-control<small>~/Desktop/kingpinggroup</small></span></button><button class="row" type="button"><svg><use href="#folder-icon"/></svg><span>klangtech<small>~/Desktop/kingpinggroup</small></span></button></div><button type="button" class="chip tap" style="position:absolute;left:12px;bottom:14px"><svg><use href="#folder-icon"/></svg><span>mission-control</span></button>`,
    labels: ['Closed', 'Open'],
    states: [false, true].map((open) => (demo, animate) => {
      const menu = $(demo, '.chip-menu')
      menu.style.transformOrigin = 'left bottom'
      if (animate) grow(menu, open); else menu.hidden = !open
      $(demo, '.chip').setAttribute('aria-expanded', String(open))
    }),
  },
  {
    area: 'Composer', title: 'Chip label after picking', source: 'client/shell-composer.ts:35 · #project-name / #model-name',
    how: 'Picking a project or model swaps the chip text and it jumps to the new width. Morphed, the chip stretches or shrinks while the name cross-fades.',
    markup: `<button type="button" class="chip tap label-chip" style="justify-self:start"><svg><use href="#folder-icon"/></svg><span>mission-control</span></button>`,
    labels: ['mission-control', 'klangtech', 'สอบ'],
    states: ['mission-control', 'klangtech', 'สอบ'].map((name) => (demo, animate) => {
      const chip = $(demo, '.label-chip')
      change(chip, animate, () => { chip.lastElementChild.textContent = name })
    }),
  },
  {
    area: 'Access', title: 'Reveal → Copy token', source: 'client/access.ts:18 reveal/copy',
    how: 'Reveal disappears and a separate Copy button appears. Morphed, the one button reshapes from Reveal into Copy while the dots in the field blend into the token.',
    markup: `<div class="token-row"><input class="token" value="••••••••••••" readonly style="width:180px"><button type="button" class="text-button reveal tap"><span style="padding:0">Reveal</span></button></div>`,
    labels: ['Hidden', 'Revealed'],
    states: [false, true].map((shown) => (demo, animate) => {
      const button = $(demo, '.reveal'), token = $(demo, '.token')
      change(button, animate, () => { button.firstElementChild.textContent = shown ? 'Copy' : 'Reveal' })
      if (animate) token.animate([{ opacity: .2, filter: 'blur(2px)' }, { opacity: 1, filter: 'none' }], { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' })
      token.value = shown ? 'mc_7f3a2b…c91e' : '••••••••••••'
    }),
  },
  {
    area: 'Outcome strip', title: 'First action and new squares', source: 'client/outcome-strip.ts:134 fetchOnce',
    how: 'The strip pops in on the first action and each new square appears at full size. Morphed, the line grows in, each new square scales up from a point, and the totals roll to the new number.',
    markup: `<div class="oc-line" hidden style="position:static"><span class="oc-label">This session</span><span class="oc-cells"></span><span class="oc-sum"><span class="ok"><b class="p">0</b> passed</span><span class="bad"><b class="f">0</b> failed</span></span></div><span class="muted empty" style="font-size:12px">No terminal output yet</span>`,
    labels: ['Before first action', 'First action', 'A failure', 'Another pass'],
    states: [[], [true], [true, false], [true, false, true]].map((cells) => (demo, animate) => {
      const line = $(demo, '.oc-line'), host = $(demo, '.oc-cells')
      $(demo, '.empty').hidden = cells.length > 0
      if (cells.length === 0) { line.hidden = true; host.replaceChildren(); $(demo, '.p').textContent = '0'; $(demo, '.f').textContent = '0'; return }
      if (line.hidden) { if (animate) grow(line, true); else line.hidden = false }
      while (host.children.length > cells.length) host.lastElementChild.remove()
      for (let i = host.children.length; i < cells.length; i++) {
        const cell = Object.assign(document.createElement('i'), { className: 'oc-sq' }); cell.dataset.ok = String(cells[i]); cell.dataset.by = 'main'
        host.append(cell)
        if (animate) cell.animate([{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1.35)', opacity: 1, offset: .7 }, { transform: 'scale(1)' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' })
      }
      for (const [selector, value] of [['.p', cells.filter(Boolean).length], ['.f', cells.filter((ok) => !ok).length]]) {
        const b = $(demo, selector); if (b.textContent === String(value)) continue
        b.textContent = String(value)
        if (animate) b.animate([{ transform: 'translateY(-6px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' })
      }
    }),
  },
  {
    area: 'Agents panel', title: 'Open an agent row', source: 'client/shell-activity.ts:95 showDetail · .ag-item.open',
    how: 'Clicking an agent flips its details open and everything below jumps. Morphed, the row eases open to fit its details and back.',
    markup: `<div class="ag-item agent tap" style="background:color-mix(in srgb,#fff 45%,var(--paper))"><div class="ag-row"><span class="l">backoffice · export button</span><span class="pill-state" data-s="running">Running</span><time>2m</time></div><div class="ag-detail"><p class="ag-why" style="margin:0 0 8px;font-size:12px;color:var(--muted)">Codex · gpt-5 — add the Export CSV button</p><button type="button" class="ag-btn danger">Stop</button></div></div>`,
    labels: ['Closed', 'Open'],
    states: [false, true].map((open) => (demo, animate) => {
      const item = $(demo, '.agent')
      change(item, animate, () => item.classList.toggle('open', open))
    }),
  },
  {
    area: 'Sidebar', title: 'Selection moves between rows', source: 'client/sidebar.ts:170 markSelected · .sb-row.sel',
    how: 'The raised highlight jumps from one row to the next. Morphed, one highlight glides between rows, like the dot growing into ✕.',
    markup: `<div class="sel-host" style="position:relative;display:grid"><span class="glider" style="position:absolute;left:0;right:0;height:40px;border-radius:10px;background:var(--paper);box-shadow:var(--raised);pointer-events:none"></span>${['shell-lane-quota-fix', '/klangtech-read https://app.cli…', '/inv-prod help me check'].map((title, i) => `<a class="sb-row tap" data-i="${i}" style="position:relative;margin-bottom:4px"><span class="sb-ic"><svg><use href="#terminal-icon"/></svg></span><span class="sb-t">${title}</span></a>`).join('')}</div>`,
    labels: ['Row 1', 'Row 2', 'Row 3'],
    states: [0, 1, 2].map((target) => (demo, animate) => {
      const glider = $(demo, '.glider'), row = demo.querySelectorAll('.sb-row')[target]
      const from = glider.offsetTop
      glider.style.top = `${row.offsetTop}px`; glider.style.height = `${row.offsetHeight}px`
      if (animate) glider.animate([{ transform: `translateY(${from - row.offsetTop}px)` }, { transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' })
    }),
  },
  {
    area: 'Sidebar', title: 'Row leaves after Remove', source: 'client/sidebar.ts hide() → paint()',
    how: 'After Remove the row vanishes and the rows below snap up. Morphed, the row fades and folds away while the rows below glide into its place.',
    markup: `<div class="rows" style="display:grid">${['shell-lane-quota-fix', '/klangtech-read https://app.cli…', '/inv-prod help me check'].map((title) => `<a class="sb-row" style="margin-bottom:4px;overflow:hidden"><span class="sb-ic"><svg><use href="#terminal-icon"/></svg></span><span class="sb-t">${title}</span></a>`).join('')}</div><button type="button" class="pill tap" style="justify-self:start;margin-top:4px;padding:3px 10px;font-size:12px">Remove row 2</button>`,
    labels: ['Three rows', 'Row 2 removed'],
    states: [false, true].map((removed) => (demo, animate) => {
      const row = demo.querySelectorAll('.sb-row')[1]
      if (!removed) { row.hidden = false; row.style.cssText = 'margin-bottom:4px;overflow:hidden'; return }
      if (!animate) { row.hidden = true; return }
      const h = row.offsetHeight
      row.animate([{ height: `${h}px`, opacity: 1, marginBottom: '4px' }, { height: '0px', opacity: 0, marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px' }], { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' }).onfinish = () => { row.hidden = true }
    }),
  },
]

const host = document.getElementById('cards')
const areas = [...new Set(CARDS.map((item) => item.area))]
for (const item of CARDS) host.append(card(item))
const nav = document.querySelector('nav.areas')
for (const name of ['All', ...areas]) {
  const button = Object.assign(document.createElement('button'), { type: 'button', textContent: name })
  button.setAttribute('aria-pressed', String(name === 'All'))
  button.onclick = () => {
    for (const other of nav.children) other.setAttribute('aria-pressed', String(other === button))
    for (const section of host.children) section.hidden = name !== 'All' && section.dataset.area !== name
  }
  nav.append(button)
}
export { grow }
