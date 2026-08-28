/** @jsxImportSource @kitajs/html */
import { Layout } from './layout'

type TaskRow = {
  session: string
  name: string
  right: string
  rightClass?: string
  stages: ('done' | 'cur' | '')[]
  note: string
}

function Task(row: TaskRow): JSX.Element {
  return (
    <div class="task" data-s={row.session}>
      <div class="t1">
        <b>{row.name}</b>
        <span class={row.rightClass ?? ''}>{row.right}</span>
      </div>
      <div class="t2">
        <div class="stg">
          {row.stages.map((state) => (
            <i class={state}></i>
          ))}
        </div>
        {row.note}
      </div>
    </div>
  )
}

function Station(rows: TaskRow[]): JSX.Element {
  return (
    <div class="station">
      <div class="lab">AT THIS STATION</div>
      {rows.map((row) => Task(row))}
    </div>
  )
}

const CLAUDE_TASKS: TaskRow[] = [
  {
    session: 'hermez-fb-retry',
    name: 'hermez-fb-retry',
    right: 'SPEC · 12m',
    stages: ['cur', '', '', ''],
    note: 'writing spec',
  },
  {
    session: 'moni-audio-v2',
    name: 'moni-audio-v2',
    right: 'REVIEW · 4m',
    stages: ['done', 'done', 'cur', ''],
    note: 'verifying diff from GLM',
  },
]

const GLM_TASKS: TaskRow[] = [
  {
    session: 'orders-export-fix',
    name: 'orders-export-fix',
    right: 'IMPL · 26m',
    stages: ['done', 'cur', '', ''],
    note: 'wt: .worktree/orders-export',
  },
  {
    session: 'campaign-occasions',
    name: 'campaign-occasions',
    right: 'IMPL · 11m',
    stages: ['done', 'cur', '', ''],
    note: 'wt: .worktree/campaign-ai',
  },
  {
    session: 'lead-csv-import',
    name: 'lead-csv-import',
    right: 'IMPL · 2m',
    stages: ['done', 'cur', '', ''],
    note: 'wt: .worktree/lead-csv',
  },
]

const CODEX_TASKS: TaskRow[] = [
  {
    session: 'moni-audio-v2',
    name: 'moni-audio-v2',
    right: 'QUEUED',
    rightClass: 'c-red',
    stages: ['done', 'done', 'cur', ''],
    note: 'cross-review waiting on auth',
  },
  {
    session: 'orders-export-fix',
    name: 'orders-export-fix',
    right: 'QUEUED',
    rightClass: 'c-red',
    stages: ['done', 'done', 'cur', ''],
    note: 'cross-review waiting on auth',
  },
]

function Flow(): JSX.Element {
  return (
    <div class="flow">
      <div class="cap">
        SESSION FLOW ·<span id="chips"></span>
        <span class="fixture" data-src="flow">
          FIXTURE
        </span>
      </div>
      <svg class="fsvg" id="fsvg">
        <defs>
          <marker
            id="ar"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M0 0L8 4L0 8z" class="arrowhead" />
          </marker>
          <marker
            id="arA"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M0 0L8 4L0 8z" class="arrowhead amber" />
          </marker>
        </defs>
      </svg>
      <div class="node" id="nd-spec" style="left:2%;top:96px">
        <div class="nn">SPEC</div>
        <div class="lane-chip c-claude" id="lc-spec">
          CLAUDE
        </div>
      </div>
      <div class="node" id="nd-impl" style="left:19.5%;top:96px">
        <div class="nn">IMPLEMENT</div>
        <div class="lane-chip c-glm" id="lc-impl">
          GLM
        </div>
      </div>
      <div class="node" id="nd-codex" style="left:47%;top:38px">
        <div class="nn">CROSS-REVIEW</div>
        <div class="lane-chip c-white" id="lc-codex">
          CODEX
        </div>
      </div>
      <div class="node" id="nd-verify" style="left:55.5%;top:96px">
        <div class="nn">VERIFY + MERGE</div>
        <div class="lane-chip c-claude" id="lc-verify">
          CLAUDE
        </div>
      </div>
      <div class="node" id="nd-merged" style="left:80.5%;top:96px">
        <div class="nn">MERGED → UAT</div>
        <div class="lane-chip" id="lc-merged">
          18 TODAY
        </div>
      </div>
      <div class="alabel" style="left:37%;top:64px">
        diff sent
      </div>
      <div class="alabel" style="left:46%;top:104px;color:var(--mc-fg-dim)">
        review back
      </div>
    </div>
  )
}

function Racks(): JSX.Element {
  return (
    <div class="racks">
      <div class="rack">
        <div class="mhead">
          <canvas id="m1"></canvas>
          <div class="role">TECH LEAD</div>
          <div class="nm c-claude">CLAUDE</div>
        </div>
        <div class="sec">
          <div class="big c-claude">
            <span id="n1">0</span>
            <small>
              {' '}
              M TOK · <span id="n1pct">88</span>% BLOCK
            </small>
            <span class="fixture" data-src="quota">
              FIXTURE
            </span>
          </div>
          <div class="track">
            <div class="fill" id="b1" style="background:var(--mc-coral)"></div>
          </div>
        </div>
        <div class="sec">
          <div class="kv">
            <span>JOBS / PTY / EXT</span>
            <b id="k-claude-live">1 / 2 / 1</b>
          </div>
          <div class="kv">
            <span>AUTH</span>
            <b class="c-green" id="k-claude-auth">
              OK
            </b>
          </div>
        </div>
        {Station(CLAUDE_TASKS)}
        <div class="acts">
          <a href="/dispatch">DISPATCH</a>
          <a href="/terminals">TERMINAL</a>
          <a href="/settings">TEST</a>
        </div>
      </div>

      <div class="rack">
        <div class="mhead">
          <canvas id="m2"></canvas>
          <div class="role">JUNIOR FLEET</div>
          <div class="nm c-glm">GLM</div>
        </div>
        <div class="sec">
          <div class="big c-glm">
            <span id="n2">0</span>
            <small>
              {' '}
              % OF 5H · <span id="n2peak">PEAK x2 02:19</span>
            </small>
            <span class="fixture" data-src="quota">
              FIXTURE
            </span>
          </div>
          <div class="track">
            <div class="fill" id="b2" style="background:var(--mc-cyan)"></div>
          </div>
        </div>
        <div class="sec">
          <div class="kv">
            <span>SLOTS / WORKTREES</span>
            <b id="k-glm-slots">3/50 · 4</b>
          </div>
          <div class="kv">
            <span>DONE LAST 8H</span>
            <b id="k-glm-done">18</b>
          </div>
        </div>
        {Station(GLM_TASKS)}
        <div class="acts">
          <a href="/dispatch">DISPATCH</a>
          <a href="/terminals">TERMINAL</a>
          <a href="/settings">TEST</a>
        </div>
      </div>

      <div class="rack">
        <div class="mhead">
          <canvas id="m3"></canvas>
          <div class="role">OUTSIDE CRITIC</div>
          <div class="nm c-white">CODEX</div>
        </div>
        <div class="sec">
          <div class="big c-red sm" id="n3">
            AUTH FAIL
            <small class="blk" id="n3sub">
              login status → exit 1
            </small>
            <span class="fixture" data-src="quota">
              FIXTURE
            </span>
          </div>
          <div class="track">
            <div class="fill full" id="b3" style="background:var(--mc-red)"></div>
          </div>
        </div>
        <div class="sec">
          <div class="kv">
            <span>REVIEWS BLOCKED</span>
            <b class="c-red" id="k-codex-blocked">
              2
            </b>
          </div>
          <div class="kv">
            <span>QUOTA API / PTY</span>
            <b id="k-codex-pty">NONE · 0</b>
          </div>
        </div>
        {Station(CODEX_TASKS)}
        <div class="acts">
          <a href="/settings" class="c-red">
            RE-AUTH
          </a>
          <a href="/settings">TEST</a>
        </div>
      </div>
    </div>
  )
}

export function LanesPage(): string {
  return Layout({
    title: 'Mission Control — Lanes',
    page: 'app',
    tab: 'lanes',
    islands: ['nav', 'sprites', 'flow', 'lanes'],
    vendor: ['anime.umd.min.js', 'textmode.umd.js', 'textmode.filters.umd.js'],
    meta: (
      <>
        <span id="block-clock">03:11 / 5:00 BLOCK</span> · TOK/MIN <span id="tpm">0</span>K ·{' '}
        <span class="c-amber" id="review-count">
          9 DIFFS TO REVIEW
        </span>
        <span class="fixture" data-src="meta">
          FIXTURE
        </span>
      </>
    ),
    children: (
      <>
        {Flow()}
        {Racks()}
      </>
    ),
  })
}
