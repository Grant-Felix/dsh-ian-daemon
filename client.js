/**
 * @local/dsh-ian-daemon — Client half.
 *
 * Renders the manual "重启" control in two independent places, so one hidden
 * slot can never hide the feature:
 *
 *   - `conversation.composer.dock`  a compact pill under the composer
 *   - `sidebar.footer.action`       a full row beside Settings
 *
 * Clicking the first time asks for confirmation (6s), the second click restarts.
 * While restarting the control polls `/dsh-ian-daemon/status` until the new
 * process answers with a different pid, then reloads the page.
 *
 * Defensive rules learned the hard way:
 *   - the whole control sits inside `SafeBoundary`: a crash renders a plain
 *     working button instead of blanking the slot entry;
 *   - the locale lookup can never throw (a broken `bind` must not kill render);
 *   - no Harness Client package is imported and no DOM outside the component is
 *     touched; styling uses only `--dsw-*` theme tokens.
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
      timeout: '重启超时',
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
      timeout: 'Restart timed out',
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
.dsa-row.dsa-warn{color:var(--dsw-alias-state-warn-primary)}
.dsa-rail{border-radius:var(--dsw-radius-md,8px);width:36px;height:36px;justify-content:center;margin:0;padding:0}
.dsa-rowLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
`

    /** Restart immediately, without any of the stateful UI (used by the crash fallback). */
    function fireRestart() {
      try {
        fetch(`${BASE}/restart`, { method: 'POST', headers: { 'x-dsh-ian-daemon': '1' } }).catch(() => {})
      } catch {
        /* a fallback button must never throw */
      }
    }

    /** Tell the Host that this control really rendered; `/status` reports it. */
    function reportMount(where) {
      try {
        fetch(`${BASE}/mounted`, {
          method: 'POST',
          headers: { 'x-dsh-ian-daemon': '1', 'content-type': 'text/plain' },
          body: String(where),
          keepalive: true,
        }).catch(() => {})
      } catch {
        /* reporting is best effort */
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

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    async function readStatus() {
      const response = await fetch(`${BASE}/status`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`status ${response.status}`)
      return await response.json()
    }

    /** One shared state machine for both placements. */
    function useRestart(t, where) {
      const [phase, setPhase] = React.useState('idle')
      const [status, setStatus] = React.useState(null)
      const [note, setNote] = React.useState(null)
      const [box] = React.useState(() => ({ alive: true, timer: null }))

      React.useEffect(() => {
        box.alive = true
        reportMount(where)
        const poll = () => { readStatus().then((next) => { if (box.alive) setStatus(next) }).catch(() => {}) }
        poll()
        const id = setInterval(poll, 20000)
        return () => {
          box.alive = false
          clearInterval(id)
          if (box.timer) clearTimeout(box.timer)
        }
      }, [])

      const safeMode = status?.supervisor?.mode === 'safe'

      async function restart() {
        const before = status?.process?.pid ?? null
        setPhase('busy')
        setNote(null)
        let sawDown = false
        try {
          const response = await fetch(`${BASE}/restart`, {
            method: 'POST',
            headers: { 'x-dsh-ian-daemon': '1' },
            cache: 'no-store',
          })
          if (!response.ok) throw new Error(`restart ${response.status}`)
        } catch (error) {
          if (!box.alive) return
          setPhase('error')
          setNote(String(error?.message ?? error))
          return
        }

        const deadline = Date.now() + 90000
        const startedAt = Date.now()
        while (Date.now() < deadline && box.alive) {
          await sleep(1200)
          try {
            const next = await readStatus()
            if (!box.alive) return
            setStatus(next)
            if (before === null) {
              if (sawDown) { window.location.reload(); return }
            } else if (next?.process?.pid !== before) {
              window.location.reload()
              return
            } else if (Date.now() - startedAt > 25000) {
              setPhase('error')
              setNote(t('failed'))
              return
            }
          } catch {
            sawDown = true
          }
        }
        if (!box.alive) return
        setPhase('error')
        setNote(t('timeout'))
      }

      function onClick() {
        if (phase === 'busy') return
        if (phase !== 'confirm') {
          setPhase('confirm')
          if (box.timer) clearTimeout(box.timer)
          box.timer = setTimeout(() => setPhase('idle'), 6000)
          return
        }
        if (box.timer) clearTimeout(box.timer)
        restart()
      }

      const label = phase === 'busy' ? t('busy')
        : phase === 'confirm' ? t('confirm')
          : phase === 'error' ? t('failed')
            : t('restart')

      const title = [safeMode ? t('hintSafe') : t('hint')]
      if (safeMode) title.push(t('safe'))
      if (note) title.push(note)
      if (status === null) title.push(t('unavailable'))

      return { phase, safeMode, label, title: title.join(' · '), note, onClick }
    }

    /** Compact control for the composer dock (a flex row under the input). */
    function DockControl(props) {
      const t = props.t
      const r = useRestart(t, 'dock')
      return h('span', { style: { display: 'inline-flex', alignItems: 'center' } },
        h('style', null, CSS),
        h('button', {
          type: 'button',
          className: ['dsa-btn', r.phase === 'confirm' || r.phase === 'error' ? 'dsa-danger' : '', r.safeMode ? 'dsa-warn' : ''].filter(Boolean).join(' '),
          title: r.title,
          'aria-label': t('restart'),
          'aria-busy': r.phase === 'busy',
          'data-dsa-phase': r.phase,
          disabled: r.phase === 'busy',
          onClick: r.onClick,
        },
        h(RestartIcon, { spinning: r.phase === 'busy' }),
        h('span', null, r.label),
        r.safeMode ? h('span', { className: 'dsa-dot' }) : null))
    }

    /** Full row beside Settings in the sidebar foot; icon-only on the collapsed rail. */
    function SidebarControl(props) {
      const t = props.t
      const wide = props.wide !== false
      const r = useRestart(t, 'sidebar')
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', width: wide ? '100%' : undefined } },
        h('style', null, CSS),
        h('button', {
          type: 'button',
          className: ['dsa-row', wide ? '' : 'dsa-rail', r.safeMode ? 'dsa-warn' : ''].filter(Boolean).join(' '),
          title: r.title,
          'aria-label': t('restart'),
          'aria-busy': r.phase === 'busy',
          'data-dsa-phase': r.phase,
          disabled: r.phase === 'busy',
          onClick: r.onClick,
        },
        h(RestartIcon, { spinning: r.phase === 'busy' }),
        wide ? h('span', { className: 'dsa-rowLabel' }, r.label) : null,
        r.safeMode ? h('span', { className: 'dsa-dot' }) : null))
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
        // eslint-disable-next-line no-console
        console.error('dsh-ian-daemon: restart control crashed, using the plain fallback', error)
      }

      render() {
        return this.state.failed ? this.props.fallback : this.props.children
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const dicts = { zh, en }
        let translate = (key) => dicts.zh[key] ?? key
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
    }
  },
})
