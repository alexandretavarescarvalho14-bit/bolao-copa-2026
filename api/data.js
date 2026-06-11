// Função serverless que conversa com o Upstash Redis.
// Roda no servidor da Vercel — o token do banco nunca chega ao navegador.
//
// A integração Upstash do Marketplace injeta as variáveis de ambiente
// automaticamente. Dependendo da versão, os nomes podem variar, então
// aceitamos as duas convenções mais comuns.

const UPSTASH_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// IDs fixos dos participantes (devem bater com o index.html)
const USER_IDS = ["alexandre", "joao", "lucas", "heitor", "luis", "murilo"];

// Executa um comando Redis via API REST do Upstash
async function redis(command) {
  const response = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    throw new Error(data.error || `Erro no Redis: ${response.status}`);
  }

  return data.result;
}

export default async function handler(req, res) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return res.status(500).json({
      error:
        "Banco não configurado. Adicione a integração Upstash Redis na aba Storage do projeto na Vercel e faça um novo deploy.",
    });
  }

  try {
    // LEITURA: devolve todo o estado do bolão de uma vez
    if (req.method === "GET") {
      const betKeys = USER_IDS.map((u) => `bets:${u}`);
      const bonusKeys = USER_IDS.map((u) => `bonus:${u}`);
      const adminKeys = ["results", "bonusResults", "matchTeams"];
      const allKeys = [...betKeys, ...bonusKeys, ...adminKeys];

      const values = await redis(["MGET", ...allKeys]);

      const out = {
        bets: {},
        bonusBets: {},
        results: {},
        bonusResults: {},
        matchTeams: {},
      };

      (values || []).forEach((v, i) => {
        let parsed = null;

        try {
          parsed = v ? JSON.parse(v) : null;
        } catch (e) {
          parsed = null;
        }

        const key = allKeys[i];

        if (key.startsWith("bets:")) {
          out.bets[key.slice(5)] = parsed || {};
        } else if (key.startsWith("bonus:")) {
          out.bonusBets[key.slice(6)] = parsed || {};
        } else {
          out[key] = parsed || {};
        }
      });

      return res.status(200).json(out);
    }

    // ESCRITA: grava uma fatia do estado
    if (req.method === "POST") {
      const body =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body;

      const { scope, uid, value } = body;

      let redisKey;

      if (scope === "bets" || scope === "bonusBets") {
        if (!USER_IDS.includes(uid)) {
          return res.status(400).json({ error: "usuário inválido" });
        }

        redisKey = scope === "bets" ? `bets:${uid}` : `bonus:${uid}`;
      } else if (["results", "bonusResults", "matchTeams"].includes(scope)) {
        redisKey = scope;
      } else {
        return res.status(400).json({ error: "scope inválido" });
      }

      await redis(["SET", redisKey, JSON.stringify(value)]);

      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "método não permitido" });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
