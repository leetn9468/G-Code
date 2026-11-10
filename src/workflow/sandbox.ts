import { Worker as NodeWorker } from 'node:worker_threads'
import { totalmem } from 'node:os'
import { parseWorkflow } from './meta.js'

export interface SandboxOptions {
  args?: unknown
  signal?: AbortSignal
  onCall?: (method: string, values: unknown[]) => unknown | Promise<unknown>
  syncTimeoutMs?: number
  heartbeatTimeoutMs?: number
  maxDurationMs?: number
  /** How long a script may wait with no host call running before it is ended (see the watchdog). */
  idleTimeoutMs?: number
  /** How far memory may grow on the script's account before it is ended (see the watchdog). */
  memoryLimitBytes?: number
}

// Only JSON strings cross the worker/realm boundary. None of the functions or
// objects of the worker's realm are returned to the script's realm.
const bootstrap = String.raw`
(() => {
  'use strict';
  const allowed = new Set(('globalThis Infinity NaN undefined Object Function Array Number parseFloat parseInt Boolean String Symbol Date Promise RegExp Error AggregateError EvalError RangeError ReferenceError SyntaxError TypeError URIError JSON Math Intl Reflect Proxy Map Set WeakMap WeakSet ArrayBuffer DataView Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array Float32Array Float64Array BigInt BigInt64Array BigUint64Array eval isFinite isNaN decodeURI decodeURIComponent encodeURI encodeURIComponent escape unescape').split(' '));
  for (const key of Reflect.ownKeys(globalThis)) {
    if (!allowed.has(key) && !Reflect.deleteProperty(globalThis, key)) throw new Error('Cannot remove realm global: ' + String(key));
  }
  Object.setPrototypeOf(globalThis, null);
  for (const name of ['Error','TypeError','RangeError','ReferenceError','SyntaxError','EvalError','URIError','AggregateError']) {
    const ctor = globalThis[name];
    for (const key of ['prepareStackTrace','captureStackTrace']) Object.defineProperty(ctor, key, { value: undefined, writable: false, configurable: false });
    Object.defineProperty(globalThis, name, { value: ctor, writable: false, configurable: false });
  }
  const parse = JSON.parse, stringify = JSON.stringify, apply = Reflect.apply, then = Promise.prototype.then;
  const NativePromise = Promise, create = Object.create, assign = Object.assign, isArray = Array.isArray;
  const mapGet = Map.prototype.get, mapSet = Map.prototype.set, mapDelete = Map.prototype.delete;
  const encode = message => stringify(assign(create(null), message));
  // Mutable script prototypes must never receive the private queue or resolvers.
  let outbox = '', inFlight = 0, agentsInFlight = 0, pendingCount = 0, progressPending = 0;
  let agentHead, agentTail, progressHead, progressTail, doneWire;
  let returned = false, currentPhase = null, progressCutoff, collectingProgress = false;
  const checkpoint = new NativePromise(resolve => resolve());
  const complete = () => {
    if (doneWire && !collectingProgress && progressPending === 0) { send(doneWire); doneWire = undefined; }
  };
  const dispatch = () => {
    while (inFlight < 256) {
      let next;
      if (progressHead && (progressCutoff === undefined || progressHead.id <= progressCutoff)) {
        next = progressHead; progressHead = next.next; if (!progressHead) progressTail = undefined;
      } else if (agentHead && !returned && agentsInFlight < 255) {
        // Reserve one slot so progress can advance even if every agent blocks.
        next = agentHead; agentHead = next.next; if (!agentHead) agentTail = undefined;
        agentsInFlight++;
      } else break;
      inFlight++; send(next.wire);
    }
  };
  const send = wire => { outbox += (outbox ? ',' : '') + stringify(wire); };
  const pending = new Map();
  let sequence = 0;
  let overflow = false;
  const call = (method, values) => {
    // Discarded work must not resume await/then loops while final progress drains.
    if (returned && (method === 'agent' || !collectingProgress)) return new NativePromise(() => {});
    if (overflow || pendingCount >= 16384) {
      if (!overflow) { overflow = true; send(encode({ type: 'error', error: 'Workflow exceeds 16384 pending host calls; await or batch calls' })); }
      throw new Error('Workflow exceeds 16384 pending host calls; await or batch calls');
    }
    // Reserve before encoding: user toJSON methods can reenter call().
    pendingCount++;
    if (method !== 'agent') progressPending++;
    return new NativePromise((resolve, reject) => {
    const id = ++sequence;
    if (returned) progressCutoff = id;
    apply(mapSet, pending, [id, { resolve, reject, method }]);
    try {
      const next = create(null);
      next.id = id;
      next.wire = encode({ type: 'call', id, method, values });
      if (method === 'agent') {
        if (agentTail) agentTail.next = next; else agentHead = next;
        agentTail = next;
      } else {
        if (progressTail) progressTail.next = next; else progressHead = next;
        progressTail = next;
      }
      dispatch();
    } catch (_) {
      apply(mapDelete, pending, [id]); pendingCount--;
      if (method !== 'agent') progressPending--;
      reject(new Error('Host call could not be sent'));
    }
    });
  };
  globalThis.agent = (prompt, options = {}) => {
    if (options != null && (typeof options !== 'object' || isArray(options))) throw new Error('agent options must be an object');
    const model = options == null ? undefined : options.model;
    if (model != null && typeof model !== 'string') throw new Error('agent model must be a string');
    return call('agent', [prompt, options, currentPhase]);
  };
  globalThis.log = message => call('log', [message]);
  globalThis.agentFailures = () => call('agentFailures', []);
  globalThis.phase = title => {
    if (returned && !collectingProgress) return call('phase', []);
    currentPhase = String(title); return call('phase', [currentPhase]);
  };
  const checkItems = items => {
    if (!Array.isArray(items)) throw new Error('Expected an array');
    if (items.length > 4096) throw new Error('Workflow collection exceeds 4096 items');
  };
  globalThis.parallel = async thunks => {
    checkItems(thunks);
    return Promise.all(thunks.map(async thunk => { try { return await thunk(); } catch (_) { return null; } }));
  };
  globalThis.pipeline = async (items, ...stages) => {
    checkItems(items);
    return Promise.all(items.map(async (item, index) => {
      let previous = item;
      for (const stage of stages) {
        try { previous = await stage(previous, item, index); } catch (_) { return null; }
      }
      return previous;
    }));
  };
  const NativeDate = Date;
  Object.defineProperty(NativeDate, 'now', { value: () => { throw new Error('Date.now() is nondeterministic'); }, writable: false, configurable: false });
  const deterministicDate = new Proxy(NativeDate, {
    apply() { throw new Error('Date() is nondeterministic'); },
    construct(target, args, newTarget) {
      if (!args.length) throw new Error('new Date() requires an explicit date');
      return Reflect.construct(target, args, newTarget);
    }
  });
  Object.defineProperty(NativeDate.prototype, 'constructor', { value: deterministicDate, writable: false, configurable: false });
  globalThis.Date = deterministicDate;
  Math.random = () => { throw new Error('Math.random() is nondeterministic'); };
  const proto = Intl.DateTimeFormat.prototype;
  const format = Object.getOwnPropertyDescriptor(proto, 'format').get;
  Object.defineProperty(proto, 'format', { get() {
    const bound = Reflect.apply(format, this, []);
    return (...dates) => {
      if (!dates.length || dates[0] === undefined) throw new Error('format requires a date');
      return bound(...dates);
    };
  }});
  for (const key of ['formatToParts', 'formatRange', 'formatRangeToParts']) {
    if (!proto[key]) continue;
    const original = proto[key];
    proto[key] = function(...dates) {
      const count = key.startsWith('formatRange') ? 2 : 1;
      if (dates.length < count || dates.slice(0, count).some(d => d === undefined)) throw new Error(key + ' requires explicit dates');
      return Reflect.apply(original, this, dates);
    };
  }
  for (const key of ['WeakRef', 'FinalizationRegistry', 'SharedArrayBuffer', 'Atomics']) delete globalThis[key];
  const deliver = wire => {
    const response = parse(wire);
    if (response.type === 'args') { globalThis.args = response.value; return; }
    const entry = apply(mapGet, pending, [response.id]);
    if (!entry) return;
    apply(mapDelete, pending, [response.id]);
    inFlight--; pendingCount--;
    if (entry.method === 'agent') agentsInFlight--; else progressPending--;
    dispatch();
    // Once the script returned, only the explicit return-time batch may run
    // more script callbacks. Resuming old progress/agent await chains here can
    // starve delivery of the remaining frozen progress with resolved-Promise
    // loops. Their host work still drains; the realm is then terminated.
    if (!returned) {
      if (response.error !== undefined) entry.reject(new Error(response.error));
      else entry.resolve(response.value);
    }
    if (returned) complete();
  };
  const failure = error => send(encode({ type: 'error', error: String(error?.message || error) }));
  return {
    deliver,
    drain() { const batch = '[' + outbox + ']'; outbox = ''; return batch; },
    start(factory) {
      apply(then, factory(), [value => {
        try {
          returned = true;
          progressCutoff = sequence;
          doneWire = encode({ type: 'done', value: value === undefined ? null : value });
          // Always open one batch after serializing the return value. The
          // closing checkpoint follows microtasks already queued now and the
          // reactions registered on unsent agents; their later continuations
          // cannot extend this cutoff, even while earlier progress is in flight.
          collectingProgress = true;
          while (agentHead) {
            const next = agentHead; agentHead = next.next;
            const entry = apply(mapGet, pending, [next.id]);
            apply(mapDelete, pending, [next.id]); pendingCount--; entry.resolve(null);
          }
          agentTail = undefined;
          apply(then, checkpoint, [() => {
            collectingProgress = false;
            dispatch(); complete();
          }]);
        } catch (error) { failure(error); }
      }, failure]);
    },
  };
})()
`

/** The most one watchdog tick adds to a silence (it runs every 50 ms when this thread is free). */
const TICK_CREDIT_MS = 100
/**
 * A script has no timers or events: with no host call running, nothing can ever resume it, whatever
 * it awaits. The wait is only a margin for messages on their way, so a long agent never counts.
 */
const IDLE_TIMEOUT_MS = 30_000
/** The script's share of memory: as far as ordinary objects reach before the engine itself refuses them, on a machine with room for it. */
const memoryLimit = () => Math.min(3 * 1024 ** 3, Math.floor(totalmem() / 2))
/**
 * Memory of a worker ended this way does not come back to the system (measured: 1.1 GB more after
 * each of three such runs, while workers that finish reuse theirs), so the limit per run does not
 * bound a process: after this many, no more scripts start in it.
 */
const MAX_MEMORY_KILLS = 2
let memoryKills = 0
const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`
const nonYieldingHint = 'The worker was terminated. A non-yielding loop or optimized tail recursion may never throw a catchable stack overflow; add a finite recursion/iteration bound.'
const workerBody = String.raw`
let bridge, pump;
const flush = () => {
  try {
    for (const wire of JSON.parse(bridge.drain())) {
      send(wire);
      const type = JSON.parse(wire).type;
      if (type === 'done' || type === 'error') stop();
    }
  } catch (error) { stop(); send(JSON.stringify({ type: 'error', error: String(error?.message || error) })); }
};
// A macrotask checkpoint also drains calls from nested realm Promise chains.
const scheduleFlush = () => { queueMicrotask(flush); setImmediate(flush); };
const heartbeat = setInterval(() => send(JSON.stringify({ type: 'heartbeat' })), 50);
const stop = () => { clearInterval(heartbeat); clearInterval(pump); };
receive(wire => {
  const message = JSON.parse(wire);
  try {
    if (message.type === 'reply') { bridge.deliver(wire); scheduleFlush(); return; }
    if (message.type !== 'start') return;
    const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
    bridge = vm.runInContext(message.bootstrap, context, { timeout: message.timeout });
    bridge.deliver(JSON.stringify({ type: 'args', value: message.args }));
    // This handle is a realm function, not a worker function. No host callbacks
    // or Promise resolvers enter the realm, even during result serialization.
    context.__start = bridge.start;
    vm.runInContext('(start => { delete globalThis.__start; start(async()=>{\n"use strict";\n' + message.script + '\n}); })(__start); undefined', context, { timeout: message.timeout });
    // Both callbacks stay in the worker; no callback enters the realm.
    scheduleFlush();
    pump = setInterval(flush, 5);
  } catch (error) {
    stop();
    const hint = error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? ' ' + ${JSON.stringify(nonYieldingHint)} : '';
    send(JSON.stringify({ type: 'error', error: String(error?.message || error) + hint }));
  }
});
`

export async function runSandbox(source: string, options: SandboxOptions = {}): Promise<unknown> {
  const { script } = parseWorkflow(source)
  options.signal?.throwIfAborted()
  if (memoryKills >= MAX_MEMORY_KILLS) throw new Error(`No workflow can start in this process: ${memoryKills} scripts here were ended for using too much memory, and that memory cannot be freed until G-Code restarts. Restart G-Code to run workflows again.`)
  const argsWire = JSON.stringify(options.args ?? null)
  const bun = !!(globalThis as Record<string, unknown>).Bun
  let blobUrl: string | undefined
  const WorkerCtor = (globalThis as any).Worker
  const worker: any = bun
    ? new WorkerCtor(blobUrl = URL.createObjectURL(new Blob([
      `'use strict'; import vm from 'node:vm'; const send = wire => postMessage(wire); const receive = callback => { self.onmessage = event => callback(event.data); };\n${workerBody}`,
    ], { type: 'application/javascript' })))
    : new NodeWorker(`'use strict'; const vm = require('node:vm'); const { parentPort } = require('node:worker_threads'); const send = wire => parentPort.postMessage(wire); const receive = callback => parentPort.on('message', callback);\n${workerBody}`, { eval: true })
  try {
    return await new Promise((resolve, reject) => {
      let settled = false
      // How long the worker has been silent while this thread was able to hear it. Heartbeats wait in
      // this thread's queue, and this timer runs on the same thread: after a freeze (a closed lid, a
      // stopped process) or a blocking call, the timer runs first and the old time since the last
      // heartbeat proves nothing. Each tick adds at most TICK_CREDIT_MS, so a gap in which the
      // watchdog itself did not run counts for one tick, and a script that really blocks is still
      // ended within the limit of time this thread was running.
      let silence = 0
      let lastTick = performance.now()
      let idle = 0
      let hostCalls = 0
      const idleLimit = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
      // Agents and their engines live on this thread and may need memory in a large run: only what
      // grew beyond this thread's own heap counts against the script. rss alone is cheap, and is
      // what a tick reads until it passes the limit.
      const hostHeap = () => { const usage = process.memoryUsage(); return usage.heapTotal + usage.external }
      const startRss = process.memoryUsage.rss()
      const startHeap = hostHeap()
      const memLimit = options.memoryLimitBytes ?? memoryLimit()
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return
        settled = true
        clearInterval(watchdog)
        if (deadline) clearTimeout(deadline)
        options.signal?.removeEventListener('abort', abort)
        if (error) reject(error); else resolve(value)
      }
      const abort = () => finish(new Error('Workflow stopped'))
      const watchdog = setInterval(() => {
        const now = performance.now()
        const credit = Math.min(Math.max(0, now - lastTick), TICK_CREDIT_MS)
        silence += credit
        idle = hostCalls ? 0 : idle + credit
        lastTick = now
        if (silence > (options.heartbeatTimeoutMs ?? 2000)) finish(new Error(`Workflow worker heartbeat timed out after ${options.heartbeatTimeoutMs ?? 2000}ms. ${nonYieldingHint}`))
        else if (idle > idleLimit) finish(new Error(`The script is waiting for something that can never happen: no agent or other host call has been running for ${Math.round(idleLimit / 1000)} s, and a script has no timers or events of its own, so a promise it awaits now would never settle. The worker was terminated. Await only agent(), log(), phase(), parallel(), pipeline() and promises built on them.`))
        else {
          const grown = process.memoryUsage.rss() - startRss
          // The heap figures lag behind large allocations until a collection, which is run only here, past the limit.
          const scriptShare = () => grown - Math.max(0, hostHeap() - startHeap)
          if (grown > memLimit && scriptShare() > memLimit) {
            ;(globalThis as { Bun?: { gc(force: boolean): void } }).Bun?.gc(true)
            if (scriptShare() > memLimit) {
              if (options.memoryLimitBytes === undefined) memoryKills++
              finish(new Error(`The script used too much memory: this process grew by ${gib(grown)} on its account (the limit is ${gib(memLimit)}), so the worker was terminated. Keep large data out of the script, or split the work between agents.`))
            }
          }
        }
      }, 50)
      const deadline = options.maxDurationMs ? setTimeout(() => finish(new Error('Workflow duration exceeded')), options.maxDurationMs) : undefined
      const receive = (wire: string) => {
        if (settled) return
        let message: any
        try { message = JSON.parse(wire) } catch { finish(new Error('Invalid worker message')); return }
        if (message.type === 'heartbeat') { silence = 0; return }
        if (message.type === 'done') { finish(undefined, message.value); return }
        if (message.type === 'error') { finish(new Error(message.error)); return }
        if (message.type === 'call') {
          hostCalls++
          idle = 0
          void Promise.resolve().then(() => options.onCall?.(message.method, message.values)).then(value => {
            if (!settled) worker.postMessage(JSON.stringify({ type: 'reply', id: message.id, value: value ?? null }))
          }).catch(error => {
            if (!settled) worker.postMessage(JSON.stringify({ type: 'reply', id: message.id, error: error instanceof Error ? error.message : String(error) }))
          }).finally(() => { hostCalls--; idle = 0 })
        }
      }
      if (bun) {
        worker.onmessage = (event: MessageEvent<string>) => receive(event.data)
        worker.onerror = (event: any) => finish(new Error(event.message || 'Workflow worker failed'))
      } else {
        worker.on('message', receive)
        worker.on('error', (error: Error) => finish(error))
        worker.on('exit', (code: number) => { if (!settled) finish(new Error(`Workflow worker exited (${code})`)) })
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) { abort(); return }
      worker.postMessage(JSON.stringify({ type: 'start', script, bootstrap, args: JSON.parse(argsWire), timeout: options.syncTimeoutMs ?? 1000 }))
    })
  } finally {
    await worker.terminate()
    if (blobUrl) URL.revokeObjectURL(blobUrl)
  }
}
