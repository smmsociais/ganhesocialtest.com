import pkg from "mongodb";
import { z } from "zod";
import axios from "axios";
import jwt from "jsonwebtoken";
import { DailyEarning } from "./schema.js";
import connectDB from "./db.js";

const { MongoClient, ObjectId } = pkg;
const MONGODB_URI = process.env.MONGODB_URI;
const API_URL = "https://ganhesocial.com/api";

let cachedClient = null;
let cachedDb = null;

async function connectToDatabase() {
  if (cachedDb) return cachedDb;
  const client = await MongoClient.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  cachedClient = client;
  cachedDb = client.db();
  return cachedDb;
}

const ActionSchema = z.object({
  _id: z.any(),
  user: z.any(),
  nome_usuario: z.string().min(1),
  id_pedido: z.string().min(1),
  id_conta: z.string().min(1),
  url_dir: z.string().min(1),
  quantidade_pontos: z.number(),
  valor_confirmacao: z.union([z.string(), z.number()]),
  tipo_acao: z.string().min(1),
  token: z.string().min(1),
});

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método não permitido. Use GET." });
  }

  const vercelJwt = req.headers["x-vercel-oidc-token"];
  if (!vercelJwt) {
    return res.status(403).json({ error: "Authorization token missing" });
  }

  try {
    const decoded = jwt.decode(vercelJwt);
    const expectedAud = "https://vercel.com/ganhesocialcom";
    const expectedIss = "https://oidc.vercel.com/ganhesocialcom";

    if (!decoded || decoded.aud !== expectedAud || decoded.iss !== expectedIss) {
      throw new Error("Invalid token");
    }

    console.log("▶ verificar-follows chamado em", new Date().toISOString());

    const db = await connectToDatabase();
    await connectDB(); // ⬅️ garante conexão Mongoose para o modelo DailyEarning
    const colecao = db.collection("actionhistories");
    const usuarios = db.collection("users");

    const acoes = await colecao.find({
      acao_validada: "pendente",
      tipo: "seguir",
    })
      .sort({ data: 1 })
      .limit(200)
      .toArray();

    console.log(`📦 Encontradas ${acoes.length} ações pendentes.`);

    if (acoes.length === 0) {
      return res.status(200).json({ status: "ok", processadas: 0 });
    }

    let processadas = 0;

    for (const acao of acoes) {
      try {
        const valid = ActionSchema.parse(acao);
        console.log(`— Processando _id=${valid._id}, usuário='${valid.nome_usuario}'`);

        let accountFound = false;
        try {
          const idConta = String(valid.id_conta).trim();
          if (!idConta || typeof idConta !== "string") throw new Error(`id_conta inválido: ${idConta}`);

          const followingRes = await axios.get(`${API_URL}/user-following?userId=${idConta}`, {
            headers: { Authorization: `Bearer ${valid.token}` },
          });

          const followings = followingRes.data?.data?.followings || [];

          const match = valid.url_dir.toLowerCase().match(/@([\w_.]+)/);
          const targetUsername = match ? match[1] : valid.url_dir.replace(/^@/, "").toLowerCase();

          accountFound = followings.some(f => f.unique_id?.toLowerCase() === targetUsername);
        } catch (e) {
          console.error("   ✗ Falha em /user-following:", e.message);
          continue;
        }

await colecao.updateOne(
  { _id: new ObjectId(valid._id) },
  { $set: { acao_validada: accountFound ? "valida" : "invalida", verificada_em: new Date() } }
);
        if (accountFound) {
          const valor = parseFloat(valid.valor_confirmacao);
          if (!isNaN(valor) && valor > 0) {
            await usuarios.updateOne(
              { _id: new ObjectId(valid.user) },
              { $inc: { saldo: valor } }
            );
            console.log(`   ✓ Saldo do usuário ${valid.user} incrementado em ${valor}`);

const agora = new Date();
console.log("🕒 Agora (UTC):", agora.toISOString());

const offsetBrasilia = -3;

const brasilAgora = new Date(agora.getTime() + offsetBrasilia * 60 * 60 * 1000);
console.log("🇧🇷 Agora em Brasília:", brasilAgora.toISOString());

const brasilMidnightTomorrow = new Date(Date.UTC(
  brasilAgora.getUTCFullYear(),
  brasilAgora.getUTCMonth(),
  brasilAgora.getUTCDate() + 1,
  3,
  0,
  0,
  0
));
console.log("🕛 Meia-noite de amanhã Brasília (UTC):", brasilMidnightTomorrow.toISOString());

await DailyEarning.updateOne(
  {
    userId: new ObjectId(valid.user),
    expiresAt: brasilMidnightTomorrow,
  },
  {
    $inc: { valor },
    $setOnInsert: {
      expiresAt: brasilMidnightTomorrow,
    },
  },
  { upsert: true }
);

            console.log(`   ✓ Saldo e dailyearning atualizados para o usuário ${valid.user} em R$${valor}`);
          } else {
            console.warn(`   ⚠ valor_confirmacao inválido para ação ${valid._id}:`, valid.valor_confirmacao);
          }

          if (valid.id_pedido) {
            try {
              await axios.post(
                "https://smmsociais.com/api/incrementar-validadas",
                { id_acao_smm: valid.id_pedido },
                { headers: { Authorization: `Bearer ${process.env.SMM_API_KEY}` } }
              );
              console.log("   ✓ Notificação para smmsociais.com enviada com sucesso.");
            } catch (err) {
              console.error("   ✗ Erro ao notificar smmsociais.com:", err.response?.data || err.message);
            }
          }
        }

        console.log(`   ✓ Ação ${valid._id} atualizada: acao_validada=${accountFound}`);
        processadas++;
      } catch (err) {
        console.error(`   ✗ Erro ao processar ação ${acao._id}:`, err);
      }
    }

    console.log(`✔ Fim do processamento: ${processadas} ações processadas.`);
    return res.status(200).json({ status: "ok", processadas });

  } catch (error) {
    console.error("✗ Erro geral em verificar-follows:", error);
    return res.status(500).json({ error: "Erro interno", details: error.message });
  }
}