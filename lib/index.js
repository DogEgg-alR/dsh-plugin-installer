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

import { lstat, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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

/** Subdirectory under the profile that holds this package's own state. */
const STATE_DIR = '.dsh-plugin-installer'

/** File recording packages whose files are still on disk after a removal. */
const PENDING_FILE = 'pending-cleanup.json'

/** How long after boot the startup sweep runs, in milliseconds. */
const SWEEP_DELAY_MS = 10 * 1000

/** Result of the most recent sweep, so the Client can show it after a reload. */
let lastCleanup = null

/**
 * Where the pending-cleanup file lives for one profile.
 * @param profileDir - the profile directory.
 * @returns the absolute path of the queue file.
 */
function pendingPath(profileDir) {
  return join(profileDir, STATE_DIR, PENDING_FILE)
}

/**
 * Read the pending-cleanup queue.
 * @param profileDir - the profile directory.
 * @returns the queued entries; an unreadable or malformed file reads as empty.
 */
async function readPending(profileDir) {
  if (typeof profileDir !== 'string' || profileDir === '') return []
  try {
    const parsed = JSON.parse(await readFile(pendingPath(profileDir), 'utf8'))
    return Array.isArray(parsed?.entries) ? parsed.entries.filter((entry) => typeof entry?.name === 'string') : []
  } catch {
    return []
  }
}

/**
 * Persist the pending-cleanup queue atomically.
 * @param profileDir - the profile directory.
 * @param entries - the entries to keep.
 */
async function writePending(profileDir, entries) {
  if (typeof profileDir !== 'string' || profileDir === '') return
  const file = pendingPath(profileDir)
  await mkdir(join(profileDir, STATE_DIR), { recursive: true })
  if (entries.length === 0) {
    await rm(file, { force: true })
    return
  }
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify({ schema: 'dsh-plugin-installer/pending-cleanup/v1', entries }, null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

/**
 * Remember a package whose files stayed behind, so a later boot can prune them.
 * @param profileDir - the profile directory.
 * @param name - the package that was dropped from the manifest.
 */
async function rememberLeftover(profileDir, name) {
  const entries = await readPending(profileDir)
  if (entries.some((entry) => entry.name === name)) return
  entries.push({ name, recordedAt: new Date().toISOString(), attempts: 0 })
  await writePending(profileDir, entries)
}

/**
 * Whether the profile still declares one package.
 * @param profileDir - the profile directory.
 * @param name - the package name.
 * @returns true when it is a dependency again (someone reinstalled it).
 */
async function stillDeclared(profileDir, name) {
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    if (Object.hasOwn(manifest.dependencies ?? {}, name)) return true
    return (manifest.dsh?.profile?.bundles ?? []).includes(name)
  } catch {
    return false
  }
}

/**
 * Delete one leftover top-level entry under `node_modules`.
 *
 * Only the link or directory itself is touched: pnpm keeps an installed
 * package's real content under `node_modules/.pnpm`, and a `link:` install
 * points at the author's working copy, so both must survive. A junction or
 * symlink is unlinked; a plain directory is removed recursively.
 *
 * @param profileDir - the profile directory.
 * @param name - the package name.
 * @returns `'missing'`, `'unlinked'`, or `'removed'`.
 */
async function dropLeftover(profileDir, name) {
  const target = join(profileDir, 'node_modules', ...name.split('/'))
  let stats
  try {
    stats = await lstat(target)
  } catch {
    return 'missing'
  }
  if (stats.isSymbolicLink()) {
    await unlink(target)
    return 'unlinked'
  }
  if (!stats.isDirectory()) {
    await unlink(target)
    return 'unlinked'
  }
  await rm(target, { recursive: true, force: true })
  return 'removed'
}

/**
 * Prune every queued leftover whose package is no longer declared.
 * @param profileDir - the profile directory.
 * @returns per-package outcomes, and the queue that remains.
 */
async function sweepLeftovers(profileDir) {
  const entries = await readPending(profileDir)
  if (entries.length === 0) return { results: [], remaining: [] }
  const remaining = []
  const results = []
  for (const entry of entries) {
    try {
      if (await stillDeclared(profileDir, entry.name)) {
        results.push({ name: entry.name, outcome: 'declared-again' })
        continue
      }
      const outcome = await dropLeftover(profileDir, entry.name)
      results.push({ name: entry.name, outcome })
    } catch (error) {
      results.push({ name: entry.name, outcome: 'failed', message: String(error?.message ?? error) })
      remaining.push({ ...entry, attempts: (entry.attempts ?? 0) + 1, lastError: String(error?.message ?? error) })
    }
  }
  await writePending(profileDir, remaining)
  lastCleanup = { at: new Date().toISOString(), results, remaining: remaining.length }
  return { results, remaining }
}

/**
 * Build the `GET`/`POST /api/cleanup` handler: report and prune leftovers.
 * @param hostCtx - host context, used only to resolve the profile directory.
 * @returns the route handler.
 */
function cleanupHandler(hostCtx) {
  return async (request, response) => {
    const profileDir = hostCtx.get('profileContext')?.dir ?? process.env.DSH_PROFILE_DIR
    if (request.method === 'GET') {
      if (typeof profileDir !== 'string' || profileDir === '') {
        sendJson(response, 200, { entries: [], last: lastCleanup })
        return
      }
      sendJson(response, 200, { entries: await readPending(profileDir), last: lastCleanup })
      return
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'method-not-allowed', message: '请用 GET 或 POST 调用。' })
      return
    }
    if (!sameOrigin(request)) {
      sendJson(response, 403, { error: 'forbidden', message: '只接受本页发起的清理请求。' })
      return
    }
    if (typeof profileDir !== 'string' || profileDir === '') {
      sendJson(response, 200, { results: [], remaining: [], message: '不知道 profile 目录，无法清理。' })
      return
    }
    try {
      const swept = await sweepLeftovers(profileDir)
      sendJson(response, 200, swept)
    } catch (error) {
      sendJson(response, 500, { error: 'cleanup-failed', message: String(error?.message ?? error) })
    }
  }
}

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
      return '当前 profile 没有热重载，正在运行的包要先停后才能移除；请重启后再试，或先到设置 → 插件里停用。'
    case 'bundle-in-use':
      return '这个组合包还有组件正在运行，管理端拒绝在运行中删文件。已尝试「先停用再移除」，仍失败时会退回到只摘除配置。'
    case 'not-removable':
      return '这个包不属于本 profile（是随应用发布的），只能停用，不能卸载。'
    case 'management-required':
      return '插件管理器本身不能卸载，它要负责这个页面。'
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

/** Shape of one npm package name, scoped or not. */
const NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i

/**
 * Decide whether one name is a package this profile could own.
 * @param value - the untrusted request value.
 * @returns a Chinese explanation when refused, or `undefined` when accepted.
 */
function nameProblem(value) {
  if (typeof value !== 'string' || value.trim() === '') return '缺少插件名'
  const text = value.trim()
  if (text.length > 214) return '插件名过长'
  if (!NAME_PATTERN.test(text)) return '插件名不合法'
  return undefined
}

/**
 * Project one change result into a step the Client can list.
 * @param action - what the step tried.
 * @param result - the manager's change result.
 * @returns the JSON-safe step.
 */
function stepOf(action, result) {
  const error = result?.error
  return {
    action,
    ok: error === undefined && result?.application !== 'failed' && result?.application !== 'cancelled',
    application: result?.application,
    errorCode: error?.code,
    message: describeError(error),
  }
}

/**
 * Take a package out of the profile manifest without running pnpm.
 *
 * This is the last resort when the manager refuses to delete files under a
 * running plugin: the dependency and the bundle selection are removed, so the
 * next boot composes a profile without it, while the files below
 * `node_modules` stay where they are (unused, and replaced by the next
 * install). Nothing running is disturbed, so this is safe to do at any time.
 *
 * @param dir - the profile directory.
 * @param name - the package to drop.
 * @returns what was actually removed.
 */
async function dropFromManifest(dir, name) {
  const file = join(dir, 'package.json')
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  const dependencies = manifest.dependencies ?? {}
  const selected = manifest.dsh?.profile?.bundles ?? []
  const hadDependency = Object.hasOwn(dependencies, name)
  const hadBundle = selected.includes(name)
  if (!hadDependency && !hadBundle) return { ok: false, reason: 'absent' }
  if (hadDependency) delete dependencies[name]
  manifest.dependencies = dependencies
  if (manifest.dsh?.profile !== undefined) {
    manifest.dsh.profile.bundles = selected.filter((item) => item !== name)
  }
  const text = `${JSON.stringify(manifest, null, 2)}\n`
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, text, 'utf8')
  await rename(temp, file)
  return { ok: true, removedDependency: hadDependency, removedBundle: hadBundle }
}

/**
 * Remove one bundle, working around the manager's in-use refusal.
 *
 * `pluginManager.removeBundle()` refuses with `bundle-in-use` when a hot
 * unload could not take the bundle's entries down, which happens for packages
 * loaded from outside the profile directory (a `link:` dependency, for one).
 * The guard is not a policy switch: it protects the running process from
 * having files pulled out from under live code. Two things are still allowed,
 * and both are attempted in order:
 *
 * 1. disable the bundle first, which stops its entries, then remove;
 * 2. drop it from the profile manifest only, so the next boot does not compose
 *    it, leaving the files in place for a later cleanup.
 *
 * @param manager - the profile's `pluginManager`.
 * @param name - the bundle to remove.
 * @param profileDir - the profile directory, when known.
 * @returns the outcome with one step per attempt.
 */
async function removeFlow(manager, name, profileDir) {
  const steps = []
  const first = await manager.removeBundle(name)
  steps.push(stepOf('remove', first))
  if (first?.error === undefined) {
    return {
      ok: true,
      steps,
      application: first?.application,
      restartReason: first?.restartReason,
      pendingRestart: first?.application === 'restart-required',
    }
  }
  const blocked = first.error.code
  if (blocked !== 'bundle-in-use' && blocked !== 'stop-profile') {
    return {
      ok: false,
      steps,
      errorCode: blocked,
      message: describeError(first.error),
      diagnostic: typeof first.error.diagnostic === 'string' ? first.error.diagnostic.slice(0, 4000) : undefined,
    }
  }
  const disabled = await manager.setBundleEnabled(name, false)
  steps.push(stepOf('disable', disabled))
  const second = await manager.removeBundle(name)
  steps.push(stepOf('remove-again', second))
  if (second?.error === undefined) {
    return {
      ok: true,
      steps,
      bypassed: 'disable-first',
      application: second?.application,
      restartReason: second?.restartReason,
      pendingRestart: second?.application === 'restart-required',
    }
  }
  if (profileDir === undefined) {
    return {
      ok: false,
      steps,
      errorCode: second.error.code,
      message: describeError(second.error),
    }
  }
  let fallback
  try {
    fallback = await dropFromManifest(profileDir, name)
  } catch (error) {
    fallback = { ok: false, reason: 'error', message: String(error?.message ?? error) }
  }
  if (fallback.ok) {
    try {
      await rememberLeftover(profileDir, name)
    } catch {
      // Losing the note only means the files stay until a manual cleanup.
    }
  }
  steps.push({
    action: 'manifest',
    ok: fallback.ok,
    message: fallback.ok ? '已从 profile 配置里摘除，文件会在重启后自动清掉。' : `配置文件里没有这个插件（${fallback.reason}）。`,
  })
  return {
    ok: fallback.ok,
    steps,
    bypassed: fallback.ok ? 'manifest-only' : undefined,
    manifestFallback: fallback,
    pendingRestart: fallback.ok,
    errorCode: fallback.ok ? undefined : second.error.code,
    message: fallback.ok ? undefined : describeError(second.error),
  }
}

/**
 * Build the `GET /api/bundles` handler: the list the remove section renders.
 * @param hostCtx - host context that can resolve `pluginManager`.
 * @returns the route handler.
 */
function bundlesHandler(hostCtx) {
  return async (request, response) => {
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'method-not-allowed', message: '请用 GET 调用。' })
      return
    }
    const manager = hostCtx.get('pluginManager')
    if (manager === undefined) {
      sendJson(response, 503, { error: 'no-plugin-manager', message: '此宿主没有 pluginManager 服务。' })
      return
    }
    try {
      const bundles = await manager.listBundles()
      sendJson(response, 200, {
        bundles: bundles.map((bundle) => ({
          name: bundle.name,
          version: typeof bundle.version === 'string' ? bundle.version : undefined,
          description: typeof bundle.description === 'string' ? bundle.description.slice(0, 240) : undefined,
          enabled: bundle.enabled === true,
          installed: bundle.installed === true,
          removable: bundle.removable === true,
          official: bundle.official === true,
          readOnlyReason: bundle.readOnlyReason,
          errorCode: bundle.error?.code,
        })),
      })
    } catch (error) {
      sendJson(response, 500, { error: 'list-failed', message: String(error?.message ?? error) })
    }
  }
}

/**
 * Build the `POST /api/remove` handler; the removal runs as a background job
 * like an install, because it may run pnpm.
 * @param hostCtx - host context that can resolve `pluginManager`.
 * @returns the route handler.
 */
function removeHandler(hostCtx) {
  return async (request, response) => {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'method-not-allowed', message: '请用 POST 调用。' })
      return
    }
    if (!sameOrigin(request)) {
      sendJson(response, 403, { error: 'forbidden', message: '只接受本页发起的移除请求。' })
      return
    }
    let body
    try {
      body = await readJson(request)
    } catch (error) {
      sendJson(response, 400, { error: 'bad-body', message: String(error?.message ?? error) })
      return
    }
    const target = typeof body?.name === 'string' ? body.name.trim() : ''
    const problem = nameProblem(target)
    if (problem !== undefined) {
      sendJson(response, 400, { error: 'invalid-name', message: problem })
      return
    }
    const manager = hostCtx.get('pluginManager')
    if (manager === undefined) {
      sendJson(response, 503, {
        error: 'no-plugin-manager',
        message: '此宿主没有 pluginManager 服务，无法在应用内移除。',
      })
      return
    }
    sweepJobs()
    const jobId = globalThis.crypto.randomUUID()
    const profileDir = hostCtx.get('profileContext')?.dir ?? process.env.DSH_PROFILE_DIR
    jobs.set(jobId, { kind: 'remove', name: target, status: 'running', startedAt: Date.now() })
    void (async () => {
      const startedAt = jobs.get(jobId)?.startedAt ?? Date.now()
      try {
        const result = await removeFlow(manager, target, profileDir)
        jobs.set(jobId, { kind: 'remove', name: target, status: 'done', startedAt, finishedAt: Date.now(), result })
      } catch (error) {
        jobs.set(jobId, {
          kind: 'remove',
          name: target,
          status: 'done',
          startedAt,
          finishedAt: Date.now(),
          result: {
            ok: false,
            message: String(error?.message ?? error),
            errorCode: typeof error?.code === 'string' ? error.code : undefined,
          },
        })
      }
    })()
    sendJson(response, 202, { jobId })
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
      const offBundles = hostCtx.webServer.register({
        kind: 'exact',
        path: `${BASE}/api/bundles`,
        handler: bundlesHandler(hostCtx),
      })
      const offRemove = hostCtx.webServer.register({
        kind: 'exact',
        path: `${BASE}/api/remove`,
        handler: removeHandler(hostCtx),
      })
      const offCleanup = hostCtx.webServer.register({
        kind: 'exact',
        path: `${BASE}/api/cleanup`,
        handler: cleanupHandler(hostCtx),
      })
      return () => {
        offInstall()
        offJob()
        offBundles()
        offRemove()
        offCleanup()
      }
    })
  })

  // Leftovers recorded by an earlier run are pruned once the app has settled,
  // so a restart is enough: no CLI, no manual step.
  const profileDir = ctx.get('profileContext')?.dir ?? process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir !== '') {
    const timer = setTimeout(() => {
      void sweepLeftovers(profileDir).catch(() => {})
    }, SWEEP_DELAY_MS)
    timer.unref?.()
    ctx.effect(() => () => clearTimeout(timer))
  }
}
