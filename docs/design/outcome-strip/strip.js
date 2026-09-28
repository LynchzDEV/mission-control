const MAIN = { by: 'main', who: 'Main agent', engine: 'claude' }
const REVIEWER = { by: 'spawned', who: 'Sub-agent · review the version bump', engine: 'claude' }
const DOCS = { by: 'spawned', who: 'Sub-agent · find version comparisons', engine: 'claude' }
const API_JOB = { by: 'spawned', who: 'Job · api · csv export endpoint', engine: 'glm' }
const BO_JOB = { by: 'spawned', who: 'Job · backoffice · export button', engine: 'codex' }
const BO_RETRY = { by: 'spawned', who: 'Job · backoffice · export button (retry)', engine: 'codex' }

const row = (actor, ok, tool, target, result, detail, ago) => ({ ...actor, ok, tool, target, result, detail, ago })

const SETS = {
  terminal: [
    row(MAIN, true, 'Bash', 'git status --short', 'Passed · exit 0', '', '41m ago'),
    row(MAIN, true, 'Bash', 'bundle exec rubocop app/models/moni', 'Passed · exit 0', '', '39m ago'),
    row(MAIN, true, 'Edit', 'app/models/moni/runtime.rb', 'Saved', '+4 −1', '37m ago'),
    row(MAIN, true, 'Bash', 'bin/ci spec/moni', 'Passed · exit 0', '212 examples, 0 failures', '35m ago'),
    row(MAIN, true, 'Bash', 'git commit -m "feat(moni): runtime version gate"', 'Passed · exit 0', '', '34m ago'),
    row(MAIN, false, 'Bash', 'git push origin main', 'Failed · exit 1', 'rejected (fetch first)', '33m ago'),
    row(MAIN, true, 'Bash', 'git pull --rebase origin main', 'Passed · exit 0', '', '33m ago'),
    row(MAIN, true, 'Bash', 'git push origin main', 'Passed · exit 0', '', '32m ago'),
    row(MAIN, true, 'Write', 'spec/moni/runtime/version_spec.rb', 'Saved', '42 lines', '20m ago'),
    row(DOCS, true, 'Bash', 'rg "Version.new" app lib', 'Passed · exit 0', '', '19m ago'),
    row(DOCS, true, 'Agent', 'find version comparisons', 'Finished', '6 tool uses · 38s', '18m ago'),
    row(MAIN, true, 'Edit', 'app/models/moni/runtime_version.rb', 'Saved', '+2 −2', '17m ago'),
    row(MAIN, false, 'Bash', 'bin/ci spec/moni/runtime', 'Failed · exit 1', '14 examples, 2 failures\nversion_spec.rb:42', '9m ago'),
    row(MAIN, false, 'Edit', 'app/models/moni/runtime_version.rb', 'Failed', 'String to replace not found in file', '8m ago'),
    row(MAIN, true, 'Edit', 'app/models/moni/runtime_version.rb', 'Saved', '+3 −1', '8m ago'),
    row(REVIEWER, true, 'Bash', 'git diff app/models/moni', 'Passed · exit 0', '', '7m ago'),
    row(REVIEWER, true, 'Bash', 'bin/ci spec/moni/runtime/version_spec.rb', 'Passed · exit 0', '9 examples, 0 failures', '6m ago'),
    row(REVIEWER, true, 'Agent', 'review the version bump', 'Finished', '7 tool uses · 21.4k tokens · 48s', '6m ago'),
    row(MAIN, true, 'Bash', 'bin/ci spec/moni/runtime', 'Passed · exit 0', '14 examples, 0 failures', '4m ago'),
    row(MAIN, true, 'Bash', 'bundle exec rubocop app/models/moni', 'Passed · exit 0', '', '3m ago'),
  ],
  chat: [
    row(MAIN, true, 'Bash', 'git -C api log --oneline -5', 'Passed · exit 0', '', '6m ago'),
    row(API_JOB, true, 'Write', 'app/controllers/moni/upsell_exports_controller.rb', 'Saved', '58 lines', '5m ago'),
    row(API_JOB, true, 'Edit', 'config/routes.rb', 'Saved', '+3', '5m ago'),
    row(API_JOB, true, 'Bash', 'bin/ci spec/requests/moni', 'Passed · exit 0', '31 examples, 0 failures', '4m ago'),
    row(API_JOB, true, 'Job', 'api · csv export endpoint', 'Done', '2 commits ready to land', '4m ago'),
    row(BO_JOB, true, 'Edit', 'app/views/moni/rules/index.html.erb', 'Saved', '+9 −1', '4m ago'),
    row(BO_JOB, false, 'Bash', 'bin/rails test:system TEST=test/system/moni_rules_test.rb', 'Failed · exit 1', 'Unable to find button "Export CSV"', '3m ago'),
    row(BO_JOB, false, 'Job', 'backoffice · export button', 'Failed · exit 1', 'System test failed: Unable to find button "Export CSV"', '3m ago'),
    row(BO_RETRY, true, 'Edit', 'test/system/moni_rules_test.rb', 'Saved', '+1 −1', '2m ago'),
    row(BO_RETRY, true, 'Bash', 'bin/rails test:system TEST=test/system/moni_rules_test.rb', 'Passed · exit 0', '6 runs, 0 failures', '1m ago'),
    row(BO_RETRY, true, 'Job', 'backoffice · export button (retry)', 'Done', '1 commit ready to land', '1m ago'),
  ],
}

const tip = Object.assign(document.createElement('div'), { className: 'oc-tip', hidden: true })
document.body.append(tip)
const SPAWN_TOOLS = new Set(['Job', 'Agent'])
const esc = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function showTip(cell, item) {
  tip.innerHTML = `<div class="oc-tip-head"><i class="oc-sq" data-ok="${item.ok}" data-by="${item.by}"></i>${esc(item.tool)}<code>${esc(item.target)}</code></div>`
    + `<p class="oc-tip-result" data-ok="${item.ok}">${esc(item.result)}</p>`
    + (item.detail ? `<p class="oc-tip-detail">${esc(item.detail)}</p>` : '')
    + `<p class="oc-tip-meta"><img src="assets/providers_${item.engine}.svg" alt="">${SPAWN_TOOLS.has(item.tool) ? 'Started by the main agent' : esc(item.who)} · ${esc(item.ago)}</p>`
  tip.hidden = false
  const box = cell.getBoundingClientRect()
  const width = tip.offsetWidth
  const left = Math.min(Math.max(8, box.left + box.width / 2 - width / 2), innerWidth - width - 8)
  const above = box.top - tip.offsetHeight - 10
  tip.style.left = `${left}px`
  tip.style.top = `${above > 8 ? above : box.bottom + 10}px`
}

function mount(host) {
  const items = SETS[host.dataset.set]
  const shown = items.slice(-Number(host.dataset.max ?? items.length))
  const cells = document.createElement('span')
  cells.className = 'oc-cells'
  for (const item of shown) {
    const cell = Object.assign(document.createElement('i'), { className: 'oc-sq' })
    cell.dataset.ok = String(item.ok)
    cell.dataset.by = item.by
    cell.onmouseenter = () => showTip(cell, item)
    cell.onmouseleave = () => { tip.hidden = true }
    cells.append(cell)
  }
  host.classList.add('oc-strip')
  host.append(cells)
  if (host.dataset.sum === undefined) return
  const failed = items.filter((item) => !item.ok).length
  host.insertAdjacentHTML(host.dataset.sum === 'before' ? 'afterbegin' : 'beforeend', `<span class="oc-sum" title="${items.length} actions this session"><span class="ok"><b>${items.length - failed}</b> passed</span><span class="bad"><b>${failed}</b> failed</span></span>`)
}

document.querySelectorAll('[data-set]').forEach(mount)
if (location.hash === '#hover') {
  const target = [...document.querySelectorAll('.oc-sq[data-ok="false"]')].at(-1)
  target?.classList.add('hot')
  target?.dispatchEvent(new Event('mouseenter'))
}
