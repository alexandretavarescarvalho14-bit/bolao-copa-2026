// Função serverless — Upstash Redis via API REST.
// Variáveis injetadas automaticamente pela integração do Marketplace Vercel.

const UPSTASH_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const DEFAULT_USERS = [
  { id: "alexandre", name: "Alexandre", pin: "1234", initials: "AL" },
  { id: "joao", name: "João", pin: "2345", initials: "JO" },
  { id: "lucas", name: "Lucas", pin: "3456", initials: "LU" },
  { id: "heitor", name: "Heitor", pin: "4567", initials: "HE" },
  { id: "luis", name: "Luís", pin: "5678", initials: "LS" },
  { id: "murilo", name: "Murilo", pin: "6789", initials: "MU" },
  { id: "arthur", name: "Arthur", pin: "7890", initials: "AR" },
  { id: "cadu", name: "Cadu", pin: "8901", initials: "CA" },
];

let cache = { data: null, ts: 0 };
const CACHE_TTL_MS = 2000;

function safeJsonParse(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function validateUsers(users) {
  if (!Array.isArray(users) || users.length === 0) {
    throw new Error("value deve ser um array de usuários");
  }

  const ids = new Set();
  const pins = new Set();

  return users.map((u) => {
    if (!isPlainObject(u)) throw new Error("usuário inválido");

    const id = String(u.id || "").trim();
    const name = String(u.name || "").trim();
    const pin = String(u.pin || "").trim();
    const initials = String(u.initials || "").trim().toUpperCase();

    if (!/^[a-z0-9_-]{2,32}$/.test(id) || id === "__admin__") {
      throw new Error(`id inválido: ${id}`);
    }
    if (!name || name.length > 60 || /[<>]/.test(name)) {
      throw new Error(`nome inválido para ${id}`);
    }
    if (!/^\d{4}$/.test(pin)) {
      throw new Error(`PIN inválido para ${id}`);
    }
    if (!/^[A-Z0-9]{1,3}$/.test(initials)) {
      throw new Error(`sigla inválida para ${id}`);
    }
    if (ids.has(id)) throw new Error(`id duplicado: ${id}`);
    if (pins.has(pin)) throw new Error(`PIN duplicado: ${pin}`);

    ids.add(id);
    pins.add(pin);

    return { id, name, pin, initials };
  });
}

function normalizeScore(v) {
  if (v === "" || v === null || v === undefined) return "";
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 20) {
    throw new Error("placar inválido: use número inteiro entre 0 e 20");
  }
  return n;
}

function validateBetsMap(value) {
  if (!isPlainObject(value)) throw new Error("value deve ser objeto");
  const out = {};

  for (const [matchId, bet] of Object.entries(value)) {
    if (!/^\d+$/.test(matchId) || !isPlainObject(bet)) continue;

    const clean = {};
    if ("homeScore" in bet) clean.homeScore = normalizeScore(bet.homeScore);
    if ("awayScore" in bet) clean.awayScore = normalizeScore(bet.awayScore);
    if (["et", "pk", ""].includes(bet.etType)) clean.etType = bet.etType;
    if (["home", "away", ""].includes(bet.advancedTeam)) {
      clean.advancedTeam = bet.advancedTeam;
    }

    out[matchId] = clean;
  }

  return out;
}

function validateBonusBetsMap(value) {
  if (!isPlainObject(value)) throw new Error("value deve ser objeto");
  const out = {};

  for (const [key, val] of Object.entries(value)) {
    const cleanKey = String(key).trim();
    if (!/^[a-z0-9_-]{1,40}$/.test(cleanKey)) continue;

    if (typeof val === "number") {
      out[cleanKey] = val;
    } else {
      const cleanVal = String(val ?? "").trim().slice(0, 80);
      if (cleanVal !== "") out[cleanKey] = cleanVal;
    }
  }

  return out;
}

function validateResultsMap(value) {
  if (!isPlainObject(value)) throw new Error("value deve ser objeto");
  const out = {};

  for (const [matchId, result] of Object.entries(value)) {
    if (!/^\d+$/.test(matchId) || !isPlainObject(result)) continue;

    const clean = {
      homeScore: normalizeScore(result.homeScore),
      awayScore: normalizeScore(result.awayScore),
    };

    if (clean.homeScore === "" || clean.awayScore === "") continue;

    if (["et", "pk"].includes(result.etType)) clean.etType = result.etType;
    if (["home", "away"].includes(result.advancedTeam)) {
      clean.advancedTeam = result.advancedTeam;
    }

    out[matchId] = clean;
  }

  return out;
}

function validateMatchTeams(value) {
  if (!isPlainObject(value)) throw new Error("value deve ser objeto");
  const out = {};

  for (const [matchId, mt] of Object.entries(value)) {
    if (!/^\d+$/.test(matchId) || !isPlainObject(mt)) continue;

    const homeId = Number(mt.homeId);
    const awayId = Number(mt.awayId);

    if (!Number.isInteger(homeId) || !Number.isInteger(awayId)) continue;
    if (
      homeId < 1 ||
      homeId > 48 ||
      awayId < 1 ||
      awayId > 48 ||
      homeId === awayId
    ) {
      continue;
    }

    out[matchId] = {
      homeId,
      awayId,
      home: mt.home || null,
      away: mt.away || null,
    };
  }

  return out;
}

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

  if (!res.ok || json.error) {
    throw new Error(json.error || `Redis ${res.status}`);
  }

  return json.result;
}

async function getUsers() {
  const raw = await redis(["GET", "users"]).catch(() => null);
  const parsed = safeJsonParse(raw, null);

  if (parsed) {
    try {
      return validateUsers(parsed);
    } catch (e) {
      console.error("[bolao] usuários inválidos no Redis; restaurando padrão:", e);
    }
  }

  await redis(["SET", "users", JSON.stringify(DEFAULT_USERS)]);
  return DEFAULT_USERS;
}

async function fetchAll() {
  const users = await getUsers();
  const ids = users.map((u) => u.id);

  const betKeys = ids.map((u) => `bets:${u}`);
  const bonusKeys = ids.map((u) => `bonus:${u}`);
  const adminKeys = ["results", "bonusResults", "matchTeams"];
  const allKeys = [...betKeys, ...bonusKeys, ...adminKeys];

  const values = await redis(["MGET", ...allKeys]);

  const out = {
    users,
    bets: {},
    bonusBets: {},
    results: {},
    bonusResults: {},
    matchTeams: {},
  };

  (values || []).forEach((v, i) => {
    const parsed = safeJsonParse(v, null);
    const key = allKeys[i];

    if (key.startsWith("bets:")) {
      out.bets[key.slice(5)] = parsed || {};
    } else if (key.startsWith("bonus:")) {
      out.bonusBets[key.slice(6)] = parsed || {};
    } else {
      out[key] = parsed || {};
    }
  });

  return out;
}

export default async function handler(req, res) {
  // O app usa o endpoint no mesmo domínio da Vercel.
  // Mantemos OPTIONS para não quebrar testes locais simples.
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return res.status(500).json({ error: "Banco não configurado." });
  }

  try {
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

    if (req.method === "POST") {
      const body =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body;

      const { scope, uid, value } = body || {};

      if (!scope || value === undefined) {
        return res.status(400).json({
          error: "Campos obrigatórios: scope, value",
        });
      }

      const users = await getUsers();
      const validUserIds = new Set(users.map((u) => u.id));

      cache = { data: null, ts: 0 };

      if (scope === "users") {
        const cleanUsers = validateUsers(value);
        await redis(["SET", "users", JSON.stringify(cleanUsers)]);
        return res.status(200).json({ ok: true });
      }

      if (scope === "bets" || scope === "bonusBets") {
        if (!uid || !validUserIds.has(uid)) {
          return res.status(400).json({ error: "uid inválido" });
        }

        const redisKey = scope === "bets" ? `bets:${uid}` : `bonus:${uid}`;
        const cleanValue =
          scope === "bets" ? validateBetsMap(value) : validateBonusBetsMap(value);

        await redis(["SET", redisKey, JSON.stringify(cleanValue)]);

        return res.status(200).json({ ok: true });
      }

      if (scope === "results") {
        await redis(["SET", "results", JSON.stringify(validateResultsMap(value))]);
        return res.status(200).json({ ok: true });
      }

      if (scope === "bonusResults") {
        await redis([
          "SET",
          "bonusResults",
          JSON.stringify(validateBonusBetsMap(value)),
        ]);
        return res.status(200).json({ ok: true });
      }

      if (scope === "matchTeams") {
        await redis([
          "SET",
          "matchTeams",
          JSON.stringify(validateMatchTeams(value)),
        ]);
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: "scope inválido" });
    }

    return res.status(405).json({ error: "Método não permitido" });
  } catch (e) {
    console.error("[bolao] erro:", e);
    return res.status(500).json({ error: String(e) });
  }
}
