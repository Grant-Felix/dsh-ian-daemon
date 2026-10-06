/**
 * @local/dsh-ian-daemon — Client half.
 *
 * Renders the manual "重启" control in two independent places, so one hidden
 * slot can never hide the feature:
 *
 *   - `conversation.composer.dock`  a compact pill under the composer
 *   - `sidebar.footer.action`       a full row beside Settings
 *
 * The restart lifecycle deliberately lives OUTSIDE React (see
 * `createRestartFlow`): the dock control sits in a session-scoped slot that
 * collapses as soon as the transport drops, so a component cleanup must never
 * abort a restart already in flight. The controls only read the shared flow
 * state and call `activate()`.
 *
 * Defensive rules learned the hard way:
 *   - a failing POST does not end the flow: the response is usually lost
 *     because the server dies first, and the restart may well have happened;
 *   - the page reloads whenever it is provably stale (the server pid moved, or
 *     the server went away and came back) — the SPA's own reconnect can keep
 *     using a stale launch token, so a fresh page load is the reliable end
 *     state;
 *   - the whole control sits inside `SafeBoundary`: a crash renders a plain
 *     working button instead of blanking the slot entry;
 *   - every step reports to the Host (`/event`), so a failure can be diagnosed
 *     from the server side.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-ian-daemon',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-ian-daemon'
    const BASE = '/dsh-ian-daemon'
    const zh = {
      restart: '重启',
      confirm: '确认重启？',
      busy: '重启中…',
      failed: '重启失败',
      timeout: '服务未恢复，请手动刷新',
      noeffect: '重启未生效',
      starting: '服务仍在启动，请稍后手动刷新',
      safe: '安全模式',
      hint: '重启 DeepSeek Harness',
      hintSafe: '重启 DeepSeek Harness（上次启动进入了安全模式）',
      unavailable: '无法读取服务状态',
    }
    const en = {
      restart: 'Restart',
      confirm: 'Confirm restart?',
      busy: 'Restarting…',
      failed: 'Restart failed',
      timeout: 'Service did not come back — reload the page',
      noeffect: 'Restart had no effect',
      starting: 'Service is still starting — reload in a moment',
      safe: 'Safe mode',
      hint: 'Restart DeepSeek Harness',
      hintSafe: 'Restart DeepSeek Harness (the last boot entered safe mode)',
      unavailable: 'Service status unavailable',
    }

    const CSS = `
.dsa-btn{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;
  font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;
  transition:background .12s ease,color .12s ease}
.dsa-btn:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsa-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid
  var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsa-btn[disabled]{opacity:.65;cursor:default}
.dsa-btn.dsa-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsa-btn.dsa-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dsa-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary)}
.dsa-spin{animation:dsa-spin 1s linear infinite}
@keyframes dsa-spin{to{transform:rotate(360deg)}}
.dsa-row{box-sizing:border-box;border-radius:var(--dsw-radius-md,8px);min-height:36px;width:100%;
  color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;background:0 0;
  border:none;align-items:center;gap:8px;margin:0 2px;padding:7px 8px;line-height:22px;display:flex}
.dsa-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsa-row:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid
  var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.dsa-row.dsa-rail{border-radius:var(--dsw-radius-md,8px);width:36px;height:36px;justify-content:center;margin:0;padding:0}
.dsa-row.dsa-warn{color:var(--dsw-alias-state-warn-primary)}
.dsa-rowLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
`

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    function postJson(path, body) {
      return fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'x-dsh-ian-daemon': '1', 'content-type': 'text/plain' },
        body,
        cache: 'no-store',
        // The page navigates immediately after the final report; keepalive lets
        // that report outlive the reload instead of being cancelled with it.
        keepalive: true,
      })
    }

    /** Best-effort lifecycle report; the Host appends it to state/client-events.jsonl. */
    function report(event, data) {
      try {
        const promise = postJson('/event', `${event} ${JSON.stringify(data ?? {})}`)
        if (promise && typeof promise.catch === 'function') promise.catch(() => {})
      } catch {
        /* reporting must never break the flow */
      }
    }

    async function readStatus() {
      const response = await fetch(`${BASE}/status?hb=1`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`status ${response.status}`)
      return await response.json()
    }

    /**
     * Decide whether the page is provably stale after a restart request. This is
     * the one decision that must not regress: getting it wrong leaves the user
     * on a dead page, so it is a pure function exposed to the test seam.
     */
    function decideAfterPoll(state) {
      const { before, next, sawDown } = state
      const stale = (next !== undefined && before !== null && next?.process?.pid !== before)
        || (sawDown && next !== undefined)
      if (!stale) return 'wait'
      // /status answers as soon as this plugin mounts, but the route the shell
      // needs (`/api`) is registered only after `appReady`. Reloading inside that
      // window lands on a page that cannot connect — the reported "stuck" page.
      if (next !== undefined && next.ready === false) return 'wait-not-ready'
      return 'reload'
    }

    /** The restart lifecycle. `deps` is injectable so a test can drive it in Node. */
    function createRestartFlow(deps) {
      const {
        status = readStatus,
        post = (path) => postJson(path, ''),
        reload = () => window.location.reload(),
        wait = sleep,
        now = () => Date.now(),
        translate = (key) => key,
        report: reportEvent = report,
      } = deps ?? {}

      const flow = {
        phase: 'idle',
        note: null,
        lastStatus: null,
        running: false,
        elapsed: 0,
        listeners: new Set(),
        timer: null,
        pollTimer: null,
        elapsedTimer: null,
      }

      const emit = () => {
        for (const listener of Array.from(flow.listeners)) {
          try { listener() } catch { /* one bad listener must not break the flow */ }
        }
      }
      const set = (patch) => { Object.assign(flow, patch); emit() }
      const subscribe = (listener) => { flow.listeners.add(listener); return () => flow.listeners.delete(listener) }

      /** One shared status poller for both controls; React mount churn must not stop it. */
      function ensurePolling() {
        if (flow.pollTimer !== null) return
        const tick = () => { status().then((next) => { flow.lastStatus = next; emit() }).catch(() => {}) }
        tick()
        flow.pollTimer = setInterval(tick, 20000)
      }

      async function run() {
        if (flow.running) return
        flow.running = true
        const before = flow.lastStatus?.process?.pid ?? null
        set({ phase: 'busy', note: null })
        reportEvent('restart:click', { pid: before })

        try {
          const response = await post('/restart')
          reportEvent('restart:posted', { ok: response?.ok === true, status: response?.status })
        } catch (error) {
          // The server usually dies before the response lands; the restart may
          // still have happened, so keep watching instead of giving up.
          reportEvent('restart:post-failed', { message: String(error?.message ?? error) })
        }

        const startedAt = now()
        const deadline = startedAt + 120000
        flow.elapsed = 0
        if (flow.elapsedTimer) clearInterval(flow.elapsedTimer)
        flow.elapsedTimer = setInterval(() => {
          flow.elapsed = Math.round((now() - startedAt) / 1000)
          emit()
        }, 1000)
        let answered
        let sawDown = false
        let waitedForReady = false
        while (now() < deadline) {
          await wait(500)
          try {
            const next = await status()
            answered = next
            flow.lastStatus = next
            emit()
            const decision = decideAfterPoll({ before, next, sawDown })
            if (decision === 'reload') {
              reportEvent('restart:reload', { pid: next?.process?.pid ?? null, sawDown, readyAfterMs: now() - startedAt })
              if (flow.elapsedTimer) clearInterval(flow.elapsedTimer)
              reload()
              return
            }
            if (decision === 'wait-not-ready' && !waitedForReady) {
              waitedForReady = true
              reportEvent('restart:waiting-ready', { pid: next?.process?.pid ?? null })
            }
          } catch {
            if (!sawDown) reportEvent('restart:down', {})
            sawDown = true
          }
        }

        flow.running = false
        if (flow.elapsedTimer) { clearInterval(flow.elapsedTimer); flow.elapsedTimer = null }
        const ready = answered === undefined ? undefined : answered.ready !== false
        if (answered !== undefined && sawDown && ready) {
          reportEvent('restart:reload-after-timeout', {})
          reload()
          return
        }
        reportEvent('restart:timeout', { answered: answered !== undefined, ready })
        if (answered === undefined) set({ phase: 'error', note: translate('timeout') })
        else if (sawDown && !ready) set({ phase: 'error', note: translate('starting') })
        else set({ phase: 'error', note: translate('noeffect') })
      }

      /** Two-step confirmation, then the restart itself. */
      function activate() {
        if (flow.phase === 'busy') return
        if (flow.phase !== 'confirm') {
          set({ phase: 'confirm', note: null })
          if (flow.timer) clearTimeout(flow.timer)
          flow.timer = setTimeout(() => { if (flow.phase === 'confirm') set({ phase: 'idle' }) }, 6000)
          return
        }
        if (flow.timer) clearTimeout(flow.timer)
        flow.phase = 'busy'
        run()
      }

      return { flow, subscribe, ensurePolling, activate, run, decideAfterPoll }
    }

    /** One flow per page, shared by both controls. */
    let translate = (key) => zh[key] ?? key
    let FLOW = createRestartFlow({ translate })

    function useFlow(where) {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        // Page-liveness beacon: proves the control (and therefore the page)
        // really came back after a restart.
        try {
          const beacon = postJson('/mounted', where)
          if (beacon && typeof beacon.catch === 'function') beacon.catch(() => {})
        } catch { /* best effort */ }
        const unsubscribe = FLOW.subscribe(() => bump((n) => n + 1))
        FLOW.ensurePolling()
        return unsubscribe
      }, [])
      return FLOW.flow
    }

    /** Restart immediately, without any of the stateful UI (used by the crash fallback). */
    function fireRestart() {
      try {
        const promise = postJson('/restart', '')
        if (promise && typeof promise.catch === 'function') promise.catch(() => {})
      } catch {
        /* a fallback button must never throw */
      }
    }

    function RestartIcon(props) {
      return h('svg', {
        width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round',
        className: props.spinning ? 'dsa-spin' : undefined, 'aria-hidden': true,
      },
        h('path', { d: 'M20.5 12a8.5 8.5 0 1 1-2.5-6' }),
        h('polyline', { points: '20.5 3.5 20.5 9 15 9' }))
    }

    function labelOf(flow, t) {
      if (flow.phase === 'busy') return flow.elapsed > 0 ? `${t('busy')} ${flow.elapsed}s` : t('busy')
      if (flow.phase === 'confirm') return t('confirm')
      if (flow.phase === 'error') return flow.note || t('failed')
      return t('restart')
    }

    function titleOf(flow, t) {
      const safeMode = flow.lastStatus?.supervisor?.mode === 'safe'
      const parts = [safeMode ? t('hintSafe') : t('hint')]
      if (safeMode) parts.push(t('safe'))
      if (flow.note) parts.push(flow.note)
      if (flow.lastStatus === null) parts.push(t('unavailable'))
      return parts.join(' · ')
    }

    /** Compact control for the composer dock (a flex row under the input). */
    function DockControl(props) {
      const t = props.t
      const flow = useFlow('dock')
      const safeMode = flow.lastStatus?.supervisor?.mode === 'safe'
      return h('span', { style: { display: 'inline-flex', alignItems: 'center' } },
        h('style', null, CSS),
        h('button', {
          type: 'button',
          className: ['dsa-btn', flow.phase === 'confirm' || flow.phase === 'error' ? 'dsa-danger' : '', safeMode ? 'dsa-warn' : ''].filter(Boolean).join(' '),
          title: titleOf(flow, t),
          'aria-label': t('restart'),
          'aria-busy': flow.phase === 'busy',
          'data-dsa-phase': flow.phase,
          disabled: flow.phase === 'busy',
          onClick: () => FLOW.activate(),
        },
        h(RestartIcon, { spinning: flow.phase === 'busy' }),
        h('span', null, labelOf(flow, t)),
        safeMode ? h('span', { className: 'dsa-dot' }) : null))
    }

    /** Full row beside Settings in the sidebar foot; icon-only on the collapsed rail. */
    function SidebarControl(props) {
      const t = props.t
      const wide = props.wide !== false
      const flow = useFlow('sidebar')
      const safeMode = flow.lastStatus?.supervisor?.mode === 'safe'
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', width: wide ? '100%' : undefined } },
        h('style', null, CSS),
        h('button', {
          type: 'button',
          className: ['dsa-row', wide ? '' : 'dsa-rail', safeMode ? 'dsa-warn' : ''].filter(Boolean).join(' '),
          title: titleOf(flow, t),
          'aria-label': t('restart'),
          'aria-busy': flow.phase === 'busy',
          'data-dsa-phase': flow.phase,
          disabled: flow.phase === 'busy',
          onClick: () => FLOW.activate(),
        },
        h(RestartIcon, { spinning: flow.phase === 'busy' }),
        wide ? h('span', { className: 'dsa-rowLabel' }, labelOf(flow, t)) : null,
        safeMode ? h('span', { className: 'dsa-dot' }) : null))
    }

    /** Plain, dependency-free control: shown if the styled one ever throws. */
    function PlainControl(props) {
      return h('button', {
        type: 'button',
        title: props.title,
        onClick: fireRestart,
        style: {
          font: 'inherit', fontSize: '12px', lineHeight: 1, cursor: 'pointer',
          background: 'transparent', border: '1px solid currentColor', borderRadius: '6px',
          padding: '4px 10px', color: 'inherit',
        },
      }, props.label)
    }

    /**
     * Per-control isolation. The slot runtime already blanks a crashing entry;
     * this keeps the RESTART ITSELF available instead of leaving an empty cell.
     */
    class SafeBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        console.error('dsh-ian-daemon: restart control crashed, using the plain fallback', error)
        report('ui:crashed', { message: String(error?.message ?? error) })
      }

      render() {
        return this.state.failed ? this.props.fallback : this.props.children
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const dicts = { zh, en }
        translate = (key) => dicts.zh[key] ?? key
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          ctx.effect(() => locale.register(NS, dicts), 'dsh-ian-daemon: dictionaries')
          try {
            const bound = locale.bind(NS)
            if (typeof bound === 'function') {
              // Never let a locale lookup take the render down.
              translate = (key) => {
                try {
                  const text = bound(key)
                  return typeof text === 'string' && text !== '' && text !== key ? text : (dicts.zh[key] ?? key)
                } catch {
                  return dicts.zh[key] ?? key
                }
              }
            }
          } catch {
            /* keep the bundled zh fallback */
          }
        }
        // Rebuild the flow so its notices use the locale resolved above.
        FLOW = createRestartFlow({ translate })

        const register = (slot, id, order, make) => ctx.effect(
          () => ctx.slots.inject(slot, () => ctx.slots.register({
            name: slot,
            id,
            order,
            label: () => translate('restart'),
          }, make)),
          `dsh-ian-daemon: ${id}`,
        )

        register('conversation.composer.dock', 'dsh-ian-daemon', 3,
          () => h(SafeBoundary, { fallback: h(PlainControl, { label: translate('restart'), title: translate('hint') }) },
            h(DockControl, { t: translate })))

        register('sidebar.footer.action', 'dsh-ian-daemon-sidebar', -10,
          (props) => h(SafeBoundary, { fallback: h(PlainControl, { label: translate('restart'), title: translate('hint') }) },
            h(SidebarControl, { t: translate, wide: props?.wide })))
      },
      // Test seam: the restart lifecycle is the part that must not regress and
      // the part a browser cannot be driven into reproducing here.
      __test: { createRestartFlow, decideAfterPoll },
    }
  },
})
