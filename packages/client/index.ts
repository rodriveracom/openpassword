export type DeviceTokens = {
  device_id: string
  access_token: string
  refresh_token: string
  access_expires_at: string
  refresh_expires_at: string
}
export type DevicePair = {
  pairing_id: string
  device_code: string
  user_code: string
  verification_url: string
  interval_seconds: number
  expires_at: string
}
export class OpenPassword {
  readonly origin: string
  constructor(
    origin: string,
    private token?: string,
    private hostProof?: (
      origin: string,
      method: string,
      path: string,
      authorization: string,
      body: string | Uint8Array,
    ) => Promise<Record<string, string>>,
  ) {
    const u = new URL(origin)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
    if (
      u.username ||
      u.password ||
      u.pathname !== '/' ||
      u.search ||
      u.hash ||
      !(u.protocol === 'https:' || (local && u.protocol === 'http:'))
    )
      throw Error('Use a secure broker origin')
    this.origin = u.origin
  }
  async request<T>(path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    if (!path.startsWith('/v1/') || path.includes('..') || path.includes('\\'))
      throw Error('Invalid broker path')
    const r = await fetch(this.origin + path, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(90000),
      headers: {
        ...(await this.hostProof?.(
          this.origin,
          body ? 'POST' : 'GET',
          path,
          this.token ? 'Bearer ' + this.token : '',
          body ? JSON.stringify(body) : '',
        )),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        'Content-Type': 'application/json',
        'OpenPassword-Protocol-Version': '1',
        'OpenPassword-Capabilities': 'expected-binding',
        ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (r.headers.get('openpassword-protocol-version') !== '1')
      throw Object.assign(Error('Broker protocol unavailable'), { status: r.status })
    if (!r.ok) {
      const expired =
        path === '/v1/device/token' &&
        r.status === 400 &&
        (await r.json().catch(() => null))?.detail === 'Expired pairing'
      throw Object.assign(
        Error(
          expired ? 'Pairing expired. Start a new pairing request.' : 'Broker returned ' + r.status,
        ),
        { status: r.status },
      )
    }
    return r.status === 204 ? (undefined as T) : ((await r.json()) as T)
  }
  /** Fetch an artifact's exact bytes (not re-serialized, so a content digest can be checked). */
  async artifact(id: string): Promise<Uint8Array> {
    if (!/^art_[0-9a-f-]{36}$/.test(id)) throw Error('Invalid artifact id')
    const path = '/v1/artifacts/' + id
    const r = await fetch(this.origin + path, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(90000),
      headers: {
        ...(await this.hostProof?.(
          this.origin,
          'GET',
          path,
          this.token ? 'Bearer ' + this.token : '',
          '',
        )),
        'OpenPassword-Protocol-Version': '1',
        ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}),
      },
    })
    if (r.headers.get('openpassword-protocol-version') !== '1')
      throw Object.assign(Error('Broker protocol unavailable'), { status: r.status })
    if (!r.ok) throw Object.assign(Error('Broker returned ' + r.status), { status: r.status })
    return new Uint8Array(await r.arrayBuffer())
  }
  chat(model: string, prompt: string, maxTokens: number, key: string) {
    if (!key.trim() || !Number.isSafeInteger(maxTokens) || maxTokens < 1)
      throw Error('Provide an idempotency key and a positive output token limit')
    return this.request(
      '/v1/chat/completions',
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        stream: false,
      },
      key,
    )
  }
  pair(device_name: string) {
    return this.request<DevicePair>('/v1/device/authorizations', { device_name })
  }
  async redeem(device_code: string, attempt = crypto.randomUUID()) {
    const send = () => this.request<DeviceTokens>('/v1/device/token', { device_code }, attempt)
    try {
      return await send()
    } catch (error) {
      if (
        !(error instanceof TypeError) &&
        !(error instanceof DOMException && error.name === 'TimeoutError')
      )
        throw error
      return send()
    }
  }
  refresh(refresh_token: string) {
    return this.request<DeviceTokens>('/v1/device/token/refresh', { refresh_token })
  }
  connections() {
    return this.request<unknown[]>('/v1/connections')
  }
  invoke(
    connection_id: string,
    operation_id: string,
    args: Record<string, unknown>,
    idempotency_key: string,
    expect?: { external_identity: string; connection_revision: string },
  ) {
    return this.request('/v1/operations/' + encodeURIComponent(operation_id) + ':invoke', {
      connection_id,
      operation_id,
      arguments: args,
      idempotency_key,
      ...(expect ? { expect } : {}),
    })
  }

  /** Resume an approved YouTube relay session with the original immutable media. */
  async uploadYouTube(
    session: {
      connection_id: string
      upload_url: string
      relay_seal: string
      mime_type: string
      size_bytes: number
      content_sha256: string
    },
    media: Blob,
    signal?: AbortSignal,
  ) {
    if (!this.token || !session.relay_seal || !media.size || media.size !== session.size_bytes)
      throw Error('Missing relay authorization or incorrect media size')
    const chunkSize = 4 * 1024 * 1024
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha256')
    for (let i = 0; i < media.size; i += chunkSize) {
      signal?.throwIfAborted()
      hash.update(new Uint8Array(await media.slice(i, i + chunkSize).arrayBuffer()))
    }
    if (hash.digest('hex') !== session.content_sha256.replace(/^sha256:/, ''))
      throw Error('Media digest differs from the approved digest')
    const probe = 'bytes */' + media.size
    const exchange = async (range: string, chunk?: Blob) => {
      const timeout = AbortSignal.timeout(150000)
      const r = await fetch(this.origin + '/v1/youtube/uploads:relay', {
        method: 'POST',
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
          ...(await this.hostProof?.(
            this.origin,
            'PUT',
            '/v1/youtube/uploads:relay',
            'Bearer ' + this.token,
            chunk ? new Uint8Array(await chunk.arrayBuffer()) : '',
          )),
          'Content-Type': 'application/octet-stream',
          'OpenPassword-Protocol-Version': '1',
          Authorization: 'Bearer ' + this.token,
          'openpassword-upload-link': session.upload_url,
          'openpassword-relay-seal': session.relay_seal,
          'openpassword-connection': session.connection_id,
          'openpassword-content-type': session.mime_type,
          'openpassword-content-range': range,
        },
        body: chunk,
      })
      if (!r.ok || r.headers.get('openpassword-protocol-version') !== '1')
        throw Error('Broker relay refused transfer (' + r.status + ')')
      return (await r.json()) as {
        status: number
        range: string | null
        resource: { id: string | null; status: { privacyStatus: string | null } } | null
      }
    }
    let response = await exchange(probe),
      offset = 0,
      lastEnd = media.size - 1,
      stalls = 0
    for (;;) {
      if ([200, 201].includes(response.status) && response.resource) return response.resource
      if (response.status !== 308)
        throw Error('Upload outcome requires reconciliation (' + response.status + ')')
      const match = response.range === null ? null : /^bytes=0-(\d+)$/.exec(response.range)
      if (response.range !== null && !match) throw Error('Invalid provider acknowledgement')
      const next = match ? Number(match[1]) + 1 : 0
      if (!Number.isSafeInteger(next) || next < offset || next > lastEnd + 1 || next >= media.size)
        throw Error('Inconsistent provider acknowledgement')
      stalls = next === offset ? stalls + 1 : 0
      if (stalls > 3) throw Error('Provider acknowledged no progress')
      offset = next
      lastEnd = Math.min(media.size, offset + chunkSize) - 1
      try {
        response = await exchange(
          'bytes ' + offset + '-' + lastEnd + '/' + media.size,
          media.slice(offset, lastEnd + 1),
        )
        if (response.status >= 500 || response.status === 429) response = await exchange(probe)
      } catch {
        signal?.throwIfAborted()
        response = await exchange(probe)
      }
    }
  }
}
