// Serverless memo store backed by Vercel KV (Upstash Redis REST).
// Everything is kept under a single key "memos" as a JSON blob:
//   { works: { [workId]: {text,title,cat,updated} }, events: { [bannerUid]: {text,updated} } }
// The Upstash integration (Vercel → Storage) injects KV_REST_API_URL / KV_REST_API_TOKEN.

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kv(command) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error(`kv ${r.status}`);
  return r.json();
}

async function readMemos() {
  const { result } = await kv(['GET', 'memos']);
  const parsed = result ? JSON.parse(result) : {};
  return { works: parsed.works || {}, events: parsed.events || {} };
}

async function writeMemos(memos) {
  await kv(['SET', 'memos', JSON.stringify(memos)]);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!KV_URL || !KV_TOKEN) {
    return res.status(503).json({ error: 'storage_not_configured' });
  }

  try {
    if (req.method === 'GET') {
      return res.status(200).json(await readMemos());
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

      // Bulk migration: { migrate: { works: {...}, events: {...} } } merges without overwriting newer entries
      if (body.migrate) {
        const memos = await readMemos();
        for (const [id, v] of Object.entries(body.migrate.works || {})) {
          if (!memos.works[id]) memos.works[id] = { ...v, updated: v.updated || Date.now() };
        }
        for (const [id, v] of Object.entries(body.migrate.events || {})) {
          if (!memos.events[id]) memos.events[id] = { ...v, updated: v.updated || Date.now() };
        }
        await writeMemos(memos);
        return res.status(200).json({ ok: true, migrated: true });
      }

      const { kind, id, text, title, cat } = body;
      if (!kind || !id) return res.status(400).json({ error: 'kind_and_id_required' });
      const bucket = kind === 'event' ? 'events' : 'works';
      const memos = await readMemos();
      if (text && String(text).trim()) {
        memos[bucket][id] =
          bucket === 'works'
            ? { text, title: title || null, cat: cat || null, updated: Date.now() }
            : { text, updated: Date.now() };
      } else {
        delete memos[bucket][id];
      }
      await writeMemos(memos);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
