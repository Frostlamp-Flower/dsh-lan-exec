/**
 * Type declarations for dsh-lan-exec.
 *
 * The runtime is plain ESM JavaScript; these declarations cover the plugin
 * entry, the resolved configuration, and the two program namespaces a model
 * writes against.
 */

/**
 * How this host participates in a pair.
 *
 * `origin` runs the session and the model; `executor` runs the forwarded calls
 * and owns the permissions they need. `'server'` and `'client'` are accepted as
 * legacy aliases for `'executor'` and `'origin'`.
 */
export type BridgeMode = 'off' | 'origin' | 'executor'

/** Raw plugin config as written into the profile's `cordis.patch.yml`. */
export interface BridgeConfig {
  /** `mode` selects the role at use time; `role` is the older spelling. */
  mode?: BridgeMode | 'server' | 'client'
  /** Older spelling of {@link BridgeConfig.mode}. */
  role?: BridgeMode | 'server' | 'client'
  /** Display name used in logs and in the peer's tool description. */
  name?: string
  /** This host's own 256-bit credential. */
  token?: string
  /** The peer's credential, verified during the handshake. */
  peerToken?: string
  /** Label for the peer, shown to the model. */
  peerName?: string
  /** Listen/connect port. */
  port?: number
  /** Bind address in server mode. */
  bind?: string
  /** Peer address in client mode. */
  host?: string
  /** Session id, or `auto` to use the first live session. */
  session?: string
  /** Idle deadline measured from the end of the last completed call. */
  idleTimeoutMs?: number
  /** Reconnect after network failures (idle expiry never reconnects). */
  autoReconnect?: boolean
  /** Model-facing name of the forwarding tool. */
  toolName?: string
  /** Whether the local program tool is mounted. */
  localTool?: boolean
  /** Model-facing name of the local program tool. */
  localToolName?: string
  /** Per-program execution budget. */
  callTimeoutMs?: number
  /** Byte ceiling of the shared data space, published by the executor side. */
  maxStoreBytes?: number
  /** Absolute path of the data-space file. */
  storeFile?: string
  /** Tools never advertised to the peer. */
  hideTools?: string[]
  /** When non-empty, only these tools may be forwarded. */
  allowedTools?: string[]
}

/** A wire schema as advertised by the executor. */
export interface RemoteToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** One entry of the shared data space. */
export interface StoreRow {
  key: string
  bytes: number
  rev: number
  updatedAt: number
}

/** The `store` namespace available inside a program. */
export interface StoreNamespace {
  create(args: { key: string; value: unknown }): Promise<{ rev: number; key: string }>
  update(args: { key: string; value: unknown }): Promise<{ rev: number; key: string }>
  read(args: { key: string }): Promise<unknown>
  delete(args: { key: string }): Promise<{ rev: number; key: string }>
  list(args?: { prefix?: string }): Promise<StoreRow[]>
  stat(): Promise<{ rev: number; entries: number; bytes: number; maxBytes: number }>
}

declare const tools: Record<string, (args: Record<string, unknown>) => Promise<unknown>>

/** Resolve defaults over a raw config. */
export declare function resolveConfig(config?: Record<string, unknown>): BridgeConfig & { role: BridgeMode; version: string }

/** Validate a resolved config, throwing on a misconfiguration. */
export declare function assertConfig(config: ReturnType<typeof resolveConfig>): void

/** Cordis plugin entry. */
export declare function apply(ctx: any, config?: Record<string, unknown>): void

export declare const name: string
export declare const inject: string[]
export declare const VERSION: string
export declare const DEFAULT_IDLE_TIMEOUT_MS: number
export declare const DEFAULT_TOOL_NAME: string
export declare const DEFAULT_LOCAL_TOOL_NAME: string
