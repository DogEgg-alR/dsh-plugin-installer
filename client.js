/**
 * Client half of `dsh-plugin-installer`.
 *
 * Two surfaces on one tab:
 * - install: new plugins through this package's host bridge (any spec pnpm
 *   accepts — registry name, git repo, local directory);
 * - update: installed plugins through dshmarket's public `dsh-market/update-api/v1`,
 *   which owns the update algorithm (release-age policy, version verification,
 *   recovery point + rollback) that a plugin must not reimplement. When the
 *   market is not installed the section says so instead of guessing.
 *
 * The market's own v1 client contract requires feature detection before any
 * mutation control is enabled, so nothing here posts an update until
 * `/capabilities` answered with `features.update === true`.
 *
 * @module dsh-plugin-installer/client
 */

const PACKAGE_ID = 'dsh-plugin-installer'
const API = '/dsh-plugin-installer/api'
const MARKET_API = '/dsh-market/api/v1'

/** Modules may not be imported here; the loader hands React to the factory. */
let React

/**
 * Resolve one path against the page this bundle was served from.
 *
 * Root-absolute paths break behind a proxy that mounts dsh under a prefix, and
 * Desktop serves its page from a custom scheme, so the path is anchored on
 * `document.baseURI` and the origin kept only when it is a real one.
 *
 * @param path - absolute path below the page's origin.
 * @returns the URL to fetch.
 */
function resolveUrl(path) {
  if (typeof document === 'undefined') return path
  const resolved = new URL(path.replace(/^\/+/, ''), document.baseURI)
  return resolved.origin === 'null' ? resolved.pathname : resolved.href
}

/** URL of one route served by this package's host half. */
function apiUrl(path) {
  return resolveUrl(`${API}/${path.replace(/^\/+/, '')}`)
}

/** URL of one route served by dshmarket. */
function marketUrl(path) {
  return resolveUrl(`${MARKET_API}/${path.replace(/^\/+/, '')}`)
}

/**
 * Read a response body as JSON without throwing on an empty or non-JSON body.
 * @param response - the fetch response.
 * @returns the parsed value, or `{}`.
 */
async function readJson(response) {
  try {
    return await response.json()
  } catch {
    return {}
  }
}

/** Copy shown by both sections. */
const TEXT = {
  installTitle: '安装新插件',
  installHint:
    '支持 npm 包名（如 dsh-whale-widget、@scope/name@1.2.3）、GitHub 仓库（owner/repo、github:owner/repo）以及本地目录。',
  placeholder: 'dsh-whale-widget 或 github:owner/repo',
  install: '安装',
  installing: '正在安装…',
  elapsed: '已用',
  second: '秒',
  added: '已安装',
  applied: '已生效。',
  restart: '安装完成，重启 DeepSeek Harness 后生效。',
  failed: '安装失败',
  again: '再装一个',
  details: '详细输出',
  clear: '收起',
  empty: '请输入插件标识。',
  updatableHint: '已安装的插件可以在这里检查并更新；更新由 dshmarket 的公开接口执行。',
  updateTitle: '更新已安装插件',
  check: '检查更新',
  checking: '正在检查…',
  noMarket: '未检测到 dshmarket，无法在此检查更新（安装功能不受影响）。',
  marketChecking: '正在检测 dshmarket…',
  notChecked: '点「检查更新」查看可用版本。',
  upToDate: '全部已是最新版本。',
  updatable: '个可更新',
  checkedCount: '已检查',
  update: '更新',
  updating: '更新中…',
  updated: '已更新',
  updateFailed: '更新失败',
  force: '强制更新',
  rollback: '回滚到更新前',
  rollingBack: '正在回滚…',
  rolledBack: '已回滚到更新前的版本。',
  rollbackFailed: '回滚失败',
  restartNeeded: '重启 DeepSeek Harness 后生效。',
  installedTitle: '已安装的插件',
  installedHint:
    '在这里卸载插件。正在运行的插件（文件来自本地目录或链接安装）无法直接删除文件，会先停用；若仍不行，就把它从 profile 配置里摘除，重启后不再加载。',
  refresh: '刷新',
  loadingBundles: '正在读取已安装列表…',
  noBundles: '没有可显示的插件。',
  enabled: '已启用',
  disabled: '已停用',
  remove: '卸载',
  removing: '正在卸载…',
  confirmRemove: '确认卸载',
  cancel: '取消',
  selfHint: '这就是当前这个插件；卸载后「安装插件」页会消失，可随时用命令行装回来。',
  notRemovable: '这个插件不能在这里卸载。',
  removed: '已卸载',
  removeFailed: '卸载失败',
  bypassedDisable: '直接删除被拒绝（插件正在使用），已先停用再删除。',
  bypassedManifest: '直接删除被拒绝（插件正在使用），已从 profile 配置里摘除：文件留在 node_modules 里不再加载，重启后会自动清掉，也可以在这里马上清理。',
  pendingTitle: '待清理',
  pendingHint: '这些插件的配置已经摘除，文件还在 node_modules 里；重启后会自动清掉，也可以现在就清。',
  cleanupNow: '立即清理',
  cleaning: '正在清理…',
  cleanupDone: '已清理',
  cleanupFailedCount: '个失败',
  cleanupNothing: '没有需要清理的残留。',
  phaseResolve: '解析依赖',
  phaseDownload: '下载',
  phaseLink: '链接',
  phaseBuild: '构建',
  progressStarting: '准备中…',
  elapsed: '已用',
  stallHint: 'pnpm 装包本身就要几十秒，进度条只反映市场报告的真实阶段，不会提前跳到 100%。',
  queuedWaiting: '已排队：等正在运行的对话结束后自动开始，不会打断它。',
}

/**
 * One sentence for a market failure code, per the v1 contract's stable codes.
 * @param failure - `{ code, message, retryable }` from the operation record.
 * @returns the sentence to show.
 */
function failureText(failure) {
  switch (failure?.code) {
    case 'OPERATION_BUSY':
      return '另一个更新操作正在进行，请稍后再试（通常是上一次更新还没收尾，等几秒再点一次即可）。'
    case 'AGENTS_RUNNING':
      return '有对话正在运行，更新被推迟；等它结束后重试。'
    case 'RELEASE_TOO_FRESH':
      return '目标版本刚发布，市场还在冷却期内；可点「强制更新」绕过。'
    case 'VERSION_UNCHANGED':
      return '市场认为当前已是最新，但本地版本没有变化；可点「强制更新」重试。'
    case 'DOWNGRADE_DETECTED':
      return '解析出的版本比当前还旧，已自动恢复到更新前的状态。'
    case 'RESOLVED_VERSION_MISMATCH':
      return '解析出的版本低于市场目标（镜像可能滞后），已恢复到更新前；稍后重试。'
    case 'UPDATE_TIMEOUT':
      return '更新超时。'
    case 'UPDATE_FORBIDDEN':
      return '市场拒绝了这个更新请求（来源不受信任）。'
    case 'UPDATE_REJECTED':
      return '市场拒绝了这个更新请求。'
    case 'PLUGIN_NOT_INSTALLED':
      return '这个插件在当前档位里没有安装。'
    default:
      return failure?.message ?? '更新失败。'
  }
}

/** Shared card chrome for one outcome. */
const ACCENT = '#2563eb'

const ERROR_INK = 'var(--dsw-alias-state-error-primary, #b91c1c)'
const SUCCESS_INK = 'var(--dsw-alias-state-success-primary, #15803d)'
const WARN_INK = 'var(--dsw-alias-state-warn-primary, #b45309)'

const cardStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 12,
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l1, #d1d5db)',
  background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))',
}

const buttonStyle = {
  padding: '6px 12px',
  fontSize: 12,
  fontWeight: 600,
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l1, #d1d5db)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
}

const primaryButtonStyle = { ...buttonStyle, border: '1px solid transparent', background: ACCENT, color: '#fff' }

const mutedText = { fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, #6b7280)' }

/**
 * Horizontal inset of a section header's right-hand button.
 *
 * Rows put their buttons inside a card (`padding: 10px 12px` plus a 1px
 * border), so a button that sits directly in the section header would hang
 * 14px further right and look out of line with the row buttons under it.
 * @returns the inset in pixels.
 */
const headerInset = 14

/**
 * Spinner plus a line of text.
 * @param props - the line to show.
 * @returns the status row.
 */
function Working({ text }) {
  return React.createElement(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: 8, ...mutedText } },
    React.createElement('span', {
      'aria-hidden': true,
      style: {
        width: 12,
        height: 12,
        borderRadius: '50%',
        border: '2px solid currentColor',
        borderTopColor: 'transparent',
        display: 'inline-block',
        animation: 'dsh-plugin-installer-spin 0.9s linear infinite',
      },
    }),
    text,
  )
}

/**
 * The pnpm stages the market reports, in the order they happen.
 * @see dshmarket/lib/ndjson.js — `pnpm:stage` sets exactly these.
 */
const UPDATE_PHASES = ['resolving', 'downloading', 'linking', 'building']

/**
 * Names for the market's phase tokens.
 * @param phase - the `progress.phase` value.
 * @returns the label to show, or null when the token is unknown.
 */
function phaseLabel(phase) {
  switch (phase) {
    case 'resolving':
      return TEXT.phaseResolve
    case 'downloading':
      return TEXT.phaseDownload
    case 'linking':
      return TEXT.phaseLink
    case 'building':
      return TEXT.phaseBuild
    default:
      return null
  }
}

/**
 * A thin bar for the operation's own progress plus its current stage.
 *
 * `percent` only exists once pnpm has a total to divide by, so before that the
 * fill slides instead of pretending to know a number. Nothing here animates to
 * 100% on its own: the bar ends where the market says the work ended.
 *
 * @param props - percent, phase, detail and the byte counters.
 * @returns the bar and its caption.
 */
function ProgressBar({ percent, phase, detail, downloaded, size }) {
  const known = typeof percent === 'number' && Number.isFinite(percent)
  const label = phaseLabel(phase)
  const bytes =
    typeof downloaded === 'number' && downloaded > 0 && typeof size === 'number' && size > 0
      ? `${(downloaded / 1048576).toFixed(1)} / ${(size / 1048576).toFixed(1)} MB`
      : null
  const caption = [detail, bytes].filter(Boolean).join(' · ')
  return React.createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    React.createElement(
      'div',
      {
        role: 'progressbar',
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': known ? Math.round(percent) : undefined,
        'aria-label': label ?? TEXT.updating,
        style: {
          position: 'relative',
          height: 6,
          borderRadius: 999,
          overflow: 'hidden',
          background: 'var(--dsw-alias-border-l1, #e5e7eb)',
        },
      },
      known
        ? React.createElement('div', {
            style: {
              height: '100%',
              width: `${Math.min(100, Math.max(3, Math.round(percent)))}%`,
              borderRadius: 999,
              background: ACCENT,
              transition: 'width 320ms ease',
            },
          })
        : React.createElement('div', {
            style: {
              position: 'absolute',
              top: 0,
              bottom: 0,
              width: '45%',
              borderRadius: 999,
              background: ACCENT,
              animation: 'dsh-plugin-installer-bar 1.4s ease-in-out infinite',
            },
          }),
    ),
    React.createElement(
      'div',
      { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, ...mutedText } },
      React.createElement('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, caption || label || TEXT.progressStarting),
      React.createElement('span', { style: { flexShrink: 0, fontVariantNumeric: 'tabular-nums' } }, known ? `${Math.round(percent)}%` : null),
    ),
  )
}

/**
 * The four stages as a row, so a long download reads as "one step" rather than
 * "stuck".
 * @param props - the current phase token.
 * @returns the stage row.
 */
function PhaseStrip({ phase }) {
  const index = UPDATE_PHASES.indexOf(phase)
  return React.createElement(
    'div',
    { style: { display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6b7280)' } },
    ...UPDATE_PHASES.map((value, position) => {
      const done = index > position
      const current = index === position
      return React.createElement(
        'span',
        {
          key: value,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontWeight: current ? 600 : 400,
            color: current ? 'inherit' : done ? 'inherit' : 'var(--dsw-alias-label-secondary, #9ca3af)',
          },
        },
        React.createElement('span', { 'aria-hidden': true }, done ? '✓' : current ? '●' : '○'),
        phaseLabel(value),
      )
    }),
  )
}

/**
 * Install a new plugin through the host bridge.
 * @returns the install section.
 */
function InstallSection() {
  const [spec, setSpec] = React.useState('')
  const [jobId, setJobId] = React.useState(null)
  const [job, setJob] = React.useState(null)
  const [problem, setProblem] = React.useState(null)
  const [seconds, setSeconds] = React.useState(0)
  const [openDetails, setOpenDetails] = React.useState(false)

  const running = jobId !== null && (job === null || job.status === 'running')

  // Poll the job route; the host owns the pnpm run, so the only progress this
  // page can report is "still running" plus what the run finally said.
  React.useEffect(() => {
    if (jobId === null) return undefined
    let stopped = false
    const read = async () => {
      try {
        const response = await fetch(apiUrl(`job?id=${encodeURIComponent(jobId)}`), { cache: 'no-store' })
        const body = await readJson(response)
        if (!stopped) setJob(body)
      } catch (error) {
        if (!stopped) setProblem(String(error?.message ?? error))
      }
    }
    void read()
    const timer = setInterval(read, 1000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [jobId])

  React.useEffect(() => {
    if (!running) return undefined
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [running])

  const start = async () => {
    const value = spec.trim()
    if (value === '') {
      setProblem(TEXT.empty)
      return
    }
    setProblem(null)
    setJob(null)
    setSeconds(0)
    try {
      const response = await fetch(apiUrl('install'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec: value }),
      })
      const body = await readJson(response)
      if (!response.ok) {
        setProblem(body.message ?? `请求失败（HTTP ${response.status}）`)
        return
      }
      setJobId(body.jobId)
    } catch (error) {
      setProblem(String(error?.message ?? error))
    }
  }

  const reset = () => {
    setJobId(null)
    setJob(null)
    setSeconds(0)
    setOpenDetails(false)
  }

  const result = job?.status === 'done' ? job.result : undefined
  const done = result !== undefined
  const succeeded = done && result.ok === true

  return React.createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    React.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      React.createElement('h3', { style: { margin: 0, fontSize: 15, fontWeight: 600 } }, TEXT.installTitle),
      React.createElement('p', { style: { margin: 0, ...mutedText } }, TEXT.installHint),
    ),
    React.createElement(
      'div',
      { style: { display: 'flex', gap: 8 } },
      React.createElement('input', {
        type: 'text',
        value: spec,
        placeholder: TEXT.placeholder,
        spellCheck: false,
        disabled: running,
        onChange: (event) => setSpec(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter' && !running) void start()
        },
        style: {
          flex: 1,
          minWidth: 0,
          padding: '8px 10px',
          fontSize: 13,
          borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l1, #d1d5db)',
          background: 'var(--dsw-alias-bg-base, transparent)',
          color: 'inherit',
        },
      }),
      React.createElement(
        'button',
        {
          type: 'button',
          disabled: running,
          onClick: () => {
            if (done) reset()
            else void start()
          },
          style: running ? { ...primaryButtonStyle, background: 'var(--dsw-alias-bg-layer-1, #e5e7eb)', color: 'var(--dsw-alias-label-secondary, #6b7280)', cursor: 'default' } : primaryButtonStyle,
        },
        running ? TEXT.installing : done ? TEXT.again : TEXT.install,
      ),
    ),
    problem === null ? null : React.createElement('p', { style: { margin: 0, fontSize: 13, color: ERROR_INK } }, problem),
    running ? React.createElement(Working, { text: `${TEXT.installing} ${TEXT.elapsed} ${seconds} ${TEXT.second}` }) : null,
    !done
      ? null
      : React.createElement(
          'div',
          { style: cardStyle },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
            React.createElement('strong', { style: { fontSize: 13, color: succeeded ? SUCCESS_INK : ERROR_INK } }, succeeded ? TEXT.added : TEXT.failed),
            React.createElement('code', { style: { fontSize: 12 } }, [result.target ?? job.spec, result.version].filter(Boolean).join('@')),
          ),
          React.createElement(
            'p',
            { style: { margin: 0, fontSize: 13, lineHeight: 1.6 } },
            succeeded ? (result.application === 'applied' ? TEXT.applied : TEXT.restart) : result.message ?? TEXT.failed,
          ),
          result.errorCode === 'already-installed'
            ? React.createElement('p', { style: { margin: 0, ...mutedText } }, '下方「更新已安装插件」可以直接升级到新版本，不必先卸载。')
            : null,
          result.errorCode !== undefined || result.output !== undefined || result.diagnostic !== undefined || result.warnings?.length
            ? React.createElement(
                'button',
                {
                  type: 'button',
                  onClick: () => setOpenDetails((value) => !value),
                  style: { alignSelf: 'flex-start', padding: 0, border: 0, background: 'none', color: 'inherit', fontSize: 12, textDecoration: 'underline', cursor: 'pointer' },
                },
                openDetails ? TEXT.clear : TEXT.details,
              )
            : null,
          openDetails
            ? React.createElement(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, lineHeight: 1.5 } },
                result.errorCode ? React.createElement('div', null, `error: ${result.errorCode}${result.failedAt ? ` (${result.failedAt})` : ''}`) : null,
                result.diagnostic ? React.createElement('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, result.diagnostic) : null,
                result.warnings?.length ? React.createElement('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, result.warnings.join('\n')) : null,
                result.logPath ? React.createElement('div', { style: { opacity: 0.8 } }, `log: ${result.logPath}`) : null,
                result.output
                  ? React.createElement('pre', { style: { margin: 0, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, result.output)
                  : null,
              )
            : null,
        ),
    )
}

/**
 * Update installed plugins through dshmarket's public v1 API.
 * @returns the update section.
 */
function UpdateSection() {
  // `undefined` while probing, `null` when the market is absent.
  const [capabilities, setCapabilities] = React.useState(undefined)
  const [rows, setRows] = React.useState(null)
  const [checking, setChecking] = React.useState(false)
  const [operation, setOperation] = React.useState(null)
  const [problem, setProblem] = React.useState(null)
  const [busyName, setBusyName] = React.useState(null)
  const [rollingBack, setRollingBack] = React.useState(false)

  const marketReady = capabilities !== null && capabilities !== undefined && capabilities.features?.update === true
  const state = operation?.state
  const active = state === 'queued' || state === 'running'

  // Feature detection first: the market's contract forbids enabling a mutation
  // control before `/capabilities` answered.
  React.useEffect(() => {
    let stopped = false
    void (async () => {
      try {
        const response = await fetch(marketUrl('capabilities'), { cache: 'no-store' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = await readJson(response)
        if (!stopped) setCapabilities(body?.schema === 'dsh-market/update-api/v1' ? body : null)
      } catch {
        if (!stopped) setCapabilities(null)
      }
    })()
    return () => {
      stopped = true
    }
  }, [])

  // Follow one operation: the market answers 202 with a snapshot and expects
  // polling from there.
  React.useEffect(() => {
    const operationId = operation?.operationId
    if (typeof operationId !== 'string' || !active) return undefined
    let stopped = false
    const read = async () => {
      try {
        const response = await fetch(marketUrl(`operations?operationId=${encodeURIComponent(operationId)}`), { cache: 'no-store' })
        const body = await readJson(response)
        if (!stopped && body.operation) setOperation(body.operation)
      } catch (error) {
        if (!stopped) setProblem(String(error?.message ?? error))
      }
    }
    // Read once right away, then keep the bar fed: pnpm reports stages in
    // bursts and a 400ms poll keeps the fill within a fifth of a second of the
    // truth instead of a full second.
    void read()
    const timer = setInterval(read, 400)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [operation?.operationId, active])

  // A settled operation ends the "one update at a time" lock, and a successful
  // one drops its package from the updatable list.
  React.useEffect(() => {
    const settled = state !== 'queued' && state !== 'running'
    if (settled) setBusyName(null)
    if (state === 'succeeded' && rows !== null && typeof operation?.packageName === 'string') {
      setRows((current) => (current === null ? current : current.filter((row) => row.name !== operation.packageName)))
    }
  }, [state])

  const check = async () => {
    setChecking(true)
    setProblem(null)
    try {
      const response = await fetch(marketUrl('updates/summary'), { cache: 'no-store' })
      const body = await readJson(response)
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      setRows(Array.isArray(body.packages) ? body.packages : [])
    } catch (error) {
      setProblem(String(error?.message ?? error))
      setRows(null)
    } finally {
      setChecking(false)
    }
  }

  const startUpdate = async (name, force = false) => {
    setProblem(null)
    setBusyName(name)
    const post = (extra) =>
      fetch(marketUrl('updates'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ packageName: name, ...(force ? { force: true } : {}), ...extra }),
      })
    try {
      let response = await post({})
      let body = await readJson(response)
      // The market refuses to swap plugin files while an Agent sits mid-turn.
      // Its public API can also DEFER the work until those Agents go idle,
      // which is what the person asked for, so ask for the queue instead of a
      // dead end — the poll below follows the deferred operation the same way.
      if (response.status === 409 && body?.failure?.code === 'AGENTS_RUNNING') {
        response = await post({ busyPolicy: 'drain' })
        body = await readJson(response)
      }
      if (response.status === 202 && body.operation) {
        setOperation(body.operation)
        return
      }
      // Non-202 answers carry a stable `failure` shape on the mutation routes.
      setBusyName(null)
      setProblem(failureText(body.failure ?? { code: body.failureCode, message: body.error }))
    } catch (error) {
      setBusyName(null)
      setProblem(String(error?.message ?? error))
    }
  }

  const rollback = async () => {
    if (typeof operation?.operationId !== 'string') return
    setRollingBack(true)
    setProblem(null)
    try {
      const response = await fetch(marketUrl('rollback'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: operation.operationId }),
      })
      const body = await readJson(response)
      if (!response.ok || !body.operation) {
        setProblem(body.error ?? `回滚请求失败（HTTP ${response.status}）`)
        return
      }
      setOperation(body.operation)
    } catch (error) {
      setProblem(String(error?.message ?? error))
    } finally {
      setRollingBack(false)
    }
  }

  const retryableForce = operation?.failure?.code === 'RELEASE_TOO_FRESH' || operation?.failure?.code === 'VERSION_UNCHANGED'
  const showOperation = operation !== null

  return React.createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    React.createElement(
      'div',
      { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', paddingRight: headerInset } },
      React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        React.createElement('h3', { style: { margin: 0, fontSize: 15, fontWeight: 600 } }, TEXT.updateTitle),
        React.createElement('p', { style: { margin: 0, ...mutedText } }, TEXT.updatableHint),
      ),
      React.createElement(
        'button',
        { type: 'button', disabled: !marketReady || checking || active, onClick: () => void check(), style: marketReady && !checking && !active ? buttonStyle : { ...buttonStyle, opacity: 0.5, cursor: 'default' } },
        checking ? TEXT.checking : TEXT.check,
      ),
    ),
    capabilities === undefined ? React.createElement(Working, { text: TEXT.marketChecking }) : null,
    capabilities === null ? React.createElement('p', { style: { margin: 0, ...mutedText } }, TEXT.noMarket) : null,
    capabilities === null ? null : rows === null && !checking
      ? React.createElement('p', { style: { margin: 0, ...mutedText } }, TEXT.notChecked)
      : null,
    checking ? React.createElement(Working, { text: TEXT.checking }) : null,
    rows !== null && !checking
      ? React.createElement(
          'p',
          { style: { margin: 0, ...mutedText } },
          rows.length === 0 ? TEXT.upToDate : `${TEXT.checkedCount} ${capabilities?.marketVersion ?? ''} · ${rows.length} ${TEXT.updatable}`,
        )
      : null,
    rows === null || rows.length === 0
      ? null
      : React.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          ...rows.map((row) =>
            React.createElement(
              'div',
              {
                key: row.name,
                style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1, #d1d5db)' },
              },
              React.createElement(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
                React.createElement('code', { style: { fontSize: 13 } }, row.name),
                React.createElement(
                  'span',
                  { style: { ...mutedText, fontVariantNumeric: 'tabular-nums' } },
                  `${row.installedVersion ?? '?'} → ${row.latestVersion ?? '?'}${row.source && row.source !== 'npm' ? ` · ${row.source}` : ''}`,
                ),
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  disabled: active || busyName !== null,
                  onClick: () => void startUpdate(row.name),
                  style: active || busyName !== null ? { ...primaryButtonStyle, opacity: 0.5, cursor: 'default' } : primaryButtonStyle,
                },
                busyName === row.name ? TEXT.updating : TEXT.update,
              ),
            ),
          ),
        ),
    problem === null ? null : React.createElement('p', { style: { margin: 0, fontSize: 13, color: ERROR_INK } }, problem),
    !showOperation ? null : React.createElement(OperationCard, { operation, retryableForce, rollingBack, onForce: () => void startUpdate(operation.packageName, true), onRollback: () => void rollback() }),
  )
}

/**
 * The version line of an operation card: no arrow until the version moved.
 * @param operation - the operation record.
 * @returns the text for the card's version slot.
 */
function versionLine(operation) {
  const before = operation.beforeVersion
  const after = operation.installedVersion
  if (before === undefined || before === null || before === '') return after ?? ''
  if (after === undefined || after === null || after === '' || after === before) return before
  return `${before} → ${after}`
}

/**
 * One market operation: progress, versions, failure and the follow-up actions.
 * @param props - the operation record plus the callbacks it can trigger.
 * @returns the operation card.
 */
function OperationCard({ operation, retryableForce, rollingBack, onForce, onRollback }) {
  const state = operation.state
  const active = state === 'queued' || state === 'running'
  const succeeded = state === 'succeeded'
  const rolledBack = state === 'rolled-back'
  const failure = operation.failure
  const progress = operation.progress ?? {}
  const rollbackAvailable = operation.outcome?.rollback?.available === true

  // A ticking clock, so a slow pnpm run looks slow instead of looking dead.
  const [now, setNow] = React.useState(Date.now())
  React.useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  const startedAt = operation.startedAt ?? operation.createdAt
  const elapsed = active && typeof startedAt === 'number' ? Math.max(0, Math.round((now - startedAt) / 1000)) : null

  const headline = active ? `${TEXT.updating} ${operation.packageName}` : succeeded ? `${TEXT.updated} ${operation.packageName}` : rolledBack ? TEXT.rolledBack : `${TEXT.updateFailed} ${operation.packageName}`
  const color = active ? 'inherit' : succeeded || rolledBack ? SUCCESS_INK : ERROR_INK

  return React.createElement(
    'div',
    { style: cardStyle },
    React.createElement(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
      React.createElement('strong', { style: { fontSize: 13, color } }, headline),
      React.createElement(
        'code',
        { style: { fontSize: 12, fontVariantNumeric: 'tabular-nums' } },
        versionLine(operation),
      ),
      elapsed === null
        ? null
        : React.createElement('span', { style: { ...mutedText, fontVariantNumeric: 'tabular-nums' } }, `${TEXT.elapsed} ${elapsed}s`),
    ),
    active
      ? React.createElement(ProgressBar, {
          percent: progress.percent,
          phase: progress.phase ?? (state === 'queued' ? null : state),
          detail: progress.detail ?? null,
          downloaded: progress.downloaded ?? null,
          size: progress.size ?? null,
        })
      : null,
    active ? React.createElement(PhaseStrip, { phase: progress.phase ?? null }) : null,
    active ? React.createElement('p', { style: { margin: 0, fontSize: 11, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, #9ca3af)' } }, TEXT.stallHint) : null,
    operation.wait === null || operation.wait === undefined
      ? null
      : React.createElement('p', { style: { margin: 0, ...mutedText } }, `${TEXT.queuedWaiting}（${operation.wait.activeCount} 个对话）`),
    failure === null || failure === undefined
      ? null
      : React.createElement('p', { style: { margin: 0, fontSize: 13, lineHeight: 1.6 } }, failureText(failure)),
    succeeded || rolledBack ? React.createElement('p', { style: { margin: 0, ...mutedText } }, TEXT.restartNeeded) : null,
    !active && (retryableForce || (rollbackAvailable && !rolledBack))
      ? React.createElement(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          retryableForce
            ? React.createElement('button', { type: 'button', onClick: onForce, style: buttonStyle }, TEXT.force)
            : null,
          rollbackAvailable && !rolledBack
            ? React.createElement('button', { type: 'button', disabled: rollingBack, onClick: onRollback, style: buttonStyle }, rollingBack ? TEXT.rollingBack : TEXT.rollback)
            : null,
        )
      : null,
  )
}

/**
 * Remove one installed plugin.
 *
 * Removal runs through this package's host bridge, which retries a refused
 * `bundle-in-use` by disabling the bundle first and finally by dropping it
 * from the profile manifest, so the button never dead-ends in a message the
 * user cannot act on. What the host could achieve is reported per step.
 *
 * @returns the installed-plugins section.
 */
function InstalledSection() {
  const [bundles, setBundles] = React.useState(null)
  const [problem, setProblem] = React.useState(null)
  const [confirmName, setConfirmName] = React.useState(null)
  const [busyName, setBusyName] = React.useState(null)
  const [outcome, setOutcome] = React.useState(null)
  const [pending, setPending] = React.useState([])
  const [cleanup, setCleanup] = React.useState(null)
  const [cleaning, setCleaning] = React.useState(false)

  const load = async () => {
    try {
      const response = await fetch(apiUrl('bundles'), { cache: 'no-store' })
      const body = await readJson(response)
      if (!response.ok) {
        setProblem(body.message ?? `请求失败（HTTP ${response.status}）`)
        return
      }
      setProblem(null)
      setBundles(Array.isArray(body.bundles) ? body.bundles : [])
    } catch (error) {
      setProblem(String(error?.message ?? error))
    }
    try {
      const response = await fetch(apiUrl('cleanup'), { cache: 'no-store' })
      const body = await readJson(response)
      setPending(Array.isArray(body.entries) ? body.entries : [])
    } catch {
      // The cleanup list is advisory: a failure just hides that block.
    }
  }

  const cleanNow = async () => {
    setCleaning(true)
    setCleanup(null)
    try {
      const response = await fetch(apiUrl('cleanup'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const body = await readJson(response)
      if (!response.ok) {
        setProblem(body.message ?? `请求失败（HTTP ${response.status}）`)
      } else {
        const results = Array.isArray(body.results) ? body.results : []
        setCleanup({
          cleaned: results.filter((item) => item.outcome === 'removed' || item.outcome === 'unlinked' || item.outcome === 'missing').length,
          failed: results.filter((item) => item.outcome === 'failed').length,
          skipped: results.filter((item) => item.outcome === 'declared-again').length,
        })
        setPending(Array.isArray(body.remaining) ? body.remaining : [])
      }
    } catch (error) {
      setProblem(String(error?.message ?? error))
    }
    setCleaning(false)
  }

  React.useEffect(() => {
    void load()
  }, [])

  const waitForJob = async (jobId) => {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 800))
      const response = await fetch(apiUrl(`job?id=${encodeURIComponent(jobId)}`), { cache: 'no-store' })
      const body = await readJson(response)
      if (body?.status === 'done' || response.status === 404) return body
    }
  }

  const remove = async (name) => {
    setConfirmName(null)
    setBusyName(name)
    setOutcome(null)
    try {
      const response = await fetch(apiUrl('remove'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const body = await readJson(response)
      if (!response.ok) {
        setProblem(body.message ?? `请求失败（HTTP ${response.status}）`)
        setBusyName(null)
        return
      }
      const job = await waitForJob(body.jobId)
      setOutcome({ name, result: job?.result ?? { ok: false, message: '任务已丢失，请刷新页面确认结果。' } })
      setBusyName(null)
      void load()
    } catch (error) {
      setProblem(String(error?.message ?? error))
      setBusyName(null)
    }
  }

  const rows = (bundles ?? []).filter((bundle) => bundle.installed !== false || bundle.enabled === true)

  return React.createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    React.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      React.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between', paddingRight: headerInset } },
        React.createElement('h3', { style: { margin: 0, fontSize: 15, fontWeight: 600 } }, TEXT.installedTitle),
        React.createElement('button', { type: 'button', onClick: () => void load(), style: buttonStyle }, TEXT.refresh),
      ),
      React.createElement('p', { style: { margin: 0, ...mutedText } }, TEXT.installedHint),
    ),
    problem === null ? null : React.createElement('p', { style: { margin: 0, fontSize: 13, color: ERROR_INK } }, problem),
    bundles === null ? React.createElement(Working, { text: TEXT.loadingBundles }) : null,
    bundles !== null && rows.length === 0 ? React.createElement('p', { style: { margin: 0, ...mutedText } }, TEXT.noBundles) : null,
    ...rows.map((bundle) =>
      React.createElement(
        'div',
        {
          key: bundle.name,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l1, #d1d5db)',
          },
        },
        React.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 } },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
            React.createElement('code', { style: { fontSize: 13 } }, bundle.name),
            bundle.version === undefined ? null : React.createElement('span', { style: mutedText }, bundle.version),
            React.createElement('span', { style: { ...mutedText, color: bundle.enabled ? SUCCESS_INK : undefined } }, bundle.enabled ? TEXT.enabled : TEXT.disabled),
          ),
          bundle.description === undefined ? null : React.createElement('span', { style: { ...mutedText, overflow: 'hidden', textOverflow: 'ellipsis' } }, bundle.description),
          bundle.name === PACKAGE_ID ? React.createElement('span', { style: { ...mutedText, color: WARN_INK } }, TEXT.selfHint) : null,
          bundle.removable !== true ? React.createElement('span', { style: mutedText }, TEXT.notRemovable) : null,
        ),
        busyName === bundle.name
          ? React.createElement(Working, { text: TEXT.removing })
          : confirmName === bundle.name
            ? React.createElement(
                'div',
                { style: { display: 'flex', gap: 6 } },
                React.createElement('button', { type: 'button', onClick: () => void remove(bundle.name), style: { ...buttonStyle, color: ERROR_INK } }, TEXT.confirmRemove),
                React.createElement('button', { type: 'button', onClick: () => setConfirmName(null), style: buttonStyle }, TEXT.cancel),
              )
            : React.createElement(
                'button',
                {
                  type: 'button',
                  disabled: busyName !== null || bundle.removable !== true,
                  onClick: () => setConfirmName(bundle.name),
                  style: bundle.removable === true ? buttonStyle : { ...buttonStyle, opacity: 0.5, cursor: 'default' },
                },
                TEXT.remove,
              ),
      ),
    ),
    pending.length === 0 && cleanup === null
      ? null
      : React.createElement(
          'div',
          { style: { ...cardStyle, background: 'transparent' } },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'flex-start', gap: 10, justifyContent: 'space-between' } },
            React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 } },
              React.createElement('strong', { style: { fontSize: 13 } }, `${TEXT.pendingTitle}（${pending.length}）`),
              React.createElement('span', { style: mutedText }, pending.length === 0 ? TEXT.cleanupNothing : TEXT.pendingHint),
              ...pending.map((entry, index) =>
                React.createElement('code', { key: index, style: { fontSize: 12 } }, entry.name),
              ),
            ),
            cleaning
              ? React.createElement(Working, { text: TEXT.cleaning })
              : pending.length > 0
                ? React.createElement('button', { type: 'button', onClick: () => void cleanNow(), style: buttonStyle }, TEXT.cleanupNow)
                : null,
          ),
          cleanup === null
            ? null
            : React.createElement(
                'span',
                { style: { ...mutedText, color: cleanup.failed > 0 ? WARN_INK : SUCCESS_INK } },
                `${TEXT.cleanupDone} ${cleanup.cleaned}` +
                  (cleanup.failed > 0 ? `，${cleanup.failed} ${TEXT.cleanupFailedCount}` : ''),
              ),
        ),
    outcome === null
      ? null
      : React.createElement(
          'div',
          { style: cardStyle },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
            React.createElement('strong', { style: { fontSize: 13, color: outcome.result.ok ? SUCCESS_INK : ERROR_INK } }, outcome.result.ok ? `${TEXT.removed} ${outcome.name}` : `${TEXT.removeFailed} ${outcome.name}`),
          ),
          outcome.result.message === undefined ? null : React.createElement('p', { style: { margin: 0, fontSize: 13, lineHeight: 1.6 } }, outcome.result.message),
          outcome.result.bypassed === 'disable-first' ? React.createElement('p', { style: { margin: 0, ...mutedText } }, TEXT.bypassedDisable) : null,
          outcome.result.bypassed === 'manifest-only' ? React.createElement('p', { style: { margin: 0, ...mutedText } }, TEXT.bypassedManifest) : null,
          outcome.result.pendingRestart === true ? React.createElement('p', { style: { margin: 0, ...mutedText } }, TEXT.restartNeeded) : null,
          Array.isArray(outcome.result.steps) && outcome.result.steps.length > 0
            ? React.createElement(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 2, ...mutedText } },
                ...outcome.result.steps.map((step, index) =>
                  React.createElement(
                    'span',
                    { key: index },
                    `${step.ok ? '✓' : '×'} ${step.action}${step.errorCode === undefined ? '' : ` (${step.errorCode})`}`,
                  ),
                ),
              )
            : null,
        ),
  )
}

/**
 * The tab body.
 * @returns both sections.
 */
function InstallPanel() {
  return React.createElement(
    'div',
    { className: 'dsh-plugin-installer-panel', style: { display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 720, paddingTop: 8 } },
    React.createElement(
      'style',
      null,
      '@keyframes dsh-plugin-installer-spin{to{transform:rotate(360deg)}}',
      '@keyframes dsh-plugin-installer-bar{0%{transform:translateX(-110%)}55%{transform:translateX(70%)}100%{transform:translateX(260%)}}',
      `.dsh-plugin-installer-panel button{transition:filter 120ms ease,opacity 120ms ease}
.dsh-plugin-installer-panel button:hover:not(:disabled){filter:brightness(0.94)}
.dsh-plugin-installer-panel button:focus-visible{outline:2px solid ${ACCENT};outline-offset:2px}
.dsh-plugin-installer-panel button:disabled{cursor:default}`,
    ),
    React.createElement(InstallSection),
    React.createElement('hr', { style: { margin: 0, border: 0, borderTop: '1px solid var(--dsw-alias-border-l1, #d1d5db)' } }),
    React.createElement(UpdateSection),
    React.createElement('hr', { style: { margin: 0, border: 0, borderTop: '1px solid var(--dsw-alias-border-l1, #d1d5db)' } }),
    React.createElement(InstalledSection),
  )
}

window.__ModuleLoader__.load({
  id: PACKAGE_ID,
  factory(require) {
    React = require('react')
    return {
      inject: ['slots'],
      apply(ctx) {
        return ctx.slots.inject('plugins.tab', () =>
          ctx.slots.register(
            {
              name: 'plugins.tab',
              id: PACKAGE_ID,
              order: 10,
              label: () => '安装 / 更新 / 卸载',
            },
            InstallPanel,
          ),
        )
      },
    }
  },
})
