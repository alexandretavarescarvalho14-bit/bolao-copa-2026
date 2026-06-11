// Função serverless — Upstash Redis via API REST.
// Variáveis injetadas automaticamente pela integração do Marketplace Vercel.

const UPSTASH_URL   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const USER_IDS = ["alexandre","joao","lucas","heitor","luis","murilo","arthur","cadu"];

// Cache em memória por instância (warm lambda) — evita round-trips repetidos
// na mesma invocação serverless. TTL curto: 2 s para GET, imediato para POST.
let cache = { data: null, ts: 0 };
const CACHE_TTL_MS = 2000;

async function redis(command) {
  const res = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `Redis ${res.status}`);
  return json.result;
}

// Constrói todas as chaves de uma vez e faz um único MGET
async function fetchAll() {
  const betKeys   = USER_IDS.map(u => `bets:${u}`);
  const bonusKeys = USER_IDS.map(u => `bonus:${u}`);
  const adminKeys = ["results", "bonusResults", "matchTeams"];
  const allKeys   = [...betKeys, ...bonusKeys, ...adminKeys];

  const values = await redis(["MGET", ...allKeys]);

  const out = { bets:{}, bonusBets:{}, results:{}, bonusResults:{}, matchTeams:{} };

  (values || []).forEach((v, i) => {
    let parsed = null;
    try { parsed = v ? JSON.parse(v) : null; } catch {}
    const key = allKeys[i];
    if      (key.startsWith("bets:"))  out.bets[key.slice(5)]     = parsed || {};
    else if (key.startsWith("bonus:")) out.bonusBets[key.slice(6)] = parsed || {};
    else                               out[key]                    = parsed || {};
  });

  return out;
}

export default async function handler(req, res) {
  // CORS permissivo (mesmo domínio Vercel, mas útil se mover para domínio custom)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return res.status(500).json({
      error: "Banco não configurado. Adicione a integração Upstash Redis na aba Storage da Vercel e faça um novo deploy.",
    });
  }

  try {
    // ── GET: leitura completa com cache de instância ──────────────────────
    if (req.method === "GET") {
      const now = Date.now();
      if (cache.data && now - cache.ts < CACHE_TTL_MS) {
        res.setHeader("X-Cache", "HIT");
        return res.status(200).json(cache.data);
      }
      const data = await fetchAll();
      cache = { data, ts: now };
      res.setHeader("X-Cache", "MISS");
      return res.status(200).json(data);
    }

    // ── POST: escrita cirúrgica de uma chave ──────────────────────────────
    if (req.method === "POST") {
      const body  = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const { scope, uid, value } = body || {};

      if (!scope || value === undefined) {
        return res.status(400).json({ error: "Campos obrigatórios: scope, value" });
      }

      let redisKey;
      if (scope === "bets" || scope === "bonusBets") {
        if (!uid || !USER_IDS.includes(uid))
          return res.status(400).json({ error: "uid inválido" });
        redisKey = scope === "bets" ? `bets:${uid}` : `bonus:${uid}`;
      } else if (["results", "bonusResults", "matchTeams"].includes(scope)) {
        redisKey = scope;
      } else {
        return res.status(400).json({ error: "scope inválido" });
      }

      await redis(["SET", redisKey, JSON.stringify(value)]);
      cache = { data: null, ts: 0 }; // invalida cache após escrita
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Método não permitido" });

  } catch (e) {
    console.error("[bolao] erro:", e);
    return res.status(500).json({ error: String(e) });
  }
}
