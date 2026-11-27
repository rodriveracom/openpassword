export class ClientError extends Error {
  constructor(status, code) {
    super(`${status} ${code}`);
    this.status = status;
    this.code = code;
  }
}

const MAX_BODY = 1 << 20; // the protocol's largest value, key or checkpoint state

function isLoopback(host) {
  if (host === "localhost" || host === "[::1]") return true;
  return /^127(\.\d{1,3}){3}$/.test(host);
}

// The bearer token grants the whole store: only https, or http to loopback, may carry it.
function checkUrl(url) {
  const u = new URL(url);
  if (u.protocol === "https:" || (u.protocol === "http:" && isLoopback(u.hostname))) return;
  throw new Error("refusing to send the token over plain http to a non-loopback address; use https://");
}

async function bounded(res, limit) {
  const declared = Number(res.headers.get("content-length"));
  if (declared > limit) {
    await res.body?.cancel();
    throw new ClientError(res.status, "oversized_response");
  }
  if (!res.body) return new Uint8Array();
  // Read through one reader. On any early exit cancel through that reader: cancelling
  // res.body while a reader holds the lock throws ERR_INVALID_STATE.
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new ClientError(res.status, "oversized_response");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

function receipt(headers) {
  return {
    partition: Number(headers.get("Dostoevsky-Partition")),
    offset: BigInt(headers.get("Dostoevsky-Offset")),
  };
}

export class Client {
  #base;
  #token;
  constructor(url, token) {
    checkUrl(url);
    this.#base = url.replace(/\/+$/, "") + "/dostoevsky/client/v1/";
    this.#token = token;
  }
  async #call(op, args, body) {
    const url = new URL(this.#base + op);
    for (const [k, v] of Object.entries(args)) url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      method: body === undefined ? "GET" : "POST", body, redirect: "error",
      headers: { Authorization: "Bearer " + this.#token, "Content-Type": "application/octet-stream" },
      signal: AbortSignal.timeout(40000),
    });
    if (!res.ok) {
      const text = new TextDecoder().decode(await bounded(res, 4096).catch(() => new Uint8Array()));
      throw new ClientError(res.status, text.trim().slice(0, 256));
    }
    return res;
  }
  async publish(topic, value, { key = "", id = "" } = {}) {
    const res = await this.#call("publish", { topic, key, id }, value);
    await bounded(res, 4096);
    return receipt(res.headers);
  }
  async read(topic, partition, offset, waitMs = 0) {
    const res = await this.#call("read", { topic, partition, offset, wait_ms: waitMs });
    if (res.status === 204) { await res.body?.cancel(); return null; }
    return { ...receipt(res.headers), key: decodeURIComponent(res.headers.get("Dostoevsky-Key")),
      id: decodeURIComponent(res.headers.get("Dostoevsky-ID")), time: res.headers.get("Dostoevsky-Time"),
      value: await bounded(res, MAX_BODY) };
  }
  async position(topic, partition, group) {
    const res = await this.#call("position", { topic, partition, group });
    return { next: BigInt(res.headers.get("Dostoevsky-Next")), state: await bounded(res, MAX_BODY) };
  }
  async commit(topic, partition, group, expected, state = new Uint8Array()) {
    const res = await this.#call("commit", { topic, partition, group, expected }, state);
    await res.body?.cancel(); // a success carries no body; release the connection either way
  }
}
