/**
 * Host half of `dsh-plugin-installer`.
 *
 * The Client tab cannot reach a host service directly: a package without
 * generated Typert bindings talks to its host half over HTTP like any other
 * browser caller. So this half mounts a two-route JSON bridge under
 * `/dsh-plugin-installer/api/` on the profile's `webServer`, and the actual
 * installation is performed by the profile's own `pluginManager` service —
 * the same implementation behind Settings → Plugins, the one that runs pnpm
 * inside this process and therefore works while Desktop is running (the
 * `dsh plugin --profile desktop` CLI does not, because the app owns the
 * profile and its package-manager lock while it is up).
 *
 * The install runs as a background job: pnpm takes tens of seconds, and an
 * open POST that long invites proxy and app-layer timeouts, so POST answers
 * `202 { jobId }` at once and the Client polls the job route.
 *
 * @module dsh-plugin-installer
 */

/** Stable name used by the loader row and by the Client factory id. */
export const name = 'dsh-plugin-installer'

/** Route prefix owned by this package; nothing else may claim it. */
const BASE = '/dsh-plugin-installer'

/** Largest accepted POST body: a spec line and nothing else. */
const MAX_BODY_BYTES = 8 * 1024

/** Jobs older than this are forgotten; the Client polls within seconds. */
const JOB_TTL_MS = 30 * 60 * 1000

/** Live install jobs, newest last, keyed by the id the Client polls. */
const jobs = new Map()

/**
 * Write one JSON response.
 * @param response - the Node response the route received.
 * @param status - HTTP status code.
 * @param body - JSON-serializable payload.
 */
function sendJson(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

/**
 * Accept only browser callers of this very page.
 *
 * The install route starts a package-manager run with this process's
 * privileges, so a cross-site page must not reach it. Desktop serves its page
 * from a custom scheme, where `sec-fetch-site` is sometimes absent and
 * `origin` is `null`; a missing header pair therefore passes, while a header
 * that is present and foreign is always refused.
 *
 * @param request - the incoming route request.
 * @returns whether the caller may reach the install routes.
 */
function sameOrigin(request) {
  const site = request.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin === 'null') return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

/**
 * Read and parse a bounded JSON request body.
 * @param request - the incoming route request.
 * @returns the parsed JSON value.
 */
async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return undefined
  return JSON.parse(text)
}

/**
 * Decide whether one spec is worth handing to the package manager.
 *
 * The manager forwards the spec to pnpm as an argument (never through a
 * shell), so this is not an injection guard — it is the check that catches the
 * ordinary mistakes early, with a readable message instead of a pnpm stack
 * trace: an option-looking string, an empty string, or a line break.
 *
 * @param spec - trimmed user input.
 * @returns a Chinese explanation when refused, or `undefined` when accepted.
 */
function specProblem(spec) {
  if (spec === '') return '请输入要安装的插件'
  if (spec.startsWith('-')) return '插件标识不能以 - 开头'
  if (/[\r\n\t]/.test(spec)) return '插件标识不能包含换行或制表符'
  if (spec.length > 512) return '插件标识过长'
  return undefined
}

/**
 * Project one `ChangeResult` into the small, JSON-safe shape the tab renders.
 * @param result - the manager's change result.
 * @returns the payload the Client stores on the job.
 */
function summarize(result) {
  const error = result?.error
  const payload = result?.packageResult
  return {
    ok: error === undefined && result?.application !== 'failed',
    changed: result?.changed === true,
    application: result?.application,
    restartReason: result?.restartReason,
    stage: result?.stage,
    target: result?.target,
    bundle: result?.bundle,
    version: result?.version,
    enabled: result?.enabled,
    warnings: Array.isArray(result?.warnings) ? result.warnings.slice(0, 20) : undefined,
    pendingBuilds: Array.isArray(result?.pendingBuilds) ? result.pendingBuilds : undefined,
    failedAt: result?.failedAt,
    errorCode: error?.code,
    message: describeError(error),
    diagnostic: typeof error?.diagnostic === 'string' ? error.diagnostic.slice(0, 4000) : undefined,
    logPath: typeof payload?.logPath === 'string' ? payload.logPath : undefined,
    output: typeof payload?.output === 'string' ? payload.output.slice(-4000) : undefined,
  }
}

/**
 * Turn a management error code into one sentence a user can act on.
 * @param error - the `ManagementError` carried by a failed change.
 * @returns the sentence, or `undefined` when there is no error.
 */
function describeError(error) {
  if (error === undefined) return undefined
  switch (error.code) {
    case 'already-installed':
      return '该插件已安装；升级请先在「已安装」页卸载，或改用精确版本号重装。'
    case 'invalid-spec':
      return '无法识别的插件标识。'
    case 'ambiguous-install':
      return '这次安装改变了不止一个依赖，已回滚。请一次只装一个插件。'
    case 'not-bundle':
      return '这个包不是 DSH 插件包（缺少 dsh.bundle）。'
    case 'incompatible-version':
      return '该插件与本机 DSH 版本不兼容，安装已被拒绝。'
    case 'stop-profile':
      return '当前无法在此状态安装，请稍后再试。'
    case 'operation-error':
      return '包管理器执行失败，详见下方输出。'
    default:
      return typeof error.diagnostic === 'string' ? error.diagnostic.slice(0, 400) : `安装失败（${String(error.code)}）`
  }
}

/**
 * Drop jobs nobody will read again.
 */
function sweepJobs() {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (job.finishedAt !== undefined && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id)
  }
}

/**
 * Build the `POST /api/install` handler.
 * @param hostCtx - host context that can resolve `pluginManager`.
 * @returns the route handler.
 */
function installHandler(hostCtx) {
  return async (request, response) => {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'method-not-allowed', message: '请用 POST 调用。' })
      return
    }
    if (!sameOrigin(request)) {
      sendJson(response, 403, { error: 'forbidden', message: '只接受本页发起的安装请求。' })
      return
    }
    let body
    try {
      body = await readJson(request)
    } catch (error) {
      sendJson(response, 400, { error: 'bad-body', message: String(error?.message ?? error) })
      return
    }
    const spec = typeof body?.spec === 'string' ? body.spec.trim() : ''
    const problem = specProblem(spec)
    if (problem !== undefined) {
      sendJson(response, 400, { error: 'invalid-spec', message: problem })
      return
    }
    const manager = hostCtx.get('pluginManager')
    if (manager === undefined) {
      sendJson(response, 503, {
        error: 'no-plugin-manager',
        message: '此宿主没有 pluginManager 服务，无法在应用内安装。',
      })
      return
    }
    sweepJobs()
    const jobId = globalThis.crypto.randomUUID()
    jobs.set(jobId, { spec, status: 'running', startedAt: Date.now() })
    // Floating on purpose: the handler already answered 202, and the result is
    // picked up by the job route. A failure is recorded rather than thrown.
    void (async () => {
      try {
        const result = await manager.installBundle(spec, { requestId: jobId })
        jobs.set(jobId, { spec, status: 'done', startedAt: jobs.get(jobId)?.startedAt ?? Date.now(), finishedAt: Date.now(), result: summarize(result) })
      } catch (error) {
        jobs.set(jobId, {
          spec,
          status: 'done',
          startedAt: jobs.get(jobId)?.startedAt ?? Date.now(),
          finishedAt: Date.now(),
          result: {
            ok: false,
            message: describeError(error) ?? String(error?.message ?? error),
            errorCode: typeof error?.code === 'string' ? error.code : undefined,
            diagnostic: typeof error?.diagnostic === 'string' ? error.diagnostic.slice(0, 4000) : undefined,
          },
        })
      }
    })()
    sendJson(response, 202, { jobId })
  }
}

/**
 * Build the `GET /api/job` handler.
 * @returns the route handler.
 */
function jobHandler() {
  return (request, response) => {
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'method-not-allowed', message: '请用 GET 调用。' })
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    const id = url.searchParams.get('id') ?? ''
    const job = jobs.get(id)
    if (job === undefined) {
      sendJson(response, 404, { error: 'unknown-job', message: '没有这个安装任务（可能已过期）。' })
      return
    }
    sendJson(response, 200, job)
  }
}

/**
 * Mount the bridge once the profile composes its web server.
 * @param ctx - the host plugin context.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => {
      const offInstall = hostCtx.webServer.register({
        kind: 'exact',
        path: `${BASE}/api/install`,
        handler: installHandler(hostCtx),
      })
      const offJob = hostCtx.webServer.register({
        kind: 'exact',
        path: `${BASE}/api/job`,
        handler: jobHandler(),
      })
      return () => {
        offInstall()
        offJob()
      }
    })
  })
}
