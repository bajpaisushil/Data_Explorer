'use client'
/**
 * UI-thread half of the worker protocol: promise-per-request over postMessage,
 * with progress events and cancellation.
 */

import {
  CancelledError,
  type FromWorker,
  type Progress,
  type Req,
  type ReqKind,
  type ResFor,
  type ToWorker,
} from './protocol'

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  onProgress?: (p: Progress) => void
}

export interface RequestOptions {
  onProgress?: (p: Progress) => void
  signal?: AbortSignal
}

export class EngineClient {
  private worker: Worker
  private seq = 0
  private pending = new Map<number, Pending>()
  private disposed = false

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'dataforge-engine',
    })
    this.worker.addEventListener('message', this.onMessage)
    this.worker.addEventListener('error', this.onError)
  }

  private onMessage = (event: MessageEvent<FromWorker>) => {
    const msg = event.data
    const entry = this.pending.get(msg.id)
    if (!entry) return

    if ('progress' in msg) {
      entry.onProgress?.(msg.progress)
      return
    }

    this.pending.delete(msg.id)
    if (msg.ok) {
      entry.resolve(msg.result)
    } else {
      const err = new Error(msg.error)
      if (msg.stack) err.stack = msg.stack
      entry.reject(err)
    }
  }

  private onError = (event: ErrorEvent) => {
    const err = new Error(event.message || 'The data engine crashed')
    for (const [, entry] of this.pending) entry.reject(err)
    this.pending.clear()
  }

  request<K extends ReqKind>(
    req: Extract<Req, { kind: K }>,
    options: RequestOptions = {},
  ): Promise<ResFor<K>> {
    if (this.disposed) return Promise.reject(new Error('The data engine has been shut down'))

    const id = ++this.seq
    const promise = new Promise<ResFor<K>>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        onProgress: options.onProgress,
      })
    })

    if (options.signal) {
      const signal = options.signal
      if (signal.aborted) {
        this.pending.delete(id)
        return Promise.reject(new CancelledError())
      }
      signal.addEventListener(
        'abort',
        () => {
          const entry = this.pending.get(id)
          if (!entry) return
          this.pending.delete(id)
          this.post({ id, cancel: true })
          entry.reject(new CancelledError())
        },
        { once: true },
      )
    }

    // A File is not transferable, so parseFile is cloned; everything else is small.
    this.post({ id, req })
    return promise
  }

  private post(msg: ToWorker) {
    this.worker.postMessage(msg)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const [, entry] of this.pending) entry.reject(new CancelledError())
    this.pending.clear()
    this.worker.removeEventListener('message', this.onMessage)
    this.worker.removeEventListener('error', this.onError)
    this.worker.terminate()
  }
}

let singleton: EngineClient | null = null

/** One worker per tab. Created lazily so it never runs during prerender. */
export function getEngine(): EngineClient {
  if (typeof window === 'undefined') {
    throw new Error('The data engine is only available in the browser')
  }
  if (!singleton) singleton = new EngineClient()
  return singleton
}

export function disposeEngine() {
  singleton?.dispose()
  singleton = null
}
