// worker.followsig.js
import express from "express";
import axios, { HttpStatusCode } from "axios";
import { z } from "zod";
import pkg from "mongodb";

const { MongoClient, ObjectId } = pkg;

/* ---------- CONFIG ---------- */
const PORT = process.env.PORT || 3002;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || process.env.RAPIDAPI || "f3dbe81fe5msh5f7554a137e41f1p11dce0jsnabd433c62319";
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://renisson:renisson@cluster0.zbsseoh.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "15000", 10);
const MAX_BATCH = parseInt(process.env.MAX_BATCH || "200", 10);
const AXIOS_TIMEOUT = parseInt(process.env.AXIOS_TIMEOUT || "20000", 10);
const MAX_FETCH_RETRIES = parseInt(process.env.MAX_FETCH_RETRIES || "2", 10);
const MAX_VERIFY_ATTEMPTS = parseInt(process.env.MAX_VERIFY_ATTEMPTS || "2", 10);
const SMM_API_KEY = process.env.SMM_API_KEY || "123456";

/* ---------- caches & tuning ---------- */
const secUidCache = new Map(); // actorUsername -> sec_uid (username normalizado)
const followingsCache = new Map(); // sec_uid -> { set: Set(username), fetchedAt: ms }
const FOLLOWINGS_CACHE_MS = 60 * 1000; // 60s
const SCRAPTIK_THROTTLE_MS = 600; // ms between scraptik/rapidapi calls
const MAX_FOLLOWING_PAGES = 60;
const PER_PAGE = 200;

/* ---------- safety checks ---------- */
if (!MONGODB_URI) {
  console.error("✗ MONGODB_URI não definido. Defina env var MONGODB_URI");
  process.exit(1);
}
if (!RAPIDAPI_KEY) {
  console.warn("⚠ RAPIDAPI_KEY não definido. Chamadas RapidAPI irão falhar.");
}
if (!SMM_API_KEY) {
  console.warn("⚠ SMM_API_KEY não definido. Rotas de notificação SMM não irão funcionar.");
}

/* ---------- DB ---------- */
let cachedClient = null;
let cachedDb = null;
async function connectToDatabase() {
  if (cachedDb) return cachedDb;
  console.log("→ Conectando ao MongoDB...");
  const client = await MongoClient.connect(MONGODB_URI);
  cachedClient = client;
  cachedDb = client.db();
  console.log("🟢 Conectado ao MongoDB.");
  return cachedDb;
}

/* ---------- axios + helpers with retries ---------- */
async function axiosGetWithRetries(url, opts = {}, retries = MAX_FETCH_RETRIES) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await axios.get(url, { timeout: AXIOS_TIMEOUT, ...opts });
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      const data = err?.response?.data;
      const dstr = typeof data === "string" ? data : JSON.stringify(data || {});
      if (status === 400 && /not found|private|user not found|not exists|invalid/i.test(dstr)) {
        const e = new Error("non_retryable_400: " + (dstr || err.message));
        e.nonRetryable = true;
        throw e;
      }
      const wait = Math.min(1000 * Math.pow(2, i), 15000);
      console.warn(`   ⚠ axios GET falhou (tentativa ${i + 1}/${retries + 1}): ${err.message || err}. Retrying in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/* ---------- scraptikGet kept for compatibility (not used for IG following) ---------- */
async function scraptikGet(path, params = {}) {
  if (!RAPIDAPI_KEY) throw new Error("RAPIDAPI_KEY not set");
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || String(v).trim() === "") {
      throw new Error(`invalid_param_${k}`);
    }
  }
  const url = `https://scraptik.p.rapidapi.com/${path}`;
  const headers = {
    "x-rapidapi-key": RAPIDAPI_KEY,
    "x-rapidapi-host": "scraptik.p.rapidapi.com"
  };
  const res = await axiosGetWithRetries(url, { params, headers });
  await new Promise(r => setTimeout(r, SCRAPTIK_THROTTLE_MS));
  return res.data;
}

/* ---------- utilities ---------- */
function extractUsernameFromUrl(urlDir) {
  if (!urlDir || typeof urlDir !== "string") return null;
  let s = urlDir.replace(/[\r\n]/g, "").trim();
  s = s.split("?")[0].split("#")[0];
  const m = s.match(/@([A-Za-z0-9_.-]+)/);
  if (m && m[1]) return m[1].toLowerCase();
  s = s.replace(/^\/+|\/+$/g, "");
  if (s.includes("/")) {
    const parts = s.split("/");
    s = parts[parts.length - 1];
  }
  if (s.startsWith("@")) s = s.slice(1);
  s = s.trim().toLowerCase();
  return s === "" ? null : s;
}

function toObjectId(maybe) {
  if (!maybe) return null;
  if (maybe instanceof ObjectId) return maybe;
  try { return new ObjectId(String(maybe)); } catch (e) { return null; }
}

/* ---------- Instagram followings via RapidAPI (pagination) ---------- */
async function getFollowingsSetForSecUid(secUid) {
  if (!secUid) return new Set();
  const cache = followingsCache.get(secUid);
  if (cache && (Date.now() - cache.fetchedAt) < FOLLOWINGS_CACHE_MS) {
    return cache.set;
  }

  const collected = [];
  let page = 0;
  let pagination_token = "";

  const url = "https://instagram-social-api.p.rapidapi.com/v1/following";
  const headers = {
    "x-rapidapi-key": RAPIDAPI_KEY,
    "x-rapidapi-host": "instagram-social-api.p.rapidapi.com"
  };

  const amountPerPage = Math.min(PER_PAGE, 1000);

  while (page < MAX_FOLLOWING_PAGES) {
    page++;
    try {
      const params = {
        username_or_id_or_url: secUid,
        amount: String(amountPerPage),
        pagination_token: pagination_token || ""
      };
      const resp = await axiosGetWithRetries(url, { params, headers });
      const data = resp.data || {};
      const items = (data?.data?.items) || data?.items || [];
      if (Array.isArray(items) && items.length > 0) {
        collected.push(...items);
      }
      const nextToken = data?.pagination_token || data?.next || null;
      if (!nextToken) break;
      pagination_token = nextToken;
      await new Promise(r => setTimeout(r, SCRAPTIK_THROTTLE_MS));
    } catch (err) {
      if (err.nonRetryable) {
        console.warn("   → instagram-following non-retryable for", secUid, ":", err.message);
        break;
      }
      console.error("   ✗ Erro paginando instagram following:", err.message || err);
      break;
    }
  }

  const set = new Set(
    (collected || []).map(f => String(f?.username || f?.user_name || f?.id || "").toLowerCase()).filter(Boolean)
  );
  followingsCache.set(secUid, { set, fetchedAt: Date.now() });
  return set;
}

/* ---------- getSecUidForUsername (Instagram: return normalized username) ---------- */
async function getSecUidForUsername(username) {
  if (!username) return null;
  username = String(username).replace(/^@/, "").trim().toLowerCase();
  if (username === "") return null;
  if (secUidCache.has(username)) return secUidCache.get(username);
  secUidCache.set(username, username);
  return username;
}

/* ---------- Zod action schema (adaptado ao seu mongoose schema) ---------- */
const ActionSchema = z.object({
  _id: z.any(),
  user: z.any(),
  token: z.string().optional(),
  nome_usuario: z.string().optional(),
  id_action: z.string().optional(),
  url: z.string().optional(),
  url_dir: z.string().optional(),
  status: z.string().optional(),
  acao_validada: z.string().min(1),
  valor: z.number().optional(),
  valor_confirmacao: z.union([z.string(), z.number()]).optional(),
  tipo_acao: z.string().optional(),
  tipo: z.string().optional(),
  rede_social: z.string().optional(),
  id_pedido: z.union([z.string(), z.number()]).optional(),
  id_conta: z.string().optional()
});

/* ---------- normalization helper ---------- */
function normalizeAction(raw) {
  if (!raw || typeof raw !== "object") return raw;
  return {
    ...raw,
    url: raw.url || raw.url_dir || raw.link || "",
    url_dir: raw.url_dir || raw.url || raw.link || "",
    tipo_acao: raw.tipo_acao || raw.tipo || raw.action_type || "",
    valor: (raw.valor !== undefined && raw.valor !== null) ? Number(raw.valor) :
           (raw.valor_confirmacao !== undefined ? Number(raw.valor_confirmacao) : undefined),
    acao_validada: raw.acao_validada || raw.status || (raw.acaoValidada ? String(raw.acaoValidada) : "pendente"),
    nome_usuario: raw.nome_usuario || raw.username || raw.actor || "",
    id_action: raw.id_action || raw.id_action_smm || raw.id || "",
    id_pedido: raw.id_pedido || raw.idPedido || raw.id_acao_smm || raw.id_action
  };
}

/* ---------- acquireLock (robusto, aceita string/ObjectId) ---------- */
async function acquireLock(colecao, id) {
  const TWO_MIN_MS = 2 * 60 * 1000;
  const now = new Date();
  const oid = toObjectId(id);
  if (!oid) return null;
  const lock = await colecao.findOneAndUpdate(
    {
      _id: oid,
      $or: [
        { processing: { $ne: true } },
        { processingAt: { $lte: new Date(Date.now() - TWO_MIN_MS) } }
      ]
    },
    { $set: { processing: true, processingAt: now } },
    { returnDocument: "after" }
  );
  return lock?.value || null;
}

/* ---------- core: processBatch (ajustado ao schema) ---------- */
async function processBatch() {
  const db = await connectToDatabase();
  const colecao = db.collection("actionhistories");
  const usuarios = db.collection("users");
  const dailyearnings = db.collection("dailyearnings");

  // Query tolerante: aceita acao_validada OR status; tipo_acao OR tipo
  const query = {
    $and: [
      { $or: [ { status: "pendente" }, { status: "pendente" } ] },
      { $or: [ { tipo_acao: "seguir" }, { tipo: "seguir" } ] }
    ]
  };

  const acoes = await colecao.find(query).sort({ data: 1 }).limit(MAX_BATCH).toArray();

  if (!acoes || acoes.length === 0) {
    return { processed: 0, fetched: 0 };
  }

  console.log(`📦 ${acoes.length} ações pendentes (agrupando por actor)...`);

  // Agrupa por actorUsername extraído de nome_usuario (fallback para id_conta)
  const groups = new Map();
  for (const ac of acoes) {
    try {
      const norm = normalizeAction(ac);
      const valid = ActionSchema.parse(norm);
      let actor = String(valid.nome_usuario || valid.id_conta || valid.user || "").trim();
      if (!actor) {
        console.warn("   ⚠ ação sem nome_usuario/id_conta:", ac._id);
        await colecao.updateOne({ _id: toObjectId(ac._id) }, { $set: { HttpStatusCode: "invalida", verificada_em: new Date(), processing: false } });
        continue;
      }
      if (actor.startsWith("local_")) actor = actor.slice(6);
      if (actor.startsWith("@")) actor = actor.slice(1);
      actor = actor.toLowerCase();
      const arr = groups.get(actor) || [];
      arr.push(valid);
      groups.set(actor, arr);
    } catch (e) {
      console.warn("   ⚠ documento inválido ignorado (normalização/parse):", ac._id, e.message || e);
      try { await colecao.updateOne({ _id: toObjectId(ac._id) }, { $set: { processing: false } }); } catch(_) {}
    }
  }

  let processedCount = 0;

  for (const [actorUsername, actions] of groups.entries()) {
    console.log(`→ Processando actor='${actorUsername}' com ${actions.length} ações`);

    // 1) get sec_uid (para Instagram usamos username normalizado)
    const actorSecUid = await getSecUidForUsername(actorUsername);

    if (!actorSecUid) {
      console.log(`   → Não foi possível obter sec_uid para actor ${actorUsername}.`);
      for (const action of actions) {
        let lock = null;
        try {
          lock = await acquireLock(colecao, action._id);
          if (!lock) {
            console.log(`   — Pulando ${action._id} (já em processamento)`);
            continue;
          }
          const upd = await colecao.findOneAndUpdate(
            { _id: toObjectId(action._id) },
            { $inc: { verify_attempts: 1 } },
            { returnDocument: "after" }
          );
          const attempts = upd?.value?.verify_attempts || 1;
          if (attempts >= MAX_VERIFY_ATTEMPTS) {
            await colecao.updateOne({ _id: toObjectId(action._id) }, { $set: { status: "invalida", verificada_em: new Date(), processing: false } });
            console.log(`   ✗ Action ${action._id} marcada INVALIDA (sec_uid não obtido; attempts=${attempts})`);
            processedCount++;
          } else {
            await colecao.updateOne({ _id: toObjectId(action._id) }, { $set: { processing: false } });
            console.log(`   → Action ${action._id} deixada PENDENTE (verify_attempts=${attempts})`);
          }
        } catch (err) {
          console.error("   ✗ Erro tratando actor sem sec_uid:", err.message || err);
          try { if (lock) await colecao.updateOne({ _id: toObjectId(action._id) }, { $set: { processing: false } }); } catch (_) {}
        }
      }
      continue;
    }

    // 2) obter followings (cache)
    const followingSet = await getFollowingsSetForSecUid(actorSecUid);

    // 3) processa cada ação do actor com lock
    for (const action of actions) {
      let lock = null;
      try {
        lock = await acquireLock(colecao, action._id);
        if (!lock) {
          console.log(`— Pulando ${action._id} (já em processamento ou lock recente).`);
          continue;
        }

        const targetUsername = extractUsernameFromUrl(action.url_dir || action.url || "");
        if (!targetUsername) {
          console.warn("   ⚠ Não foi possível extrair targetUsername:", action._id, action.url_dir || action.url);
          await colecao.updateOne({ _id: toObjectId(action._id) }, { $set: { status: "invalida", verificada_em: new Date(), processing: false } });
          processedCount++;
          continue;
        }

        const found = followingSet.has(targetUsername.toLowerCase());

        await colecao.updateOne(
          { _id: toObjectId(action._id) },
          { $set: { status: found ? "valida" : "invalida", verificada_em: new Date(), processing: false } }
        );

        if (found) {
          const valor = Number(action.valor || action.valor_confirmacao || 0);
          if (!isNaN(valor) && valor > 0) {
            // incrementa saldo
            try {
              await usuarios.updateOne({ _id: toObjectId(action.user) }, { $inc: { saldo: valor } });
              console.log(`   ✓ Incrementado saldo user ${action.user} R$${valor}`);
            } catch (err) {
              console.error("   ✗ Erro ao incrementar saldo do usuário:", err.message || err);
            }

            // atualiza dailyearnings
            try {
              const agora = new Date();
              const brasilAgora = new Date(agora.getTime() + (-3) * 3600 * 1000);
              const brasilMidnightTomorrow = new Date(Date.UTC(
                brasilAgora.getUTCFullYear(),
                brasilAgora.getUTCMonth(),
                brasilAgora.getUTCDate() + 1,
                3, 0, 0, 0
              ));
              const valorToInc = Number(valor);
              await dailyearnings.updateOne(
                { userId: toObjectId(action.user), expiresAt: brasilMidnightTomorrow },
                { $inc: { valor: valorToInc }, $setOnInsert: { expiresAt: brasilMidnightTomorrow } },
                { upsert: true }
              );
            } catch (err) {
              console.error("   ⚠ Erro ao atualizar DailyEarning:", err.message || err);
            }

            // notifica smmsociais (opcional)
            if (action.id_pedido && SMM_API_KEY) {
              try {
                const payload = { id_acao_smm: Number(action.id_pedido) || action.id_pedido };
                console.log("   → Notificando smmsociais:", payload, "Authorization: Bearer <redacted>");

                const resp = await axios.post(
                  "https://smmsociais.com/api/incrementar-validadas",
                  payload,
                  {
                    headers: {
                      Authorization: `Bearer ${SMM_API_KEY}`,
                      "Content-Type": "application/json"
                    },
                    timeout: 10000
                  }
                );

                console.log("   ✓ smmsociais respondeu:", resp.status, JSON.stringify(resp.data));
              } catch (err) {
                console.error("   ✗ Erro notificando smmsociais:", err.message || err);
                if (err.response) {
                  console.error("     response.status:", err.response.status);
                  console.error("     response.data:", JSON.stringify(err.response.data));
                }
              }
            } else {
              if (!action.id_pedido) {
                console.log("   → Pulando notificação smmsociais: action.id_pedido ausente");
              } else if (!SMM_API_KEY) {
                console.log("   → Pulando notificação smmsociais: SMM_API_KEY não configurada (usando SMM_API_KEY const)");
              }
            }
          } else {
            console.warn("   ⚠ valor_confirmacao inválido:", action.valor, action.valor_confirmacao);
          }
        } else {
          console.log(`   ✗ Ação ${action._id} inválida (não encontrou follow).`);
        }

        if (!RAPIDAPI_KEY) {
          console.warn("⚠ RAPIDAPI_KEY não definido. Chamadas RapidAPI irão falhar.");
        }
        if (!SMM_API_KEY) {
          console.warn("⚠ SMM_API_KEY não definido. Rotas de notificação SMM não irão funcionar.");
        }

        processedCount++;
      } catch (err) {
        console.error("   ✗ Erro ao processar ação:", err?.message || err);
        try { if (lock) await colecao.updateOne({ _id: toObjectId(action._id) }, { $set: { processing: false } }); } catch (e) { console.error("   ⚠ Erro liberando lock:", e.message || e); }
      }
    } // fim actions do actor

    await new Promise(r => setTimeout(r, 250));
  } // fim groups

  return { processed: processedCount, fetched: acoes.length };
}

/* ---------- main loop ---------- */
let consecutiveErrors = 0;
async function mainLoop() {
  console.log("▶ Worker iniciado — iniciando polling.");
  while (true) {
    try {
      const { processed, fetched } = await processBatch();
      consecutiveErrors = 0;
      if (processed === 0 && fetched > 0) {
        await new Promise(r => setTimeout(r, Math.max(POLL_INTERVAL_MS, 2000)));
      } else {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      }
    } catch (err) {
      consecutiveErrors++;
      console.error("✗ Erro no processBatch:", err?.message || err);
      const backoff = Math.min(30000, 1000 * Math.pow(2, Math.min(consecutiveErrors, 6)));
      console.log(`⏳ Aguardando ${backoff}ms antes de nova tentativa (consecutiveErrors=${consecutiveErrors})`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
}

/* ---------- express health server ---------- */
const app = express();
app.get("/", (req, res) => res.send("Worker GanheSocial ativo 🚀"));
app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

const server = app.listen(PORT, () => {
  console.log(`🌍 HTTP server rodando na porta ${PORT}`);
  mainLoop().catch(err => { console.error("Erro fatal no worker:", err); process.exit(1); });
});

/* ---------- graceful shutdown ---------- */
async function shutdown(signal) {
  console.log(`\n⏹ Recebido ${signal} — encerrando...`);
  try { server.close(); } catch (e) { console.warn("Erro ao fechar server:", e.message || e); }
  try { if (cachedClient) { await cachedClient.close(); console.log("🔌 Conexão MongoDriver fechada."); } } catch (e) { console.warn("Erro ao fechar conexão MongoDriver:", e.message || e); }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
