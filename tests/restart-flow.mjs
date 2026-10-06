/**
 * Regression test for the restart lifecycle in client.js.
 *
 * The reported bug: after clicking 重启 while the harness ran under systemd, the
 * service came back but the page never recovered. The client flow used to give
 * up entirely when the POST threw — which is the usual case, because the server
 * dies before its response lands — leaving the page stale forever.
 *
 * This drives the real `createRestartFlow` with stubbed deps (no browser, no
 * jsdom, no React rendering): the flow takes fetch/reload/sleep/clock as
 * dependencies precisely so this is possible.
 *
 *   node tests/restart-flow.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

let failed = 0
const check = (what, expected, actual) => {
  if (String(expected) === String(actual)) {
    console.log(`  ok   ${what}`)
  } else {
    console.log(`  FAIL ${what} (expected ${expected}, got ${actual})`)
    failed = 1
  }
}

// --- load the browser artifact with the minimal loader/react surface it uses ---
let registration
const fakeWindow = { __ModuleLoader__: { load: (value) => { registration = value } } }
new Function('window', readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8'))(fakeWindow)

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  Component: class { constructor(props) { this.props = props } },
}
const plugin = registration.factory((spec) => {
  if (spec === 'react') return ReactStub
  throw new Error(`unexpected module request: ${spec}`)
})
check('registers the documented entry id', '@local/dsh-ian-daemon', registration.id)
check('exposes the restart test seam', 'function', typeof plugin.__test?.createRestartFlow)

const { createRestartFlow, decideAfterPoll } = plugin.__test

function harness(options) {
  let clock = 0
  const events = []
  const state = { reloads: 0, statusCalls: 0 }
  const sequence = [...(options.statuses ?? [])]
  const flowApi = createRestartFlow({
    now: () => clock,
    wait: async (ms) => { clock += ms },
    translate: (key) => key,
    report: (event, data) => events.push({ event, data }),
    post: options.post ?? (async () => ({ ok: true, status: 202 })),
    reload: () => { state.reloads += 1 },
    status: async () => {
      state.statusCalls += 1
      const next = sequence.length > 0 ? sequence.shift() : (options.onEmpty ? options.onEmpty() : { process: { pid: 100 } })
      if (next instanceof Error) throw next
      return next
    },
  })
  flowApi.flow.lastStatus = options.lastStatus ?? { process: { pid: 100 } }
  return { flowApi, events, state }
}

console.log('1. a POST that dies with the server still ends in a reload (the reported bug)')
{
  const { flowApi, events, state } = harness({
    post: async () => { throw new Error('net::ERR_CONNECTION_RESET') },
    statuses: [new Error('refused'), new Error('refused'), { process: { pid: 4242 } }],
  })
  await flowApi.run()
  check('the page reloaded', '1', state.reloads)
  check('the failed POST was reported', 'true', events.some((e) => e.event === 'restart:post-failed'))
  check('the outage was observed', 'true', events.some((e) => e.event === 'restart:down'))
  check('the reload was reported', 'true', events.some((e) => e.event === 'restart:reload'))
}

console.log('2. a server that came back without a new pid still triggers a reload')
{
  const { flowApi, state } = harness({
    statuses: [new Error('refused'), { process: { pid: 100 } }],
  })
  await flowApi.run()
  check('the page reloaded', '1', state.reloads)
}

console.log('3. a restart that never took effect reports it instead of reloading blindly')
{
  const { flowApi, events, state } = harness({
    statuses: [],
    onEmpty: () => ({ process: { pid: 100 } }),
  })
  await flowApi.run()
  check('no reload', '0', state.reloads)
  check('phase is error', 'error', flowApi.flow.phase)
  check('note explains it', 'noeffect', flowApi.flow.note)
  check('timeout was reported', 'true', events.some((e) => e.event === 'restart:timeout'))
}

console.log('4. a server that never comes back ends in the timeout note, not a silent hang')
{
  const { flowApi, state } = harness({ statuses: [], onEmpty: () => new Error('refused') })
  await flowApi.run()
  check('no reload', '0', state.reloads)
  check('note tells the user to refresh', 'timeout', flowApi.flow.note)
}

console.log('5. the staleness decision itself')
check('same pid, no outage -> wait', 'wait', decideAfterPoll({ before: 1, next: { process: { pid: 1 } }, sawDown: false }))
check('pid moved -> reload', 'reload', decideAfterPoll({ before: 1, next: { process: { pid: 2 } }, sawDown: false }))
check('down then up -> reload', 'reload', decideAfterPoll({ before: 1, next: { process: { pid: 1 } }, sawDown: true }))
check('still down -> wait', 'wait', decideAfterPoll({ before: 1, next: undefined, sawDown: true }))
check('unknown before + outage -> reload', 'reload', decideAfterPoll({ before: null, next: { process: { pid: 9 } }, sawDown: true }))

if (failed === 0) console.log('restart-flow test passed')
else console.log('restart-flow test failed')
process.exit(failed)
