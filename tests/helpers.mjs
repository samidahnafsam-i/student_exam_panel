// In-memory stand-in for @netlify/blobs: same method names/shapes the app uses.
export function memoryStores() {
  const stores = new Map();
  const getStore = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      async get(k, o = {}) { if (!m.has(k)) return null; const v = m.get(k); return o.type === "json" ? JSON.parse(v) : v; },
      async set(k, v) { m.set(k, v); },
      async setJSON(k, v) { m.set(k, JSON.stringify(v)); },
      async delete(k) { m.delete(k); },
      async list(o = {}) { return { blobs: [...m.keys()].filter((k) => !o.prefix || k.startsWith(o.prefix)).map((key) => ({ key })) }; },
    };
  };
  return { getStore, stores };
}

export function client(handler, password = "pw") {
  const call = async (method, path, body, admin = false) => {
    const r = await handler(new Request("http://x" + path, {
      method,
      headers: { "content-type": "application/json", ...(admin ? { "x-admin-password": password } : {}) },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }));
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, body: data, text };
  };
  return {
    call,
    admin: (m, p, b) => call(m, p, b, true),
    pub: (m, p, b) => call(m, p, b, false),
  };
}

export const q = (correct, extra = {}) => ({ img: "img" + Math.random().toString(16).slice(2, 10), options: 4, label: "", correct, ...extra });
