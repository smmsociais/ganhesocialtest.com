//handler.js
import axios from "axios";
import https from 'https';
import { v4 as uuidv4 } from 'uuid';
import connectDB from "./db.js";
import mongoose from "mongoose";
import nodemailer from 'nodemailer';
import { sendRecoveryEmail } from "./mailer.js";
import crypto from "crypto";
import { User, ActionHistory, DailyEarning, Pedido, DailyRanking } from "./schema.js";
import express from "express";
import jwt from "jsonwebtoken";

// IMPORTAÇÃO DAS ROTAS INDEPENDENTES
import buscarInstagram from "./buscar_acao_smm_instagram.js";
import buscarTikTok from "./buscar_acao_smm_tiktok.js";
import getInstagramUser from "./get-instagram-user.js";
import getTikTokUser from "./get-tiktok-user.js";
import smmAcao from "./smm_acao.js";
import verificarFollowing from "./user-following.js";
import googleSignup from "./auth/google/signup.js";
import googleSignupCallback from "./auth/google/signup/callback.js";
import googleLogin from "./auth/google.js";
import googleCallback from "./auth/google/callback.js";

const router = express.Router();

router.get("/buscar_acao_smm_instagram", buscarInstagram);
router.get("/buscar_acao_smm_tiktok", buscarTikTok);
router.get("/get-instagram-user", getInstagramUser);
router.get("/get-tiktok-user", getTikTokUser);
router.post("/smm_acao", smmAcao);
router.get("/user-following", verificarFollowing);
router.get("/auth/google", googleLogin);
router.get("/auth/google/callback", googleCallback);
router.get("/auth/google/signup", googleSignup);
router.get("/auth/google/signup/callback", googleSignupCallback);

let ultimoRanking = null;
let ultimaAtualizacao = 0;
let top3FixosHoje = null;
let diaTop3 = null;
let horaInicioRanking = null;
let zeroedAtMidnight = false;
let dailyFixedRanking = null;

const baselineValores = [10, 9, 8, 7, 6, 5.9, 5.8, 5.7, 5.6, 5.5];

// garante helper acessível mesmo em hot-reload / diferentes escopos
if (typeof globalThis.fetchTopFromDailyEarning !== "function") {
  globalThis.fetchTopFromDailyEarning = async function(limit = 10) {
    try {
      const ganhos = await DailyEarning.aggregate([
        { $group: { _id: "$userId", totalGanhos: { $sum: "$valor" } } },
        { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "usuario" } },
        { $unwind: { path: "$usuario", preserveNullAndEmptyArrays: true } },
        { $project: {
            userId: "$_id",
            username: { $ifNull: ["$usuario.nome", "Usuário"] },
            token: { $ifNull: ["$usuario.token", null] },
            real_total: "$totalGanhos"
        }},
        { $sort: { real_total: -1 } },
        { $limit: limit }
      ]);

      return ganhos.map(g => ({
        username: g.username || "Usuário",
        token: g.token || null,
        real_total: Number(g.real_total || 0),
        userId: g.userId ? String(g.userId) : null,
        source: "earnings"
      }));
    } catch (e) {
      console.error("Erro fetchTopFromDailyEarning:", e);
      return [];
    }
  };
}
const fetchTopFromDailyEarning = globalThis.fetchTopFromDailyEarning;

async function salvarAcaoComLimitePorUsuario(novaAcao) {
    const LIMITE = 10000;

    // Conta apenas ações válidas e inválidas
    const totalValidasOuInvalidas = await ActionHistory.countDocuments({
        user: novaAcao.user,
        status: { $in: ["valida", "invalida"] }
    });

    // Se excedeu o limite, remover somente as mais antigas
    if (totalValidasOuInvalidas >= LIMITE) {
        const excess = totalValidasOuInvalidas - LIMITE + 1;

        await ActionHistory.find({
            user: novaAcao.user,
            status: { $in: ["valida", "invalida"] }
        })
        .sort({ createdAt: 1 }) // remove as mais antigas
        .limit(excess)
        .deleteMany();
    }

    // Salva a nova ação (pendente, válida ou inválida)
    await novaAcao.save();
}

// 🔥 FUNÇÃO GLOBAL COM SUPORTE A VARIÁVEIS DE AMBIENTE
export function getValorAcao(pedidoOuTipo, rede = "TikTok") {

  // Se veio o pedido completo com valor explícito, usa ele
  if (pedidoOuTipo && typeof pedidoOuTipo === "object") {
    if (pedidoOuTipo.valor !== undefined && pedidoOuTipo.valor !== null) {
      return String(pedidoOuTipo.valor);
    }
  }

  // Tipo pode vir do pedido ou da string
  const tipo = typeof pedidoOuTipo === "object"
    ? String(pedidoOuTipo.tipo).toLowerCase()
    : String(pedidoOuTipo).toLowerCase();

  const redeNorm = String(rede).toLowerCase();

  // 🔍 Primeiro tenta ENV específico por rede e tipo (ex: VALOR_TIKTOK_CURTIR)
  const envKey = `VALOR_${redeNorm.toUpperCase()}_${tipo.toUpperCase()}`;
  const valorEnv = process.env[envKey];
  if (valorEnv) return String(valorEnv);

  // 🔍 Depois tenta ENV genérico
  if (tipo === "curtir" && process.env.VALOR_CURTIR) return String(process.env.VALOR_CURTIR);
  if (tipo === "seguir" && process.env.VALOR_SEGUIR) return String(process.env.VALOR_SEGUIR);

}

// helpers
export async function getUserDocByToken(token) {
  if (!token) return null;

  // garante conexão
  const conn = await mongoose.connection.asPromise?.() ?? mongoose.connection;
  const client = mongoose.connection.getClient();

  if (!client) {
    throw new Error("MongoDB client não inicializado");
  }

  const db = client.db(); // <-- SEMPRE existe
  const usersColl = db.collection("users");

  return await usersColl.findOne({ token });
}


async function reactivateConta(userId, nomeLower, updates) {
  const usersColl = mongoose.connection.db.collection("users");
  // arrayFilters para atualizar o elemento correto (case-insensitive comparações feitas no app)
  return await usersColl.updateOne(
    { _id: userId, "contas": { $elemMatch: { $or: [{ nome_usuario: { $exists: true } }, { nomeConta: { $exists: true } }] } } },
    { $set: updates },
    { arrayFilters: [ { "elem.nome_usuario": { $exists: true } } ] } // not used directly but kept for template
  );
}

async function pushConta(userId, conta) {
  const client = mongoose.connection.getClient();
  if (!client) {
    throw new Error("MongoDB client não inicializado");
  }

  const db = client.db();
  const usersColl = db.collection("users");

  return await usersColl.updateOne(
    { _id: userId },
    { $push: { contas: conta } }
  );
}

// get raw user doc (token or userId)
async function getUserDocRaw({ userId, token }) {
  const client = mongoose.connection.getClient();
  if (!client) throw new Error("MongoDB client não inicializado");
  const db = client.db();
  const usersColl = db.collection("users");

  if (userId) {
    // se veio do JWT
    const _id = mongoose.Types.ObjectId.isValid(userId) ? new mongoose.Types.ObjectId(userId) : userId;
    return await usersColl.findOne({ _id });
  }
  return await usersColl.findOne({ token });
}

// atomic create saque: push + dec saldo
async function createSaqueAtomic(userId, novoSaque, amount) {
  const client = mongoose.connection.getClient();
  const db = client.db();
  const usersColl = db.collection("users");

  const res = await usersColl.updateOne(
    { _id: userId },
    {
      $push: { saques: novoSaque },
      $inc: { saldo: -Number(amount) }
    }
  );
  return res;
}

// update saque by externalReference
async function updateSaqueByExternalRef(userId, externalReference, setObj) {
  const client = mongoose.connection.getClient();
  const db = client.db();
  const usersColl = db.collection("users");

  const res = await usersColl.updateOne(
    { _id: userId, "saques.externalReference": externalReference },
    { $set: Object.fromEntries(Object.entries(setObj).map(([k,v]) => [`saques.$.${k}`, v])) }
  );
  return res;
}

// rollback (restore saldo and mark failed)
async function markSaqueFailedAndRefund(userId, externalReference, refundAmount, errorInfo) {
  const client = mongoose.connection.getClient();
  const db = client.db();
  const usersColl = db.collection("users");

  await usersColl.updateOne(
    { _id: userId, "saques.externalReference": externalReference },
    {
      $set: { "saques.$.status": "FAILED", "saques.$.error": errorInfo || null },
      $inc: { saldo: Number(refundAmount) }
    }
  );
}

// 📌 ROTA PARA CONSULTAR VALORES DAS AÇÕES
router.get("/valor_acao", (req, res) => {
  const { tipo = "seguir", rede = "TikTok" } = req.query;

  const valor = getValorAcao(tipo, rede);

  return res.json({
    status: "success",
    tipo,
    rede,
    valor
  });
});

// Rota: /api/contas_tiktok (POST, GET, DELETE)
function getTokenFromHeader(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader) return null;
  return authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : authHeader;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

router.route("/contas_tiktok")

// POST -> adicionar / reativar conta TikTok (aceita nome_usuario ou nomeConta)
.post(async (req, res) => {
  try {
    await connectDB();

    const token = getTokenFromHeader(req);
    if (!token) return res.status(401).json({ error: "Acesso negado, token não encontrado." });

    // usa leitura RAW para evitar casting/validation
    const userDoc = await getUserDocByToken(token);
    if (!userDoc) return res.status(404).json({ error: "Usuário não encontrado ou token inválido." });

    const rawName = req.body?.nome_usuario ?? req.body?.nomeConta ?? req.body?.username;
    if (!rawName || String(rawName).trim() === "") {
      return res.status(400).json({ error: "Nome da conta é obrigatório." });
    }

    const nomeNormalized = String(rawName).trim();
    const nomeLower = nomeNormalized.toLowerCase();

    // garante que contas exista como array no objeto em memória (não altera DB)
    const contasLocal = Array.isArray(userDoc.contas) ? userDoc.contas : [];

    // procurar conta existente no próprio documento (case-insensitive)
    const contaExistenteIndex = contasLocal.findIndex(c =>
      String((c?.nome_usuario ?? c?.nomeConta ?? "")).toLowerCase() === nomeLower &&
      String((c?.rede ?? "")).toLowerCase() === "tiktok"
    );

    if (contaExistenteIndex !== -1) {
      const contaExistente = contasLocal[contaExistenteIndex];
      if (String((contaExistente.status ?? "")).toLowerCase() === "ativa") {
        return res.status(400).json({ error: "Esta conta já está ativa." });
      }

      // reativar via update atômico com filtro no array (usa $[elem] e arrayFilters)
      const usersColl = mongoose.connection.db.collection("users");
      const updateRes = await usersColl.updateOne(
        { _id: userDoc._id, "contas.nome_usuario": contaExistente.nome_usuario },
        {
          $set: {
            "contas.$.status": "ativa",
            "contas.$.rede": "TikTok",
            "contas.$.dataDesativacao": null,
            "contas.$.nome_usuario": nomeNormalized,
            "contas.$.nomeConta": nomeNormalized
          }
        }
      );

      return res.status(200).json({ message: "Conta reativada com sucesso!", nomeConta: nomeNormalized });
    }

    // Verifica se outro usuário já possui essa conta — usa consulta ao driver (raw) para evitar instanciar docs corrompidos
    const regex = new RegExp(`^${escapeRegExp(nomeNormalized)}$`, "i");
    const usersColl = mongoose.connection.db.collection("users");
    const contaDeOutro = await usersColl.findOne({
      _id: { $ne: userDoc._id },
      $or: [
        { "contas.nome_usuario": regex },
        { "contas.nomeConta": regex }
      ]
    });

    if (contaDeOutro) {
      return res.status(400).json({ error: "Já existe uma conta com este nome de usuário." });
    }

    // Adicionar nova conta com defaults explícitos (evita inserir undefined)
    const novoConta = {
      nome_usuario: nomeNormalized,
      nomeConta: nomeNormalized,
      rede: "TikTok",
      status: "ativa",
      dataCriacao: new Date()
    };

    await pushConta(userDoc._id, novoConta);

    return res.status(201).json({
      message: "Conta Instagram adicionada com sucesso!",
      nomeConta: nomeNormalized
    });

  } catch (err) {
    console.error("❌ Erro em POST /contas_instagram:", err);
    return res.status(500).json({ error: "Erro interno no servidor." });
  }
})

  // GET -> listar contas TikTok ativas do usuário
  .get(async (req, res) => {
    try {
      await connectDB();

      const token = getTokenFromHeader(req);
      if (!token) return res.status(401).json({ error: "Acesso negado, token não encontrado." });

      const user = await User.findOne({ token });
      if (!user) return res.status(404).json({ error: "Usuário não encontrado ou token inválido." });

      const contasInstagram = (user.contas || [])
        .filter(conta => {
          const rede = String(conta.rede ?? "").trim().toLowerCase();
          const status = String(conta.status ?? "").trim().toLowerCase();
          return rede === "tiktok" && status === "ativa";
        })
        .map(conta => {
          const contaObj = conta && typeof conta.toObject === "function"
            ? conta.toObject()
            : JSON.parse(JSON.stringify(conta));

          return {
            ...contaObj,
            usuario: {
              _id: user._id,
              nome: user.nome || ""
            }
          };
        });

      return res.status(200).json(contasInstagram);
    } catch (err) {
      console.error("❌ Erro em GET /contas_tiktok:", err);
      return res.status(500).json({ error: "Erro interno no servidor." });
    }
  })

// DELETE -> desativar conta TikTok (RAW-safe)
.delete(async (req, res) => {
  try {
    await connectDB();

    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ error: "Acesso negado, token não encontrado." });
    }

    const nomeRaw =
      req.query.nome_usuario ??
      req.query.nomeConta ??
      req.body?.nome_usuario ??
      req.body?.nomeConta;

    if (!nomeRaw || String(nomeRaw).trim() === "") {
      return res.status(400).json({ error: "Nome da conta não fornecido." });
    }

    const nomeNormalized = String(nomeRaw).trim();
    const nomeLower = nomeNormalized.toLowerCase();

    const usersColl = mongoose.connection.db.collection("users");

    const result = await usersColl.updateOne(
      { token },
      {
        $set: {
          "contas.$[c].status": "inativa",
          "contas.$[c].dataDesativacao": new Date()
        }
      },
      {
        arrayFilters: [
          {
            $and: [
              { "c.rede": { $regex: /^tiktok$/i } },
              {
                $or: [
                  { "c.nome_usuario": { $regex: `^${escapeRegExp(nomeLower)}$`, $options: "i" } },
                  { "c.nomeConta": { $regex: `^${escapeRegExp(nomeLower)}$`, $options: "i" } }
                ]
              }
            ]
          }
        ]
      }
    );

    if (result.matchedCount === 0 || result.modifiedCount === 0) {
      return res.status(404).json({ error: "Conta não encontrada ou já inativa." });
    }

    return res.status(200).json({
      message: `Conta ${nomeNormalized} desativada com sucesso.`
    });

  } catch (err) {
    console.error("❌ Erro em DELETE /contas_instagram:", err);
    return res.status(500).json({ error: "Erro interno no servidor." });
  }
});

// Rota: /api/contas_instagram (POST, GET, DELETE)
router.route("/contas_instagram")

// POST -> adicionar / reativar conta Instagram (versão segura)
.post(async (req, res) => {
  try {
    await connectDB();

    const token = getTokenFromHeader(req);
    if (!token) return res.status(401).json({ error: "Acesso negado, token não encontrado." });

    // usa leitura RAW para evitar casting/validation
    const userDoc = await getUserDocByToken(token);
    if (!userDoc) return res.status(404).json({ error: "Usuário não encontrado ou token inválido." });

    const rawName = req.body?.nome_usuario ?? req.body?.nomeConta ?? req.body?.username;
    if (!rawName || String(rawName).trim() === "") {
      return res.status(400).json({ error: "Nome da conta é obrigatório." });
    }

    const nomeNormalized = String(rawName).trim();
    const nomeLower = nomeNormalized.toLowerCase();

    // garante que contas exista como array no objeto em memória (não altera DB)
    const contasLocal = Array.isArray(userDoc.contas) ? userDoc.contas : [];

    // procurar conta existente no próprio documento (case-insensitive)
    const contaExistenteIndex = contasLocal.findIndex(c =>
      String((c?.nome_usuario ?? c?.nomeConta ?? "")).toLowerCase() === nomeLower &&
      String((c?.rede ?? "")).toLowerCase() === "instagram"
    );

    if (contaExistenteIndex !== -1) {
      const contaExistente = contasLocal[contaExistenteIndex];
      if (String((contaExistente.status ?? "")).toLowerCase() === "ativa") {
        return res.status(400).json({ error: "Esta conta já está ativa." });
      }

      // reativar via update atômico com filtro no array (usa $[elem] e arrayFilters)
      const usersColl = mongoose.connection.db.collection("users");
      const updateRes = await usersColl.updateOne(
        { _id: userDoc._id, "contas.nome_usuario": contaExistente.nome_usuario },
        {
          $set: {
            "contas.$.status": "ativa",
            "contas.$.rede": "Instagram",
            "contas.$.dataDesativacao": null,
            "contas.$.nome_usuario": nomeNormalized,
            "contas.$.nomeConta": nomeNormalized
          }
        }
      );

      return res.status(200).json({ message: "Conta reativada com sucesso!", nomeConta: nomeNormalized });
    }

    // Verifica se outro usuário já possui essa conta — usa consulta ao driver (raw) para evitar instanciar docs corrompidos
    const regex = new RegExp(`^${escapeRegExp(nomeNormalized)}$`, "i");
    const usersColl = mongoose.connection.db.collection("users");
    const contaDeOutro = await usersColl.findOne({
      _id: { $ne: userDoc._id },
      $or: [
        { "contas.nome_usuario": regex },
        { "contas.nomeConta": regex }
      ]
    });

    if (contaDeOutro) {
      return res.status(400).json({ error: "Já existe uma conta com este nome de usuário." });
    }

    // Adicionar nova conta com defaults explícitos (evita inserir undefined)
    const novoConta = {
      nome_usuario: nomeNormalized,
      nomeConta: nomeNormalized,
      rede: "Instagram",
      status: "ativa",
      dataCriacao: new Date()
    };

    await pushConta(userDoc._id, novoConta);

    return res.status(201).json({
      message: "Conta Instagram adicionada com sucesso!",
      nomeConta: nomeNormalized
    });

  } catch (err) {
    console.error("❌ Erro em POST /contas_instagram:", err);
    return res.status(500).json({ error: "Erro interno no servidor." });
  }
})

// GET -> listar contas Instagram ativas (RAW-safe)
.get(async (req, res) => {
  try {
    await connectDB();

    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ error: "Acesso negado, token não encontrado." });
    }

    const userDoc = await getUserDocByToken(token);
    if (!userDoc) {
      return res.status(404).json({ error: "Usuário não encontrado ou token inválido." });
    }

    const contasInstagram = (Array.isArray(userDoc.contas) ? userDoc.contas : [])
      .filter(c =>
        String(c?.rede ?? "").toLowerCase() === "instagram" &&
        String(c?.status ?? "").toLowerCase() === "ativa"
      )
      .map(c => ({
        ...c,
        usuario: {
          _id: userDoc._id,
          nome: userDoc.nome || ""
        }
      }));

    return res.status(200).json(contasInstagram);

  } catch (err) {
    console.error("❌ Erro em GET /contas_instagram:", err);
    return res.status(500).json({ error: "Erro interno no servidor." });
  }
})

// DELETE -> desativar conta Instagram (RAW-safe)
.delete(async (req, res) => {
  try {
    await connectDB();

    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ error: "Acesso negado, token não encontrado." });
    }

    const nomeRaw =
      req.query.nome_usuario ??
      req.query.nomeConta ??
      req.body?.nome_usuario ??
      req.body?.nomeConta;

    if (!nomeRaw || String(nomeRaw).trim() === "") {
      return res.status(400).json({ error: "Nome da conta não fornecido." });
    }

    const nomeNormalized = String(nomeRaw).trim();
    const nomeLower = nomeNormalized.toLowerCase();

    const usersColl = mongoose.connection.db.collection("users");

    const result = await usersColl.updateOne(
      { token },
      {
        $set: {
          "contas.$[c].status": "inativa",
          "contas.$[c].dataDesativacao": new Date()
        }
      },
      {
        arrayFilters: [
          {
            $and: [
              { "c.rede": { $regex: /^instagram$/i } },
              {
                $or: [
                  { "c.nome_usuario": { $regex: `^${escapeRegExp(nomeLower)}$`, $options: "i" } },
                  { "c.nomeConta": { $regex: `^${escapeRegExp(nomeLower)}$`, $options: "i" } }
                ]
              }
            ]
          }
        ]
      }
    );

    if (result.matchedCount === 0 || result.modifiedCount === 0) {
      return res.status(404).json({ error: "Conta não encontrada ou já inativa." });
    }

    return res.status(200).json({
      message: `Conta ${nomeNormalized} desativada com sucesso.`
    });

  } catch (err) {
    console.error("❌ Erro em DELETE /contas_instagram:", err);
    return res.status(500).json({ error: "Erro interno no servidor." });
  }
});

// ROTA: /api/profile
router.get("/profile", async (req, res) => {
  await connectDB();

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Não autorizado." });
  }

  const token = authHeader.split(" ")[1].trim();
  console.log("🔐 Token recebido:", token);

  try {
    const usuario = await User.findOne({ token });
    if (!usuario) {
      return res.status(404).json({ error: "Usuário não encontrado." });
    }

    return res.status(200).json({
      nome_usuario: usuario.nome,
      email: usuario.email,
      token: usuario.token
    });

  } catch (error) {
    console.error("💥 Erro no GET /profile:", error);
    return res.status(500).json({ error: "Erro ao processar perfil." });
  }
});

// Rota: /api/profile (GET ou PUT)
router.put("/profile", async (req, res) => {
  await connectDB();

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Não autorizado." });
  }

  const token = authHeader.split(" ")[1].trim();
  console.log("🔐 Token recebido:", token);

  try {
    const usuario = await User.findOne({ token });
    if (!usuario) {
      return res.status(404).json({ error: "Usuário não encontrado." });
    }

const { nome_usuario, email, senha } = req.body;

const updateFields = {};

if (nome_usuario !== undefined) {
  updateFields.nome = nome_usuario;
}

if (email !== undefined) {
  updateFields.email = email;
}

if (senha !== undefined) {
  updateFields.senha = senha; 
}

    const usuarioAtualizado = await User.findOneAndUpdate(
      { token },
      updateFields,
      { new: true }
    );

    if (!usuarioAtualizado) {
      return res.status(404).json({ error: "Usuário não encontrado." });
    }

    return res.status(200).json({
      message: "Perfil atualizado com sucesso!",
      nome_usuario: usuarioAtualizado.nome,
      email: usuarioAtualizado.email
    });

  } catch (error) {
    console.error("💥 Erro no PUT /profile:", error);
    return res.status(500).json({ error: "Erro ao atualizar perfil." });
  }
});

// Rota: /api/login
router.post("/login", async (req, res) => {
        if (req.method !== "POST") {
            return res.status(405).json({ error: "Método não permitido" });
        }
    
        try {
            await connectDB();
    
const { email, senha } = req.body;

console.log("📥 BODY RECEBIDO:", req.body);
console.log("📧 email:", email);
console.log("🔑 senha:", senha);

    
            if (!email || !senha) {
                return res.status(400).json({ error: "E-mail e senha são obrigatórios!" });
            }
    
            console.log("🔍 Buscando usuário no banco de dados...");
            const usuario = await User.findOne({ email });
    
            if (!usuario) {
                console.log("🔴 Usuário não encontrado!");
                return res.status(400).json({ error: "Usuário não encontrado!" });
            }
    
            if (senha !== usuario.senha) {
                console.log("🔴 Senha incorreta!");
                return res.status(400).json({ error: "Senha incorreta!" });
            }
    
            let token = usuario.token;
            if (!token) {
                token = jwt.sign({ id: usuario._id }, process.env.JWT_SECRET);
                usuario.token = token;
                await usuario.save({ validateBeforeSave: false });
  
                console.log("🟢 Novo token gerado e salvo.");
            } else {
                console.log("🟢 Token já existente mantido.");
            }
    
            console.log("🔹 Token gerado para usuário:", token);
            return res.json({ message: "Login bem-sucedido!", token });
    
        } catch (error) {
            console.error("❌ Erro ao realizar login:", error);
            return res.status(500).json({ error: "Erro ao realizar login" });
  }
});

// rota api/signup
router.post("/signup", async (req, res) => {
  await connectDB();

  const { email, senha, ref } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ error: "Todos os campos são obrigatórios." });
  }

  try {
    // 🔥 NOVO: Bloqueia se já existir qualquer usuário no banco
    const totalUsuarios = await User.countDocuments();
    if (totalUsuarios >= 1) {
      return res.status(403).json({
        error: "Erro."
      });
    }

    // Verifica se email já existe (não é necessário, pois só 1 usuário pode existir,
    // mas deixei por segurança)
    const emailExiste = await User.findOne({ email });
    if (emailExiste) return res.status(400).json({ error: "E-mail já cadastrado." });

    // Gera token
    const token = crypto.randomBytes(32).toString("hex");

    // Gera código de afiliado
    const gerarCodigo = () =>
      Math.floor(10000000 + Math.random() * 90000000).toString();

    const maxRetries = 5;
    let attempt = 0;
    let savedUser = null;

    while (attempt < maxRetries && !savedUser) {
      const codigo_afiliado = gerarCodigo();

      const ativo_ate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      const novoUsuario = new User({
        email,
        senha,
        token,
        codigo_afiliado,
        status: "ativo",
        ativo_ate,
        indicado_por: ref || null,
      });

      try {
        savedUser = await novoUsuario.save();
      } catch (err) {
        if (err?.code === 11000 && err.keyPattern?.codigo_afiliado) {
          console.warn(`[SIGNUP] Colisão codigo_afiliado (tentativa ${attempt + 1}). Gerando novo código.`);
          attempt++;
          continue;
        }
        throw err;
      }
    }

    if (!savedUser) {
      return res.status(500).json({
        error: "Não foi possível gerar um código de afiliado único. Tente novamente."
      });
    }

    return res.status(201).json({
      message: "Usuário registrado com sucesso!",
      token: savedUser.token,
      codigo_afiliado: savedUser.codigo_afiliado,
      id: savedUser._id,
    });

  } catch (error) {
    console.error("Erro ao cadastrar usuário:", error);
    return res.status(500).json({ error: "Erro interno ao registrar usuário. Tente novamente mais tarde." });
  }
});

// Rota: /api/change-password
router.post("/change-password", async (req, res) => {
        if (req.method !== "POST") {
            return res.status(405).json({ error: "Método não permitido" });
        }
    
        try {
            await connectDB();
            console.log("Conectado ao MongoDB via Mongoose");
    
            const authHeader = req.headers.authorization || "";
            console.log("📩 Cabeçalho Authorization recebido:", authHeader);
    
            const token = authHeader.replace("Bearer ", "").trim();
            console.log("🔐 Token extraído:", token);
    
            if (!token) {
                return res.status(401).json({ error: "Token ausente" });
            }
    
            // Buscar o usuário com o token
            const usuario = await User.findOne({ resetPasswordToken: token });
    
            if (!usuario) {
                console.log("❌ Token inválido ou usuário não encontrado!");
                return res.status(401).json({ error: "Token inválido" });
            }
    
            // (Opcional) Validar se o token expirou
            const expiracao = usuario.resetPasswordExpires ? new Date(usuario.resetPasswordExpires) : null;
            if (expiracao && expiracao < new Date()) {
                console.log("❌ Token expirado!");
                return res.status(401).json({ error: "Token expirado" });
            }
    
            const { novaSenha } = req.body;
    
            if (!novaSenha) {
                return res.status(400).json({ error: "Nova senha é obrigatória" });
            }
    
            // Alterar a senha
            usuario.senha = novaSenha;
    
            // Limpar o token após a redefinição da senha
    usuario.resetPasswordToken = null;
    usuario.resetPasswordExpires = null;
    
            await usuario.save();
    
            console.log("✅ Senha alterada com sucesso para o usuário:", usuario.email);
            return res.json({ message: "Senha alterada com sucesso!" });
    
        } catch (error) {
            console.error("❌ Erro ao alterar senha:", error);
            return res.status(500).json({ error: "Erro ao alterar senha" });
  }
});

// Rota: /api/recover-password
router.post("/recover-password", async (req, res) => {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Método não permitido" });

  const { email } = req.body;
  if (!email)
    return res.status(400).json({ error: "Email é obrigatório" });

  try {
    await connectDB(); // só garante a conexão
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user)
      return res.status(404).json({ error: "Email não encontrado" });

    const token = crypto.randomBytes(32).toString("hex");
    
    const expires = Date.now() + 30 * 60 * 1000; // 30 minutos em milissegundos

    // Salva no documento Mongoose
    user.resetPasswordToken = token;
    user.resetPasswordExpires = new Date(expires);
    await user.save();

    const link = `https://ganhesocialtest.com/reset-password?token=${token}`;
    await sendRecoveryEmail(email, link);

    return res.status(200).json({ message: "Link enviado com sucesso" });
  } catch (err) {
    console.error("Erro em recover-password:", err);
    return res.status(500).json({ error: "Erro interno no servidor" });
  }
});

// Rota: api/validate-reset-token
router.get("/validate-reset-token", async (req, res) => {
        if (req.method !== "GET") {
            return res.status(405).json({ error: "Método não permitido" });
        }
    
        try {
            await connectDB();
            const token = req.query.token;
    
            if (!token) {
                return res.status(400).json({ error: "Token ausente" });
            }
    
            const usuario = await User.findOne({ resetPasswordToken: token });
    
            if (!usuario) {
                return res.status(401).json({ error: "Link inválido ou expirado" });
            }
    
            // Obtenha a data de expiração de forma consistente
            const expiracao = usuario.resetPasswordExpires;
    
            if (!expiracao) {
                return res.status(401).json({ error: "Data de expiração não encontrada" });
            }
    
            // Log para ver a data de expiração
            console.log("Data de expiração do token:", expiracao);
    
            // Data atual em UTC
            const agora = new Date().toISOString();
    
            // Log para ver a data atual
            console.log("Data atual (agora):", agora);
    
            // Converter para milissegundos desde 1970
            const expiracaoMs = new Date(expiracao).getTime();
            const agoraMs = new Date(agora).getTime();
    
            // Log para ver as datas em milissegundos
            console.log("Expiração em milissegundos:", expiracaoMs);
            console.log("Agora em milissegundos:", agoraMs);
    
            // Se a data atual for maior que a data de expiração, o token expirou
            if (agoraMs > expiracaoMs) {
                console.log("Token expirado.");
                return res.status(401).json({ error: "Link inválido ou expirado" });
            }
    
            // Se o token ainda estiver dentro do prazo de validade
            return res.json({ valid: true });
    
        } catch (error) {
            return res.status(500).json({ error: "Erro ao validar token" });
  }
});

// ROTA: /withdraw (substitua todo o handler antigo por este)
router.all("/withdraw", async (req, res) => {
  try {
    const method = req.method;
    if (method !== "GET" && method !== "POST") {
      return res.status(405).json({ error: "Método não permitido." });
    }

    await connectDB();

    // ---------- autenticação (Bearer JWT ou token cru) ----------
    const authHeader = (req.headers.authorization || "").toString();
    let token = null;
    if (authHeader.startsWith("Bearer ")) {
      token = authHeader.split(" ")[1].trim();
    } else if (authHeader.length > 0) {
      token = authHeader.trim();
    }

    if (!token) return res.status(401).json({ error: "Token ausente ou inválido." });

    // tenta JWT primeiro, extrai userId se possível
    let userIdFromJwt = null;
    if (process.env.JWT_SECRET) {
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        userIdFromJwt = payload?.id || payload?.sub || null;
      } catch (e) {
        // não é JWT — será tratado como token cru
      }
    }

    // ---------- helpers raw DB (usa mongoose.client) ----------
    function getClientDb() {
      const client = mongoose.connection.getClient();
      if (!client) throw new Error("MongoDB client não inicializado (mongoose.connection.getClient())");
      return client.db();
    }

    async function getUserDocRaw({ userId, token }) {
      const db = getClientDb();
      const usersColl = db.collection("users");
      if (userId) {
        const _id = mongoose.Types.ObjectId.isValid(userId) ? new mongoose.Types.ObjectId(userId) : userId;
        return await usersColl.findOne({ _id });
      }
      return await usersColl.findOne({ token });
    }

    async function createSaqueAtomic(userId, novoSaque, amount) {
      const db = getClientDb();
      const usersColl = db.collection("users");
      const res = await usersColl.updateOne(
        { _id: userId },
        {
          $push: { saques: novoSaque },
          $inc: { saldo: -Number(amount) }
        }
      );
      return res;
    }

    async function updateSaqueByExternalRef(userId, externalReference, setObj) {
      const db = getClientDb();
      const usersColl = db.collection("users");
      // transforma setObj para campos dentro do array
      const setFields = {};
      Object.entries(setObj).forEach(([k, v]) => {
        setFields[`saques.$.${k}`] = v;
      });
      const res = await usersColl.updateOne(
        { _id: userId, "saques.externalReference": externalReference },
        { $set: setFields }
      );
      return res;
    }

    async function markSaqueFailedAndRefund(userId, externalReference, refundAmount, errorInfo) {
      const db = getClientDb();
      const usersColl = db.collection("users");
      await usersColl.updateOne(
        { _id: userId, "saques.externalReference": externalReference },
        {
          $set: { "saques.$.status": "FAILED", "saques.$.error": errorInfo || null },
          $inc: { saldo: Number(refundAmount) }
        }
      );
    }

    // ---------- obter userDoc (raw) ----------
    const userDoc = await getUserDocRaw({ userId: userIdFromJwt, token });
    if (!userDoc) {
      return res.status(401).json({ error: "Usuário não autenticado." });
    }

    // ---------- GET: retornar histórico de saques ----------
    if (method === "GET") {
      const saquesFormatados = (Array.isArray(userDoc.saques) ? userDoc.saques : []).map(s => ({
        amount: s.valor ?? s.amount ?? null,
        pixKey: s.chave_pix ?? s.pixKey ?? null,
        keyType: s.tipo_chave ?? s.keyType ?? null,
        status: s.status ?? null,
        date: s.data ? (s.data instanceof Date ? s.data.toISOString() : new Date(s.data).toISOString()) : null,
        externalReference: s.externalReference || null,
        providerId: s.providerId || s.wooviId || s.openpixId || null,
      }));
      return res.status(200).json(saquesFormatados);
    }

    // ---------- POST: criar saque (fluxo create -> approve) ----------
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (e) { /* keep as-is */ }
    }
    const { amount, payment_method, payment_data } = body || {};

    if (amount == null || (typeof amount !== "number" && typeof amount !== "string")) {
      return res.status(400).json({ error: "Valor de saque inválido (mínimo R$0,01)." });
    }
    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: "Valor de saque inválido." });
    }

    // simple payment_data checks
    if (!payment_method || !payment_data?.pix_key || !payment_data?.pix_key_type) {
      return res.status(400).json({ error: "Dados de pagamento incompletos." });
    }

    if ((userDoc.saldo ?? 0) < amountNum) {
      return res.status(400).json({ error: "Saldo insuficiente." });
    }

    // ---------- normalização da chave PIX (seu código adaptado) ----------
    const rawType = String((payment_data.pix_key_type || "")).trim().toLowerCase();
    const typeMap = {
      "cpf": "CPF","cnpj":"CNPJ",
      "phone":"PHONE","telefone":"PHONE","celular":"PHONE","mobile":"PHONE",
      "email":"EMAIL","e-mail":"EMAIL","mail":"EMAIL",
      "random":"RANDOM","aleatoria":"RANDOM","aleatória":"RANDOM","uuid":"RANDOM","evp":"RANDOM"
    };
    let keyTypeNormalized = typeMap[rawType] || null;
    let pixRaw = String(payment_data.pix_key || "").trim();

    if (!keyTypeNormalized) {
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pixRaw)) keyTypeNormalized = "EMAIL";
      else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pixRaw)) keyTypeNormalized = "RANDOM";
      else keyTypeNormalized = "PHONE";
    }

    if (!pixRaw) return res.status(400).json({ error: "Chave PIX inválida (vazia)." });

    let pixKey = pixRaw;
    if (keyTypeNormalized === "EMAIL") {
      pixKey = pixRaw.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pixKey)) return res.status(400).json({ error: "E-mail inválido para chave PIX." });
    }

    const providerTypeMap = { "CPF":"CPF","CNPJ":"CNPJ","PHONE":"PHONE","EMAIL":"EMAIL","RANDOM":"RANDOM" };
    const providerKeyType = providerTypeMap[keyTypeNormalized] || keyTypeNormalized;

    console.log("[DEBUG] withdraw - pixKey final:", pixKey, "tipo:", keyTypeNormalized, "providerType:", providerKeyType);

    const externalReference = `saque_${userDoc._id}_${Date.now()}`;

    const novoSaque = {
      valor: amountNum,
      chave_pix: pixKey,
      tipo_chave: keyTypeNormalized,
      status: "PENDING",
      data: new Date(),
      providerId: null,
      externalReference,
      ownerName: userDoc.nome || userDoc.name || "Usuário",
    };

    // ---------- criação atômica do saque (push + decrement saldo) ----------
    const createRes = await createSaqueAtomic(userDoc._id, novoSaque, amountNum);
    if (!createRes.acknowledged || createRes.matchedCount === 0) {
      return res.status(500).json({ error: "Erro ao registrar saque." });
    }

    // ---------- preparar aliasForType e ordem de tentativa ----------
    const explicitTypeProvided = Boolean(payment_data.pix_key_type && String(payment_data.pix_key_type).trim());
    const onlyDigits = (pixKey || "").replace(/\D/g, "");
    const cpfDigits = onlyDigits.length >= 11 ? onlyDigits.slice(-11) : onlyDigits;
    const cnpjDigits = onlyDigits.length >= 14 ? onlyDigits.slice(-14) : onlyDigits;

    const aliasForType = {
      "CPF": cpfDigits || pixKey,
      "CNPJ": cnpjDigits || pixKey,
      "EMAIL": (pixKey || "").toLowerCase(),
      "RANDOM": pixKey,
      "PHONE": (() => {
        let phone = (pixKey || "").replace(/\D/g, "");
        if (!phone) return phone;
        phone = phone.replace(/^0+/, "");
        if (!/^55/.test(phone)) phone = `55${phone}`;
        return phone;
      })()
    };

    const prioritizedTypes = (() => {
      const initial = providerKeyType || keyTypeNormalized || "RANDOM";
      const tries = [initial];
      if (!explicitTypeProvided && initial === "CPF") tries.unshift("PHONE");
      const possible = ["PHONE","CPF","CNPJ","EMAIL","RANDOM"];
      possible.forEach(t => { if (!tries.includes(t)) tries.push(t); });
      return tries;
    })();

    // ---------- função de tentativa de createPayment ----------
    const OPENPIX_API_KEY = process.env.OPENPIX_API_KEY;
    const OPENPIX_API_URL = process.env.OPENPIX_API_URL || "https://api.openpix.com.br";
    if (!OPENPIX_API_KEY) {
      // rollback: marcar failed + restaurar saldo
      await markSaqueFailedAndRefund(userDoc._id, externalReference, amountNum, { msg: "OPENPIX_API_KEY não configurada" });
      return res.status(500).json({ error: "Configuração do provedor ausente." });
    }

    async function createPaymentAttempt(key, aliasType, idempSuffix) {
      const hdrs = {
        "Content-Type": "application/json",
        "Authorization": OPENPIX_API_KEY,
        "Idempotency-Key": `${externalReference}_${String(idempSuffix || aliasType)}`
      };
      const payload = {
        value: Math.round(amountNum * 100),
        destinationAlias: key,
        destinationAliasType: aliasType,
        correlationID: externalReference,
        comment: `Saque para ${userDoc._id}`
      };
      console.log("[DEBUG] createPaymentAttempt payload:", payload, "Idempotency-Key:", hdrs["Idempotency-Key"]);
      let response;
      try {
        response = await fetch(`${OPENPIX_API_URL}/api/v1/payment`, {
          method: "POST",
          headers: hdrs,
          body: JSON.stringify(payload)
        });
      } catch (err) {
        return { ok: false, error: err, text: null, data: null, http: null };
      }
      const text = await response.text();
      let data = null;
      try { data = JSON.parse(text); } catch (e) { data = null; }
      return { ok: response.ok, http: response, text, data, error: null };
    }

    // ---------- loop de tentativas createPayment ----------
    let createResult = null;
    let lastCreateData = null;

    for (let i = 0; i < prioritizedTypes.length; i++) {
      const tryType = prioritizedTypes[i];
      const attempt = await createPaymentAttempt(aliasForType[tryType] || pixKey, tryType, tryType);
      lastCreateData = attempt.data ?? { raw: attempt.text ?? null, error: attempt.error?.message ?? null };

      if (attempt.ok) {
        createResult = { success: true, data: attempt.data, http: attempt.http, usedType: tryType };
        break;
      } else {
        const msg = JSON.stringify(attempt.data || attempt.text || "");
        const indicatesInvalidType = /chave\s*pix.*inv[aá]lida.*tipo/i.test(msg) || /invalid.*for.*type/i.test(msg);
        console.log("[DEBUG] createPayment attempt failed:", { tryType, indicatesInvalidType, data: attempt.data, text: attempt.text });
        if (!indicatesInvalidType) {
          createResult = { success: false, data: attempt.data, http: attempt.http, error: attempt.error || attempt.text || "Erro ao criar pagamento" };
          break;
        }
      }
    }

    if (!createResult) {
      // todas tentativas falharam
      await markSaqueFailedAndRefund(userDoc._id, externalReference, amountNum, { msg: "Todas as tentativas de createPayment falharam", last: lastCreateData });
      return res.status(400).json({ error: lastCreateData?.error || "Erro ao criar pagamento no provedor." });
    }
    if (!createResult.success) {
      await markSaqueFailedAndRefund(userDoc._id, externalReference, amountNum, createResult.data || createResult.error);
      return res.status(400).json({ error: (createResult.data && (createResult.data.message || createResult.data.error)) || createResult.error || "Erro ao criar pagamento no provedor." });
    }

    // create ok
    const createData = createResult.data;
    const paymentId = createData.id || createData.paymentId || createData.payment_id || createData.transaction?.id || null;

    // atualiza saque com providerId (se retornou) — raw
    try {
      await updateSaqueByExternalRef(userDoc._id, externalReference, { providerId: paymentId, status: "PENDING" });
    } catch (err) {
      console.error("[WARN] não foi possível atualizar saque com providerId:", err);
    }

    // ---------- approve (se aplicável) ----------
    // extrair identificadores do createData
    const returnedCorrelation = createData.correlationID || createData.correlationId || createData.correlation || null;
    const toApproveIdentifier = paymentId || returnedCorrelation || externalReference;
    let approveStatus = null;
    let approveData = null;

    if (toApproveIdentifier) {
      const approveHeaders = {
        "Content-Type": "application/json",
        "Authorization": OPENPIX_API_KEY,
        "Idempotency-Key": `approve_${toApproveIdentifier}`
      };
      const approvePayload = paymentId ? { paymentId } : { correlationID: toApproveIdentifier };

      try {
        const approveRes = await fetch(`${OPENPIX_API_URL}/api/v1/payment/approve`, {
          method: "POST",
          headers: approveHeaders,
          body: JSON.stringify(approvePayload)
        });
        const approveText = await approveRes.text();
        try { approveData = JSON.parse(approveText); } catch (e) { approveData = null; }

        if (!approveRes.ok) {
          const bodyMsg = JSON.stringify(approveData || approveText || "");
          const notFoundKey = /chave\s*pix.*n[aã]o encontrada/i.test(bodyMsg) || /not.*found.*pix/i.test(bodyMsg) || /chave.*nao.*encontrada/i.test(bodyMsg);
          if (notFoundKey) {
            await markSaqueFailedAndRefund(userDoc._id, externalReference, amountNum, approveData || { raw: approveText });
            return res.status(400).json({ error: approveData?.error || approveData?.message || "Chave Pix não encontrada (provedor)." });
          } else {
            // marca pending approval e retorna erro
            await updateSaqueByExternalRef(userDoc._id, externalReference, { status: "PENDING_APPROVAL", error: approveData || { raw: approveText } });
            return res.status(400).json({ error: approveData?.error || approveData?.message || "Erro ao aprovar pagamento (pendente)." });
          }
        }

        // approve ok
        const realApproveData = approveData ?? (approveText ? JSON.parse(approveText) : null);
        approveStatus = realApproveData?.status || realApproveData?.transaction?.status || "COMPLETED";
        const finalStatus = (approveStatus === "COMPLETED" || approveStatus === "EXECUTED") ? "COMPLETED" : approveStatus;
        await updateSaqueByExternalRef(userDoc._id, externalReference, { status: finalStatus, providerId: paymentId || (realApproveData?.id || null) });

      } catch (err) {
        console.error("[ERROR] Falha approvePayment:", err);
        // marca PENDING_APPROVAL e retorna erro
        await updateSaqueByExternalRef(userDoc._id, externalReference, { status: "PENDING_APPROVAL", error: { msg: "Falha na requisição de aprovação", detail: err.message } });
        return res.status(500).json({ error: "Erro ao aprovar pagamento (comunicação com provedor)." });
      }
    } else {
      // sem identifier usável -> deixa PENDING
      await updateSaqueByExternalRef(userDoc._id, externalReference, { status: "PENDING" });
    }

    // ---------- processamento de comissão (raw-safe) ----------
    try {
      const COMMISSION_RATE = 0.05;
      const wasCompleted = (approveStatus === "COMPLETED" || approveStatus === "EXECUTED");
      if (wasCompleted && userDoc.indicado_por) {
        // busca afiliado via Mongoose ou raw
        const db = getClientDb();
        const usersColl = db.collection("users");
        const afiliadoDoc = await usersColl.findOne({ codigo_afiliado: userDoc.indicado_por });
        if (afiliadoDoc) {
          const comissaoValor = Number((amountNum * COMMISSION_RATE).toFixed(2));
          // cria ActionHistory via Mongoose (ok)
          const acaoComissao = new ActionHistory({
            user: afiliadoDoc._id,
            token: afiliadoDoc.token || null,
            nome_usuario: afiliadoDoc.nome || afiliadoDoc.email || null,
            id_action: externalReference,
            id_pedido: `comissao_${externalReference}`,
            id_conta: userDoc._id.toString(),
            acao_validada: "valida",
            valor_confirmacao: comissaoValor,
            quantidade_pontos: 0,
            tipo_acao: "comissao",
            rede_social: "Sistema",
            tipo: "comissao",
            afiliado: afiliadoDoc.codigo_afiliado,
            valor: comissaoValor,
            data: new Date()
          });
          await acaoComissao.save();

          // atualiza afiliado raw: inc saldo + push historico_acoes
          await usersColl.updateOne(
            { _id: afiliadoDoc._id },
            { $inc: { saldo: comissaoValor }, $push: { historico_acoes: acaoComissao._id } }
          );
        }
      }
    } catch (errCom) {
      console.error("[ERROR] Falha ao processar comissão de afiliado (raw-safe):", errCom);
    }

    // ---------- resposta final ----------
    return res.status(200).json({
      message: "Saque processado (create -> approve flow concluído ou pendente).",
      create: createData,
      approve: approveData || null
    });

  } catch (error) {
    console.error("💥 Erro em /withdraw:", error);
    return res.status(500).json({ error: "Erro ao processar saque." });
  }
});

// ROTA: /api/get_saldo (GET)
router.get("/get_saldo", async (req, res) => {
  try {
    await connectDB();

    // DEBUG: mostra o que chega (remova/ajuste em produção)
    console.log("[DEBUG] get_saldo headers.authorization:", req.headers.authorization, "query.token:", req.query.token);

    // 1) pegar token: primeiro query, depois Authorization: Bearer <token>
    let token = req.query?.token || null;
    const authHeader = (req.headers.authorization || "").toString();
    if (!token && authHeader.startsWith("Bearer ")) {
      token = authHeader.split(" ")[1].trim();
    }

    if (!token) {
      return res.status(400).json({ error: "Token obrigatório." });
    }

    // 2) tenta interpretar token como JWT (melhor fluxo) — se falhar, fallback para buscar por token no DB
    let usuario = null;

    if (process.env.JWT_SECRET) {
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        const userId = payload?.id || payload?.sub;
        if (userId) {
          // incluir saques para podermos retornar last_saque
          usuario = await User.findById(userId)
            .select("saldo pix_key pix_key_type _id ativo_ate indicado_por nome email saques")
            .lean();
        }
      } catch (errJwt) {
        // não é JWT válido; segue para fallback (não tratar como erro aqui)
        console.log("[DEBUG] token não é JWT válido / jwt.verify falhou:", errJwt.message);
      }
    }

    // fallback: buscar por campo token (compatibilidade com implementação anterior)
    if (!usuario) {
      usuario = await User.findOne({ token })
        .select("saldo pix_key pix_key_type _id ativo_ate indicado_por nome email saques")
        .lean();
    }

    if (!usuario) {
      return res.status(403).json({ error: "Acesso negado." });
    }

    // Busca ações pendentes (não validadas)
    const pendentes = await ActionHistory.find({
      user: usuario._id,
      acao_validada: "pendente"
    }).select("valor_confirmacao").lean();

    const saldo_pendente = (pendentes || []).reduce(
      (soma, acao) => soma + (acao.valor_confirmacao || 0),
      0
    );

    // Helper: normaliza tipo e chave
    function normalizePixPair(rawKey, rawType) {
      if (!rawKey && !rawType) return { key: null, type: null };

      let key = rawKey ?? null;
      let type = rawType ?? null;
      if (type) type = String(type).toLowerCase();

      // normaliza tipo textual
      if (type === "c" || type === "cpf_cnpj") type = "cpf"; // casos estranhos
      if (type === "telefone" || type === "celular") type = "phone";

      if (key && typeof key === "string") key = key.trim();

      // aplica limpeza por tipo
      try {
        if (type === "cpf") {
          key = String(key).replace(/\D/g, "");
        } else if (type === "cnpj") {
          key = String(key).replace(/\D/g, "");
        } else if (type === "phone") {
          key = String(key).replace(/\D/g, "");
        } else if (type === "email") {
          key = String(key).toLowerCase();
        }
      } catch (e) {
        // ignore, retornar raw
      }

      return { key: key || null, type: type || null };
    }

    // Normaliza usuário.pix_key
    const userPix = normalizePixPair(usuario.pix_key ?? null, usuario.pix_key_type ?? null);

    // Determina last_saque (mais recente) a partir do array usuario.saques
    let lastSaque = null;
    if (Array.isArray(usuario.saques) && usuario.saques.length > 0) {
      // safe sort: por data -> new Date(...)
      const copy = usuario.saques.slice();
      copy.sort((a, b) => {
        const da = a?.data ? new Date(a.data) : (a?.createdAt ? new Date(a.createdAt) : new Date(0));
        const db = b?.data ? new Date(b.data) : (b?.createdAt ? new Date(b.createdAt) : new Date(0));
        return db - da;
      });
      const rawLast = copy[0];
      if (rawLast) {
        lastSaque = {
          chave_pix: rawLast.chave_pix ?? rawLast.pix_key ?? rawLast.destination ?? null,
          tipo_chave: rawLast.tipo_chave ?? rawLast.pix_key_type ?? rawLast.tipo ?? null,
          valor: rawLast.valor ?? rawLast.amount ?? null,
          data: rawLast.data ? new Date(rawLast.data).toISOString() : (rawLast.createdAt ? new Date(rawLast.createdAt).toISOString() : null)
        };
      }
    }

    // Normaliza last_saque pix info (se existir)
    let lastSaquePix = { key: null, type: null };
    if (lastSaque && lastSaque.chave_pix) {
      lastSaquePix = normalizePixPair(lastSaque.chave_pix, lastSaque.tipo_chave);
    }

    // Escolhe a chave efetiva que o frontend pode preferir:
    // prioriza last_saque quando existir; caso contrário usa user.pix_key
    const pixKeyEffective = lastSaquePix.key ?? userPix.key ?? null;
    const pixKeyEffectiveType = lastSaquePix.type ?? userPix.type ?? null;

    // DEBUG: log resumido
    console.log("[DEBUG] get_saldo - userPix:", userPix, "lastSaquePix:", lastSaquePix, "effective:", { pixKeyEffective, pixKeyEffectiveType });

    return res.status(200).json({
      saldo_disponivel: typeof usuario.saldo === "number" ? usuario.saldo : 0,
      saldo_pendente,
      // mantém os valores do usuário (não sobrescreve DB)
      pix_key: userPix.key,
      pix_key_type: userPix.type,
      // fornece a última operação para UI preferir quando desejar
      last_saque: lastSaque,
      // chave efetiva (conveniência para front) — prefira usar esse campo no frontend
      pix_key_effective: pixKeyEffective,
      pix_key_effective_type: pixKeyEffectiveType
    });
  } catch (error) {
    console.error("💥 Erro ao obter saldo:", error);
    return res.status(500).json({ error: "Erro ao buscar saldo." });
  }
});

// Rota: /api/historico_acoes (GET)
router.get("/historico_acoes", async (req, res) => {
if (req.method !== "GET") {
    return res.status(405).json({ error: "Método não permitido." });
  }

  await connectDB();

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token não fornecido ou inválido." });
  }

  const token = authHeader.split(" ")[1];
  const usuario = await User.findOne({ token });

  if (!usuario) {
    return res.status(401).json({ error: "Usuário não autenticado." });
  }

  const nomeUsuarioParam = req.query.usuario;

  if (nomeUsuarioParam) {
    // Busca diretamente pelo nome de usuário, ignorando o token
    const historico = await ActionHistory
      .find({ nome_usuario: nomeUsuarioParam, status: { $ne: "pulada" } })
      .sort({ data: -1 });
  
    const formattedData = historico.map(action => {
      let status;
      if (action.status === "valida") status = "Válida";
      else if (action.status === "invalida") status = "Inválida";
      else status = "Pendente";
  
      return {
        nome_usuario: action.nome_usuario,
        valor: action.valor,
        data: action.data,
        rede_social: action.rede_social,
        tipo_acao: action.tipo_acao,
        url: action.url,
        status
      };
    });
  
    return res.status(200).json(formattedData);
  }  

  try {
    const historico = await ActionHistory
      .find({ user: usuario._id, status: { $ne: "pulada" } })
      .sort({ data: -1 });

    const formattedData = historico.map(action => {
      let status;
      if (action.status === "valida") status = "Válida";
      else if (action.status === "invalida") status = "Inválida";
      else status = "Pendente";

      return {
        nome_usuario: action.nome_usuario,
        valor: action.valor,
        data: action.data,
        rede_social: action.rede_social,
        tipo_acao: action.tipo_acao,
        url: action.url,
        status
      };
    });
    
    return res.status(200).json(formattedData);
  } catch (error) {
    console.error("💥 Erro em /historico_acoes:", error);
    return res.status(500).json({ error: "Erro ao buscar histórico de ações." });
  }
});

// Rota: /api/tiktok/get_user
router.get("/tiktok/get_user", async (req, res) => {
  await connectDB();
  let { token, nome_usuario } = req.query;

  if (!token || !nome_usuario) {
    return res.status(400).json({ error: "Os parâmetros 'token' e 'nome_usuario' são obrigatórios." });
  }

  nome_usuario = nome_usuario.trim().toLowerCase();

  try {
    // Verifica usuário pelo token
    const usuario = await User.findOne({ token });
    if (!usuario) {
      return res.status(403).json({ error: "Acesso negado. Token inválido." });
    }

    // Verifica se essa conta já está vinculada a outro usuário
    const contaJaRegistrada = await User.findOne({
      "contas.nome_usuario": nome_usuario,
      token: { $ne: token }
    });

    if (contaJaRegistrada) {
      return res.status(200).json({
        status: "fail",
        message: "Essa conta TikTok já está vinculada a outro usuário."
      });
    }

    // PROCURAR conta IGUAL pelo nome_usuario E PELA REDE "TikTok"
    const contaIndex = usuario.contas.findIndex(
      c => c.nome_usuario === nome_usuario && c.rede === "TikTok"
    );

    if (contaIndex !== -1) {
      // Conta já existe → reativar e garantir rede="TikTok"
      usuario.contas[contaIndex].status = "ativa";
      usuario.contas[contaIndex].rede = "TikTok";
    } else {
      // Criar nova conta com rede TikTok
      usuario.contas.push({
        nome_usuario,
        status: "ativa",
        rede: "TikTok"
      });
    }

    await usuario.save();

    return res.status(200).json({
      status: "success",
      nome_usuario
    });

  } catch (error) {
    console.error("Erro ao processar requisição:", error);
    return res.status(500).json({ error: "Erro interno ao processar requisição." });
  }
});

// ROTA: /api/tiktok/get_action (GET)
router.get("/tiktok/get_action", async (req, res) => {
  const { nome_usuario, token, tipo, debug } = req.query;

  if (!nome_usuario || !token) {
    return res.status(400).json({ error: "Parâmetros 'nome_usuario' e 'token' são obrigatórios" });
  }

  try {
    await connectDB();

    console.log("[GET_ACTION] Requisição:", {
      nome_usuario,
      token: token ? "***" + token.slice(-6) : null,
      tipo,
      debug: !!debug
    });

    // validar usuário via token
    const usuario = await User.findOne({ token });
    if (!usuario) {
      console.log("[GET_ACTION] Token inválido");
      return res.status(401).json({ error: "Token inválido" });
    }

    // garantir que o token corresponde à conta vinculada
    const contaVinculada = Array.isArray(usuario.contas) &&
      usuario.contas.some(c => c.nome_usuario === nome_usuario);

    if (!contaVinculada) {
      console.log("[GET_ACTION] Token não pertence à conta solicitada:", nome_usuario);
      return res.status(401).json({ error: "Token não pertence à conta solicitada" });
    }

    // normalizar tipo
    const tipoNormalized = typeof tipo === 'string' ? String(tipo).trim().toLowerCase() : null;
    let tipoBanco;

    if (tipo === "2" || tipoNormalized === "2" || tipoNormalized === "curtir") {
      tipoBanco = "curtir";
    } else if (tipo === "3" || tipoNormalized === "3" || tipoNormalized === "seguir_curtir") {
      tipoBanco = { $in: ["seguir", "curtir"] };
    } else {
      tipoBanco = "seguir";
    }

    // query base
    const query = {
      quantidade: { $gt: 0 },
      status: { $in: ["pendente", "reservada"] },
      rede: { $regex: /^tiktok$/i }
    };

    query.tipo = tipoBanco;

    const totalMatching = await Pedido.countDocuments(query);
    console.log(`[GET_ACTION] Pedidos que batem com query inicial: ${totalMatching}`);

    const pedidos = await Pedido.find(query).sort({ dataCriacao: -1 }).lean();
    console.log(`[GET_ACTION] ${pedidos.length} pedidos encontrados (após find)`);

    if (debug === "1") {
      return res.status(200).json({
        debug: true,
        totalMatching,
        sampleQuery: query,
        pedidosSample: pedidos.slice(0, 6)
      });
    }

    // varrer pedidos
    for (const pedido of pedidos) {
      const id_pedido = pedido._id;
      const idPedidoStr = String(id_pedido);

      const quantidadePedido = Number(pedido.quantidade || 0);
      if (isNaN(quantidadePedido) || quantidadePedido <= 0) continue;

      // total validadas
      const validadas = await ActionHistory.countDocuments({
        $or: [{ id_pedido }, { id_action: idPedidoStr }],
        status: "valida"
      });

      if (validadas >= quantidadePedido) continue;

      // total feitas (pendente + valida)
      const feitas = await ActionHistory.countDocuments({
        $or: [{ id_pedido }, { id_action: idPedidoStr }],
        status: { $in: ["pendente", "valida"] }
      });

      if (feitas >= quantidadePedido) continue;

      // verificar se esta conta pulou
      const pulada = await ActionHistory.findOne({
        $or: [{ id_pedido }, { id_action: idPedidoStr }],
        nome_usuario,
        status: "pulada"
      });

      if (pulada) continue;

      // verificar se esta conta já fez
      const jaFez = await ActionHistory.findOne({
        $or: [{ id_pedido }, { id_action: idPedidoStr }],
        nome_usuario,
        status: { $in: ["pendente", "valida"] }
      });

      if (jaFez) continue;

      // extrair nome do perfil alvo
      let nomeUsuarioAlvo = "";
      if (typeof pedido.link === "string") {
        if (pedido.link.includes("@")) {
          nomeUsuarioAlvo = pedido.link.split("@")[1].split(/[/?#]/)[0];
        } else {
          const m = pedido.link.match(/tiktok\.com\/@?([^\/?#&]+)/i);
          if (m && m[1]) nomeUsuarioAlvo = m[1].replace(/\/$/, "");
        }
      }

      console.log(`✅ Ação disponível para ${nome_usuario}: ${nomeUsuarioAlvo || '<sem-usuario>'}`);

const valorFinal = getValorAcao(pedido, "TikTok");

      const tipoAcao = pedido.tipo;

      // 🔥 DIFERENCIAÇÃO SEGUIR vs CURTIR
      if (tipoAcao === "seguir") {
        return res.status(200).json({
          status: "success",
          id_action: idPedidoStr,
          url: pedido.link,
          usuario: nomeUsuarioAlvo, // ← só para seguir
          tipo_acao: tipoAcao,
          valor: valorFinal
        });
      } else {
        return res.status(200).json({
          status: "success",
          id_action: idPedidoStr,
          url: pedido.link,
          tipo_acao: tipoAcao,
          valor: valorFinal
        });
      }
    }

    console.log("[GET_ACTION] Nenhuma ação disponível");
    return res.status(200).json({ status: "fail", message: "nenhuma ação disponível no momento" });

  } catch (err) {
    console.error("[GET_ACTION] Erro ao buscar ação:", err);
    return res.status(500).json({ error: "Erro interno ao buscar ação" });
  }
});

// ROTA: /api/tiktok/confirm_action (POST)
router.post("/tiktok/confirm_action", async (req, res) => {
  await connectDB();

  const { token, id_action, nome_usuario } = req.body;

  if (!token || !id_action || !nome_usuario) {
    return res.status(400).json({
      error: "Parâmetros 'token', 'id_action' e 'nome_usuario' são obrigatórios."
    });
  }

  try {
    // 🔐 Validar token
    const usuario = await User.findOne({ token });
    if (!usuario) {
      return res.status(403).json({ error: "Acesso negado. Token inválido." });
    }

    console.log("🧩 id_action recebido:", id_action);

    // Normalizar tipo
    function normalizarTipo(tipo) {
      const mapa = {
        seguir: "seguir",
        seguiram: "seguir",
        Seguir: "seguir",
        curtidas: "curtir",
        curtir: "curtir",
        Curtir: "curtir",
      };
      return mapa[tipo?.toLowerCase?.()] || "seguir";
    }

    // 🔍 Buscar pedido local
    const pedidoLocal = await Pedido.findById(id_action);

    if (!pedidoLocal) {
      console.log("❌ Pedido local não encontrado:", id_action);
      return res.status(404).json({ error: "Ação não encontrada." });
    }

    console.log("📦 Confirmando ação local:", id_action);

    // Definir tipo da ação
    const tipo_acao = normalizarTipo(
      pedidoLocal.tipo_acao ||
      pedidoLocal.tipo
    );

// Valor da ação (agora usando função global)
const valorFinal = getValorAcao({
  tipo: tipo_acao,
  valor: pedidoLocal.valor
});

    // URL do perfil alvo
    const url_dir = pedidoLocal.link;

    // Criar registro no histórico
    const newAction = new ActionHistory({
      user: usuario._id,
      token,
      nome_usuario,
      tipo_acao,
      tipo: tipo_acao,
      valor: valorFinal,
      rede_social: "TikTok",
      url: url_dir,            // ✔ CORRIGIDO
      id_action,
      status: "pendente",
      data: new Date(),
    });

    const saved = await newAction.save();

    usuario.historico_acoes.push(saved._id);
    await usuario.save();

    return res.status(200).json({
      status: "success",
      message: "Ação confirmada com sucesso.",
      valor: valorFinal,
    });

  } catch (error) {
    console.error("💥 Erro ao processar requisição:", error.message);
    return res.status(500).json({ error: "Erro interno ao processar requisição." });
  }
});

// Rota: /api/instagram/get_user
router.get("/instagram/get_user", async (req, res) => {
  await connectDB();
  let { token, nome_usuario } = req.query;

  if (!token || !nome_usuario) {
    return res.status(400).json({ error: "Os parâmetros 'token' e 'nome_usuario' são obrigatórios." });
  }

  nome_usuario = nome_usuario.trim().toLowerCase();

  try {
    // Verifica usuário pelo token
    const usuario = await User.findOne({ token });
    if (!usuario) {
      return res.status(403).json({ error: "Acesso negado. Token inválido." });
    }

    // Verifica se essa conta já está vinculada a outro usuário
    const contaJaRegistrada = await User.findOne({
      "contas.nome_usuario": nome_usuario,
      token: { $ne: token }
    });

    if (contaJaRegistrada) {
      return res.status(200).json({
        status: "fail",
        message: "Essa conta Instagram já está vinculada a outro usuário."
      });
    }

    // PROCURAR conta IGUAL pelo nome_usuario E PELA REDE "Instagram"
    const contaIndex = usuario.contas.findIndex(
      c => c.nome_usuario === nome_usuario && c.rede === "Instagram"
    );

    if (contaIndex !== -1) {
      // Conta IG existente → reativar
      usuario.contas[contaIndex].status = "ativa";
    } else {
      // Criar NOVO documento mesmo se nome_usuario for igual ao de outra rede
      usuario.contas.push({
        nome_usuario,
        status: "ativa",
        rede: "Instagram"
      });
    }

    await usuario.save();

    return res.status(200).json({
      status: "success",
      nome_usuario
    });

  } catch (error) {
    console.error("Erro ao processar requisição:", error);
    return res.status(500).json({ error: "Erro interno ao processar requisição." });
  }
});

// Rota: /api/instagram/get_action (GET) — VERSÃO CORRIGIDA
router.get("/instagram/get_action", async (req, res) => {
  const { nome_usuario, token, tipo, debug } = req.query;

  if (!nome_usuario || !token) {
    return res.status(400).json({ error: "Parâmetros 'nome_usuario' e 'token' são obrigatórios" });
  }

  // normaliza nome_usuario para comparação consistente
  const nomeUsuarioRequest = String(nome_usuario).trim().toLowerCase();

  try {
    await connectDB();

    console.log("[GET_ACTION][IG] Requisição:", {
      nome_usuario: nomeUsuarioRequest,
      token: token ? "***" + token.slice(-6) : null,
      tipo,
      debug: !!debug
    });

    // valida token (acha o usuário dono do token)
    const usuario = await User.findOne({ token });
    if (!usuario) {
      console.log("[GET_ACTION][IG] Token inválido");
      return res.status(401).json({ error: "Token inválido" });
    }

    // garante que o token corresponde à conta nome_usuario enviada
    const contaVinculada = Array.isArray(usuario.contas) &&
      usuario.contas.some(c => String(c.nome_usuario).trim().toLowerCase() === nomeUsuarioRequest);

    if (!contaVinculada) {
      console.log("[GET_ACTION][IG] Token não pertence à conta solicitada:", nomeUsuarioRequest);
      return res.status(401).json({ error: "Token não pertence à conta solicitada" });
    }

    // normalizar tipo (entrada)
    const tipoNormalized = typeof tipo === 'string' ? String(tipo).trim().toLowerCase() : null;
    let tipoBanco;
    if (tipo === "2" || tipoNormalized === "2" || tipoNormalized === "curtir") tipoBanco = "curtir";
    else if (tipo === "3" || tipoNormalized === "3" || tipoNormalized === "seguir_curtir")
      tipoBanco = { $in: ["seguir", "curtir"] };
    else tipoBanco = "seguir";

    // query base — instagram, status e quantidade disponível (mesma lógica do /tiktok/get_action)
    const query = {
      quantidade: { $gt: 0 },
      status: { $in: ["pendente", "reservada"] },
      rede: { $regex: new RegExp(`^instagram$`, "i") }
    };
    if (typeof tipoBanco === "string") query.tipo = tipoBanco;
    else query.tipo = tipoBanco;

    const totalMatching = await Pedido.countDocuments(query);
    console.log(`[GET_ACTION][IG] Pedidos que batem com query inicial: ${totalMatching}`);

    const pedidos = await Pedido.find(query).sort({ dataCriacao: -1 }).lean();
    console.log(`[GET_ACTION][IG] ${pedidos.length} pedidos encontrados (após find)`);

    if (debug === "1") {
      return res.status(200).json({ debug: true, totalMatching, sampleQuery: query, pedidosSample: pedidos.slice(0, 6) });
    }

    for (const pedido of pedidos) {
      const id_pedido = pedido._id;               // pode ser número ou ObjectId
      const idPedidoStr = String(id_pedido);     // comparação com strings armazenadas em id_action

      console.log("[GET_ACTION][IG] Verificando pedido:", {
        id_pedido,
        tipo: pedido.tipo,
        quantidade: pedido.quantidade,
        link: pedido.link
      });

      // garantir que quantidade é número válido
      const quantidadePedido = Number(pedido.quantidade || 0);
      if (isNaN(quantidadePedido) || quantidadePedido <= 0) {
        console.log(`[GET_ACTION][IG] Ignorando pedido ${id_pedido} por quantidade inválida:`, pedido.quantidade);
        continue;
      }

      // === Contagens (sem filtrar por "tipo" para evitar mismatch com campo tipo_acao) ===
      // validadas: status validadas (considera ambos campos possíveis)
      const validadas = await ActionHistory.countDocuments({
        $and: [
          { $or: [{ id_pedido }, { id_action: idPedidoStr }] },
          { $or: [{ status: "valida" }, { acao_validada: "valida" }] }
        ]
      });
      if (validadas >= quantidadePedido) {
        console.log(`[GET_ACTION][IG] Pedido ${id_pedido} fechado — já tem ${validadas} validações.`);
        continue;
      }

      // feitas: pendente + valida (também considerando ambos os campos)
      const feitas = await ActionHistory.countDocuments({
        $and: [
          { $or: [{ id_pedido }, { id_action: idPedidoStr }] },
          { $or: [{ status: { $in: ["pendente", "valida"] } }, { acao_validada: { $in: ["pendente", "valida"] } }] }
        ]
      });
      console.log(`[GET_ACTION][IG] Ação ${id_pedido} (tipo ${pedido.tipo}): feitas=${feitas}, limite=${quantidadePedido}`);
      if (feitas >= quantidadePedido) {
        console.log(`[GET_ACTION][IG] Pedido ${id_pedido} atingiu limite — pulando`);
        continue;
      }

      // Verificar se ESTE NOME_DE_CONTA pulou => bloqueia só esta conta
      const pulada = await ActionHistory.findOne({
        $and: [
          { $or: [{ id_pedido }, { id_action: idPedidoStr }] },
          { nome_usuario: nomeUsuarioRequest },
          { $or: [{ status: "pulada" }, { acao_validada: "pulada" }] }
        ]
      });
      if (pulada) {
        console.log(`[GET_ACTION][IG] Usuário ${nomeUsuarioRequest} pulou o pedido ${id_pedido} — pulando`);
        continue;
      }

      // Verificar se ESTE NOME_DE_CONTA já possui pendente/valida => bloqueia só esta conta
      const jaFez = await ActionHistory.findOne({
        $and: [
          { $or: [{ id_pedido }, { id_action: idPedidoStr }] },
          { nome_usuario: nomeUsuarioRequest },
          { $or: [{ status: { $in: ["pendente", "valida"] } }, { acao_validada: { $in: ["pendente", "valida"] } }] }
        ]
      });
      if (jaFez) {
        console.log(`[GET_ACTION][IG] Usuário ${nomeUsuarioRequest} já possui ação pendente/validada para pedido ${id_pedido} — pulando`);
        continue;
      }

      // Se chegou aqui: feitas < quantidade AND este nome_usuario ainda NÃO fez (para este pedido) => pode pegar
      // extrair alvo do link (Instagram tolerant)
      let nomeUsuarioAlvo = "";
      if (typeof pedido.link === "string") {
        const link = pedido.link.trim();

        // post (curtir): /p/POST_ID/
        const postMatch = link.match(/instagram\.com\/p\/([^\/?#&]+)/i);
        if (postMatch && postMatch[1]) {
          nomeUsuarioAlvo = postMatch[1]; // devolve o id do post
        } else {
          // perfil: /username/
          const m = link.match(/instagram\.com\/@?([^\/?#&\/]+)/i);
          if (m && m[1]) {
            nomeUsuarioAlvo = m[1].replace(/\/$/, "");
          } else {
            nomeUsuarioAlvo = pedido.nome || "";
          }
        }
      }

      console.log(`[GET_ACTION][IG] Ação disponível para ${nomeUsuarioRequest}: ${nomeUsuarioAlvo || '<sem-usuario>'} (pedido ${id_pedido}) — feitas=${feitas}/${quantidadePedido}`);

const valorFinal = getValorAcao(pedido, "Instagram");

      // retorno diferenciado para seguir x curtir
      if (pedido.tipo === "seguir") {
        return res.status(200).json({
          status: "success",
          id_action: idPedidoStr,
          url: pedido.link,
          usuario: nomeUsuarioAlvo,
          tipo_acao: pedido.tipo,
          valor: valorFinal
        });
      } else {
        return res.status(200).json({
          status: "success",
          id_action: idPedidoStr,
          url: pedido.link,
          tipo_acao: pedido.tipo,
          valor: valorFinal
        });
      }
    }

    console.log("[GET_ACTION][IG] Nenhuma ação disponível");
    return res.status(200).json({ status: "fail", message: "nenhuma ação disponível no momento" });

  } catch (err) {
    console.error("[GET_ACTION][IG] Erro ao buscar ação:", err);
    return res.status(500).json({ error: "Erro interno ao buscar ação" });
  }
});

// ROTA: /api/instagram/confirm_action (POST)
router.post("/instagram/confirm_action", async (req, res) => {
  await connectDB();

  let { token, id_action, nome_usuario } = req.body;

  if (!token || !id_action || !nome_usuario) {
    return res.status(400).json({
      error: "Parâmetros 'token', 'id_action' e 'nome_usuario' são obrigatórios."
    });
  }

  // Normaliza o nome de usuário recebido para comparações
  nome_usuario = String(nome_usuario).trim().toLowerCase();

  try {
    // 🔐 Validar token (acha o usuário dono do token)
    const usuario = await User.findOne({ token });
    if (!usuario) {
      return res.status(403).json({ error: "Acesso negado. Token inválido." });
    }

    // Garantir que o token pertence à conta informada (evita token de A agir por B)
    const contaVinculada = Array.isArray(usuario.contas) &&
      usuario.contas.some(c => String(c.nome_usuario).trim().toLowerCase() === nome_usuario);
    if (!contaVinculada) {
      console.log("[CONFIRM_ACTION][IG] Token não pertence à conta:", nome_usuario);
      return res.status(403).json({ error: "Token não pertence à conta informada." });
    }

    console.log("🧩 id_action recebido:", id_action);

    // Normalizar tipo (mapa robusto)
    function normalizarTipo(tipo) {
      const mapa = {
        seguir: "seguir",
        seguiram: "seguir",
        Seguir: "seguir",
        curtidas: "curtir",
        curtir: "curtir",
        Curtir: "curtir",
      };
      return mapa[String(tipo || "").toLowerCase()] || "seguir";
    }

    // 🔍 Buscar pedido local (pelo id numérico)
    const pedidoLocal = await Pedido.findById(id_action);

    if (!pedidoLocal) {
      console.log("[CONFIRM_ACTION][IG] Pedido local não encontrado:", id_action);
      return res.status(404).json({ error: "Ação não encontrada." });
    }

    console.log("📦 Confirmando ação local (IG):", id_action);

    // Definir tipo da ação (pode vir de pedidoLocal.tipo_acao ou pedidoLocal.tipo)
    const tipo_acao = normalizarTipo(pedidoLocal.tipo_acao || pedidoLocal.tipo);

// Valor da ação (agora usando função global)
const valorFinal = getValorAcao({
  tipo: tipo_acao,
  valor: pedidoLocal.valor
});

    // URL do alvo
    const url_dir = pedidoLocal.link;

    // Extrair alvo do link (perfil ou post)
    let nomeDoPerfil = "";
    if (typeof url_dir === "string" && url_dir.length) {
      const link = url_dir.trim();

      // tentativa 1: post (/p/ID/)
      const postMatch = link.match(/instagram\.com\/p\/([^\/?#&]+)/i);
      if (postMatch && postMatch[1]) {
        nomeDoPerfil = postMatch[1];
      } else {
        // tentativa 2: perfil (/username/)
        const profileMatch = link.match(/instagram\.com\/@?([^\/?#&\/]+)/i);
        if (profileMatch && profileMatch[1]) {
          nomeDoPerfil = profileMatch[1].replace(/\/$/, "");
        } else {
          // fallback para usar campo nome do pedido
          nomeDoPerfil = pedidoLocal.nome || "";
        }
      }
    }

    // Criar registro no histórico
    const newAction = new ActionHistory({
      user: usuario._id,
      token,
      nome_usuario,
      tipo_acao,
      tipo: tipo_acao,
      valor: valorFinal,
      rede_social: "Instagram",
      url: url_dir,
      id_action: String(pedidoLocal._id),
      status: "pendente",
      data: new Date(),
    });

    const saved = await newAction.save();

    // vincular histórico ao usuário e salvar
    usuario.historico_acoes.push(saved._id);
    await usuario.save();

    return res.status(200).json({
      status: "success",
      message: "Ação confirmada com sucesso.",
      valor: valorFinal,
    });

  } catch (error) {
    console.error("💥 [CONFIRM_ACTION][IG] Erro ao processar requisição:", error);
    return res.status(500).json({ error: "Erro interno ao processar requisição." });
  }
});

// ROTA: /api/pular_acao
router.post("/pular_acao", async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  await connectDB();

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "Token não fornecido." });
  }

  const token = authHeader.replace("Bearer ", "");

  const {
    id_pedido,
    nome_usuario,
    url,
    tipo_acao,
    valor
  } = req.body;

  // ===== VALIDAÇÃO DE CAMPOS =====
if (!id_pedido || !nome_usuario || !url || !tipo_acao || !valor) {
    return res.status(400).json({ error: "Campos obrigatórios ausentes." });
  }

  // ===== VALIDAR TOKEN =====
  const usuario = await User.findOne({ token });
  if (!usuario) {
    return res.status(401).json({ error: "Token inválido." });
  }

  try {
    // ===== DETECTAR REDE SOCIAL =====
    let redeFinal = "TikTok";
    if (url.includes("instagram.com")) redeFinal = "Instagram";

    // ===== DETECTAR TIPO DE AÇÃO =====
    let tipoAcaoFinal = "seguir";
    if (url.includes("/video/") || url.includes("/p/") || url.includes("/reel/") || url.includes("watch?v=")) {
      tipoAcaoFinal = "curtir";
    }

    // ===== IMPEDIR DUPLICAÇÃO DO PULO =====
    const existente = await ActionHistory.findOne({
      id_action: String(id_pedido),
      acao_validada: "pulada",
    });

    if (existente) {
      return res.status(200).json({ status: "JA_PULADA" });
    }

    // ===== REGISTRAR AÇÃO PULADA =====
    const novaAcao = new ActionHistory({
      user: usuario._id,
      token,
      nome_usuario,
      id_action: String(id_pedido),
      url,
      tipo_acao: tipo_acao.toLowerCase(),
      tipo: tipoAcaoFinal,
      rede_social: redeFinal,
      acao_validada: "pulada",
      status: "pulada",
      valor,
      data: new Date()
    });

    await novaAcao.save();

    return res.status(200).json({ status: "PULADA_REGISTRADA" });

  } catch (error) {
    console.error("Erro ao registrar ação pulada:", error);
    return res.status(500).json({ error: "Erro interno." });
  }
});

// 🔹 Rota: /api/afiliados
router.post("/afiliados", async (req, res) => {
  // não destrua `token` do body com o mesmo nome do header
  const { token: bodyToken } = req.body || {};

  try {
    await connectDB();

    const authHeader = req.headers.authorization;
    if (!authHeader && !bodyToken) {
      return res.status(401).json({ error: "Acesso negado, token não encontrado." });
    }

    // prefira o token do header, fallback para bodyToken
    const tokenFromHeader = authHeader && authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : authHeader; // caso mandem só o token sem "Bearer "

    const effectiveToken = tokenFromHeader || bodyToken;
    console.log("🔹 Token usado para autenticação:", !!effectiveToken); // booleano para não vazar token

    if (!effectiveToken) return res.status(401).json({ error: "Token inválido." });

    const user = await User.findOne({ token: effectiveToken });
    if (!user) return res.status(404).json({ error: "Usuário não encontrado ou token inválido." });

    // Código do afiliado
    const codigo_afiliado = user.codigo_afiliado || user._id.toString();

    // 🔗 Busca todos os indicados por este afiliado
    const indicados = await User.find({ indicado_por: codigo_afiliado });

    const total_indicados = indicados.length;

    // 🔹 Filtra apenas os ativos dentro de 30 dias
    const agora = new Date();
    const indicados_ativos = indicados.filter(u => u.status === "ativo" && u.ativo_ate && new Date(u.ativo_ate) > agora).length;

    // 💰 Soma das comissões
    const comissoes = await ActionHistory.aggregate([
      { $match: { tipo: "comissao", afiliado: codigo_afiliado } },
      { $group: { _id: null, total: { $sum: "$valor" } } }
    ]);
    const total_comissoes = comissoes.length > 0 ? comissoes[0].total : 0;

    console.log("[DEBUG] Dados de afiliado:", { codigo_afiliado, total_indicados, indicados_ativos, total_comissoes });

    return res.status(200).json({ total_comissoes, total_indicados, indicados_ativos, codigo_afiliado });

  } catch (error) {
    console.error("Erro ao carregar dados de afiliados:", error);
    return res.status(500).json({ error: "Erro interno ao buscar dados de afiliados." });
  }
});

// Rota: /api/confirmar_acao
router.post("/confirmar_acao", async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido." });
  }

  await connectDB();

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "Token não fornecido." });
  }

  const token = authHeader.replace("Bearer ", "");
  const usuario = await User.findOne({ token });
  if (!usuario) {
    return res.status(401).json({ error: "Token inválido." });
  }

  const { nome_usuario, url, tipo_acao, id_pedido } = req.body;

  if (!nome_usuario || !tipo_acao || !id_pedido) {
    return res.status(400).json({ error: "Campos obrigatórios ausentes." });
  }

  try {
    // === Detectar Rede Social ===
    let redeFinal = "TikTok";
    if (url?.includes("instagram.com") || tipo_acao?.toLowerCase().includes("instagram")) {
      redeFinal = "Instagram";
    }

    // === Detectar Tipo de Ação ===
    let tipoAcaoFinal = "seguir";
    if (url.includes("/video/") || url.includes("/p/") || url.includes("/reel/")) {
      tipoAcaoFinal = "curtir";
    }

    // === VALOR FINAL VIA VARIAVEL DE AMBIENTE ===
    const valorConfirmacaoFinal = getValorAcao(tipoAcaoFinal, redeFinal);

    // === Criar Ação ===
    const novaAcao = new ActionHistory({
      user: usuario._id,
      token: usuario.token,
      nome_usuario,
      id_action: String(id_pedido),
      url,
      tipo_acao,
      valor: valorConfirmacaoFinal, // <-- AGORA CORRETO!
      tipo: tipoAcaoFinal,
      rede_social: redeFinal,
      status: "pendente",
      acao_validada: false,
      data: new Date()
    });

    await salvarAcaoComLimitePorUsuario(novaAcao);

    return res.status(200).json({ status: "pendente", message: "Ação registrada com sucesso." });

  } catch (error) {
    console.error("Erro ao registrar ação pendente:", error);
    return res.status(500).json({ error: "Erro ao registrar ação." });
  }
});

// Rota: /api/test/ranking_diario (POST)
router.post("/ranking_diario", async (req, res) => {
  const rankingQuery = req.query || {};
  const { token: bodyToken } = req.body || {};

  try {
    await connectDB();

    // tempo / dia
    const agora = Date.now();
    const CACHE_MS = 1 * 60 * 1000; // 1 minuto
    const hoje = new Date().toLocaleDateString("pt-BR");

    // autenticação (prefere header Authorization Bearer)
    const authHeader = req.headers.authorization;
    const tokenFromHeader =
      authHeader && authHeader.startsWith("Bearer ")
        ? authHeader.split(" ")[1]
        : authHeader;
    const effectiveToken = tokenFromHeader || bodyToken;
    if (!effectiveToken) return res.status(401).json({ error: "Token inválido." });

    const user = await User.findOne({ token: effectiveToken });
    if (!user) return res.status(404).json({ error: "Usuário não encontrado ou token inválido." });

    // ---- lista de nomes fornecida (para preencher dailyrankings quando faltar) ----
    const fillerNames = [
      "-","🤪","-","noname","⚡","💪","-","-","kaduzinho",
      "Rei do ttk 👑","Deus🔥","Mago ✟","-","ldzz tiktok uva🍇","unknown",
      "vitor das continhas","-","@_01.kaio0","Lipe Rodagem Interna 😄","-","dequelbest 🧙","-","-","xxxxxxxxxx",
      "Bruno TK","-","[GODZ] MK ☠️","-","Junior","Metheus Rangel","Hackerzin☯","VIP++++","sagaz🐼","-"
    ];

    // função utilitária: normaliza username/token/userId para comparações
    const norm = (s) => String(s || "").trim().toLowerCase();

    // small helper shuffle (in-place) - retorna array
    function shuffleArray(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }

    // --- 1) carregar dailyFixedRanking do DB (normalizando strings -> objetos) ---
    if (!dailyFixedRanking || diaTop3 !== hoje) {
      try {
        const saved = await DailyRanking.findOne({ data: hoje }).lean();
        if (saved && Array.isArray(saved.ranking) && saved.ranking.length) {
          dailyFixedRanking = saved.ranking.map((entry) => ({
            username: entry.username ?? entry.nome ?? "Usuário",
            token: entry.token ?? null,
            real_total: Number(entry.real_total ?? 0),
            is_current_user: !!entry.is_current_user,
            userId: entry.userId ? String(entry.userId) : null
          }));

          if (saved.startAt) {
            horaInicioRanking = new Date(saved.startAt).getTime();
          } else if (saved.criadoEm) {
            horaInicioRanking = new Date(saved.criadoEm).getTime();
          } else {
            // fallback para início do dia Brasília
            const now = new Date();
            const offsetBrasilia = -3;
            const brasilNow = new Date(now.getTime() + offsetBrasilia * 60 * 60 * 1000);
            const startOfDayBR = new Date(Date.UTC(
              brasilNow.getUTCFullYear(),
              brasilNow.getUTCMonth(),
              brasilNow.getUTCDate(),
              3, 0, 0, 0
            ));
            horaInicioRanking = startOfDayBR.getTime();
          }

          top3FixosHoje = dailyFixedRanking.slice(0, 3).map((u) => ({ ...u }));
          diaTop3 = hoje;
          zeroedAtMidnight = false;
          console.log("📥 Loaded dailyFixedRanking from DB for", hoje, dailyFixedRanking.map((d) => d.username));
        } else {

let pool = fillerNames.slice(); // copia a lista
shuffleArray(pool); // embaralha nomes primeiro

// atribui baseline aos primeiros 10 (garante non-zero para top10) e marca como fixed
const seededFull = pool.map((nm, idx) => ({
  username: nm || "Usuário",
  token: null,
  real_total: Number(baselineValores[idx] ?? 1),
  userId: null,
  source: "fixed"
}));

// salva um pool (por exemplo os primeiros 30) para usar como fallback
const toSave = seededFull.slice(0, Math.min(30, seededFull.length));
await DailyRanking.findOneAndUpdate(
  { data: hoje },
  { ranking: toSave, startAt: new Date(), criadoEm: new Date() },
  { upsert: true, new: true, setDefaultsOnInsert: true }
);

// atribui dailyFixedRanking com os 10 primeiros (já embaralhados)
dailyFixedRanking = toSave.slice(0, 10).map((x, i) => ({
  username: x.username,
  token: x.token || null,
  real_total: Number(x.real_total || baselineValores[i] || 1),
  is_current_user: x.token === effectiveToken,
  userId: x.userId || null,
  source: x.source || "fixed"
}));

// define horaInicioRanking a partir do startAt que salvamos (consistente)
horaInicioRanking = (new Date()).getTime();

top3FixosHoje = dailyFixedRanking.slice(0, 3).map(u => ({ ...u }));
diaTop3 = hoje;
zeroedAtMidnight = false;
console.log("⚙️ Sem documento DailyRanking para hoje — semei com fillerNames:", dailyFixedRanking.map(d => d.username));
        }
      } catch (e) {
        console.error("Erro ao carregar/semear DailyRanking do DB:", e);
      }
    }

    // === 2) reset manual via ENV ou URL ?reset=true ===
    const resetPorEnv = process.env.RESET_RANKING === "true";
    const resetPorURL = rankingQuery.reset === "true";
    if (resetPorEnv || resetPorURL) {
      // zera ganhos e saldos (como antes)
      await DailyEarning.deleteMany({});
      await User.updateMany({}, { $set: { balance: 0 } });

      // Constrói dailyFixedRanking APENAS a partir de dailyearnings (top N)
      let topFromEarnings = await fetchTopFromDailyEarning(10);

      // Se necessário, complete com entradas salvas em DailyRanking (sem pool aleatório)
if (topFromEarnings.length < 10) {
  const need = 10 - topFromEarnings.length;
  const usedNorms = new Set(topFromEarnings.map(p => norm(p.username) || ""));
  const extras = [];
  // startIndex = quantas posições já ocupadas; usamos baselineValores[startIndex + extras.length]
  const startIndex = topFromEarnings.length;
  for (const nm of fillerNames) {
    if (extras.length >= need) break;
    const n = norm(nm);
    if (!usedNorms.has(n)) {
      const idxForBaseline = startIndex + extras.length;
      extras.push({
        username: nm,
        token: null,
        real_total: Number(baselineValores[idxForBaseline] ?? 0), // non-zero quando possível
        userId: null,
        source: "fixed" // marca como fixed para que receba projeção
      });
      usedNorms.add(n);
    }
  }
  topFromEarnings = topFromEarnings.concat(extras);
}

      // se ainda faltar, completar com fillerNames (não duplicar)
      if (topFromEarnings.length < 10) {
        const need = 10 - topFromEarnings.length;
        const usedNorms = new Set(topFromEarnings.map(p => norm(p.username) || ""));
        const extras = [];
        for (const nm of fillerNames) {
          if (extras.length >= need) break;
          const n = norm(nm);
          if (!usedNorms.has(n)) {
            extras.push({ username: nm, token: null, real_total: 0, userId: null, source: "filler" });
            usedNorms.add(n);
          }
        }
        topFromEarnings = topFromEarnings.concat(extras);
      }

      shuffleArray(topFromEarnings);

dailyFixedRanking = topFromEarnings.slice(0, 10).map((c, idx) => ({
  username: c.username,
  token: c.token || null,
  real_total: Number((c.real_total && c.real_total > 0) ? c.real_total : baselineValores[idx] || 0),
  is_current_user: c.token === effectiveToken,
  userId: c.userId || null,
  source: c.source || "fixed"
}));

// embaralha para variar a ordem após reset
shuffleArray(dailyFixedRanking);

// define datas startAt / expiresAt e salve (use startAtDate para horaInicio)
const agoraDate = new Date();
const brasilAgora = new Date(agoraDate.getTime() + (-3) * 60 * 60 * 1000);
const hojeStr = brasilAgora.toLocaleDateString("pt-BR");
const brasilMidnightTomorrow = new Date(Date.UTC(brasilAgora.getUTCFullYear(), brasilAgora.getUTCMonth(), brasilAgora.getUTCDate() + 1, 3, 0, 0, 0));
const startAtDate = new Date(Date.UTC(brasilAgora.getUTCFullYear(), brasilAgora.getUTCMonth(), brasilAgora.getUTCDate(), 3, 0, 0, 0));

await DailyRanking.findOneAndUpdate(
  { data: hojeStr },
  {
    ranking: dailyFixedRanking,
    startAt: startAtDate,
    expiresAt: brasilMidnightTomorrow,
    criadoEm: new Date()
  },
  { upsert: true, new: true, setDefaultsOnInsert: true }
);

// agora horaInicioRanking usa startAtDate
horaInicioRanking = startAtDate.getTime();
top3FixosHoje = dailyFixedRanking.slice(0, 3).map(u => ({ ...u }));
diaTop3 = hojeStr;
ultimoRanking = null;
ultimaAtualizacao = 0;
zeroedAtMidnight = true;

      console.log("🔥 Reset manual — dailyFixedRanking criado (somente dailyearnings/dailyrankings):", dailyFixedRanking.map(d => d.username));

      if (resetPorURL) {
        const placeholder = dailyFixedRanking.map((d, i) => ({
          position: i + 1,
          username: d.username,
          total_balance: formatarValorRanking(d.real_total),
          is_current_user: !!d.is_current_user
        }));
        return res.status(200).json({
          success: true,
          message: "Ranking e saldos zerados (reset manual).",
          ranking: placeholder
        });
      }
    }

    // === 3) Reset automático à meia-noite (quando detecta mudança de dia) ===
    if (diaTop3 && diaTop3 !== hoje) {
      console.log("🕛 Novo dia detectado — resetando ranking diário automaticamente...");

      const agoraDate = new Date();
      const offsetBrasilia = -3; // UTC-3
      const brasilAgora = new Date(agoraDate.getTime() + offsetBrasilia * 60 * 60 * 1000);

      const brasilMidnightTomorrow = new Date(Date.UTC(
        brasilAgora.getUTCFullYear(),
        brasilAgora.getUTCMonth(),
        brasilAgora.getUTCDate() + 1,
        3, 0, 0, 0
      ));

      // === Reset de ganhos e saldos ===
      await DailyEarning.deleteMany({});
      await User.updateMany({}, { $set: { saldo: 0 } });

      // Constrói dailyFixedRanking apenas a partir de dailyearnings
      let topFromEarnings = await fetchTopFromDailyEarning(10);

      // Se precisar completar, use ranking salvo (APENAS) da coleção DailyRanking
if (topFromEarnings.length < 10) {
  const need = 10 - topFromEarnings.length;
  const usedNorms = new Set(topFromEarnings.map(p => norm(p.username) || ""));
  const extras = [];
  // startIndex = quantas posições já ocupadas; usamos baselineValores[startIndex + extras.length]
  const startIndex = topFromEarnings.length;
  for (const nm of fillerNames) {
    if (extras.length >= need) break;
    const n = norm(nm);
    if (!usedNorms.has(n)) {
      const idxForBaseline = startIndex + extras.length;
      extras.push({
        username: nm,
        token: null,
        real_total: Number(baselineValores[idxForBaseline] ?? 0), // non-zero quando possível
        userId: null,
        source: "fixed" // marca como fixed para que receba projeção
      });
      usedNorms.add(n);
    }
  }
  topFromEarnings = topFromEarnings.concat(extras);
}
      // se ainda faltar, completar com fillerNames (não duplicar)
      if (topFromEarnings.length < 10) {
        const need = 10 - topFromEarnings.length;
        const usedNorms = new Set(topFromEarnings.map(p => norm(p.username) || ""));
        const extras = [];
        for (const nm of fillerNames) {
          if (extras.length >= need) break;
          const n = norm(nm);
          if (!usedNorms.has(n)) {
            extras.push({ username: nm, token: null, real_total: 0, userId: null, source: "filler" });
            usedNorms.add(n);
          }
        }
        topFromEarnings = topFromEarnings.concat(extras);
      }

      shuffleArray(topFromEarnings);

dailyFixedRanking = topFromEarnings.slice(0, 10).map((c, idx) => ({
  username: c.username,
  token: c.token || null,
  real_total: Number((c.real_total && c.real_total > 0) ? c.real_total : baselineValores[idx] || 0),
  is_current_user: c.token === effectiveToken,
  userId: c.userId || null
}));

// <-- ADICIONE ESTA LINHA -->
shuffleArray(dailyFixedRanking);

      try {
        const agoraDate2 = new Date();
        const brasilAgora2 = new Date(agoraDate2.getTime() + offsetBrasilia * 60 * 60 * 1000);
        const hojeStr = brasilAgora2.toLocaleDateString("pt-BR");

        const brasilMidnightTomorrow2 = new Date(Date.UTC(
          brasilAgora2.getUTCFullYear(),
          brasilAgora2.getUTCMonth(),
          brasilAgora2.getUTCDate() + 1,
          3, 0, 0, 0
        ));

        const startAtDate2 = new Date(Date.UTC(
          brasilAgora2.getUTCFullYear(),
          brasilAgora2.getUTCMonth(),
          brasilAgora2.getUTCDate(),
          3, 0, 0, 0
        ));

await DailyRanking.findOneAndUpdate(
  { data: hojeStr },
  {
    ranking: dailyFixedRanking,
    startAt: startAtDate2,
    expiresAt: brasilMidnightTomorrow2,
    criadoEm: new Date()
  },
  { upsert: true, new: true, setDefaultsOnInsert: true }
);

        console.log("💾 dailyFixedRanking salvo no DB (midnight reset) — somente dailyearnings/dailyrankings");
      } catch (e) {
        console.error("Erro ao salvar DailyRanking no DB (midnight):", e);
      }

horaInicioRanking = startAtDate2.getTime();
top3FixosHoje = dailyFixedRanking.slice(0, 3).map(u => ({ ...u }));
diaTop3 = hojeStr;
ultimoRanking = null;
ultimaAtualizacao = startAtDate2;
zeroedAtMidnight = true;

      const placeholder = dailyFixedRanking.map((d, i) => ({
        position: i + 1,
        username: d.username,
        total_balance: formatarValorRanking(d.real_total),
        is_current_user: !!d.is_current_user
      }));

      console.log("✅ Reset automático meia-noite — dailyFixedRanking:", dailyFixedRanking.map(d => d.username));
      return res.status(200).json({ ranking: placeholder });
    }

    // === 4) Cache check (mesmo dia e menos de CACHE_MS) ===
    if (ultimoRanking && agora - ultimaAtualizacao < CACHE_MS && diaTop3 === hoje) {
      return res.status(200).json({ ranking: ultimoRanking });
    }

    // === 5) Montagem do ranking base: prioriza dailyFixedRanking se definido para hoje, mas incorpora DailyEarning com PRIORIDADE ===
    let baseRankingRaw = null;

    if (dailyFixedRanking && diaTop3 === hoje) {
      // Clone do ranking fixo do dia (marca como source: 'fixed')
      const baseFromFixed = dailyFixedRanking.map((u) => ({
        username: (u.username || "Usuário").toString(),
        token: u.token || null,
        real_total: Number(u.real_total || 0),
        is_current_user: !!u.is_current_user,
        source: "fixed",
        userId: u.userId ? String(u.userId) : null
      }));

      // --- Busca ganhos reais do DB (DailyEarning)
      let ganhosPorUsuario = [];
      try {
        ganhosPorUsuario = await DailyEarning.aggregate([
          { $group: { _id: "$userId", totalGanhos: { $sum: "$valor" } } },
          { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "usuario" } },
          { $unwind: { path: "$usuario", preserveNullAndEmptyArrays: true } },
          {
            $project: {
              userId: "$_id",
              username: { $ifNull: ["$usuario.nome", "Usuário"] },
              token: { $ifNull: ["$usuario.token", null] },
              real_total: "$totalGanhos"
            }
          }
        ]);
      } catch (e) {
        console.error("Erro ao agregar DailyEarning durante fusão (prioridade):", e);
        ganhosPorUsuario = [];
      }

      // mapa + projeção (mantive sua lógica) - MELHORIA: map keys T:, I:, U: (token, userId, username)
      const mapa = new Map();
      const ganhosPorPosicao = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
      const perMinuteGain = ganhosPorPosicao.map(g => g / 10);
      const agoraMs = Date.now();
      const baseHoraInicio = horaInicioRanking || agoraMs;
      const intervalosDecorridos = Math.floor((agoraMs - baseHoraInicio) / (60 * 1000));
      console.log("📊 intervalosDecorridos (min):", intervalosDecorridos, "horaInicioRanking:", new Date(baseHoraInicio).toISOString());

      // popula mapa com chaves múltiplas quando possível para robustez
      baseFromFixed.forEach((u, idx) => {
        const keyToken = u.token ? `T:${String(u.token)}` : null;
        const keyId = u.userId ? `I:${String(u.userId)}` : null;
        const keyUname = `U:${norm(u.username)}`;
        const baseObj = {
          username: String(u.username || "Usuário"),
          token: u.token || null,
          real_total: Number(u.real_total || 0),
          source: "fixed",
          fixedPosition: idx,
          is_current_user: !!u.is_current_user,
          userId: u.userId || null
        };
        if (keyToken) mapa.set(keyToken, { ...baseObj });
        if (keyId) mapa.set(keyId, { ...baseObj });
        mapa.set(keyUname, { ...baseObj });
      });

      function findExistingKeyFor(item) {
        // procura por token -> userId -> username normalizado
        if (item.token) {
          const k = `T:${String(item.token)}`;
          if (mapa.has(k)) return k;
        }
        if (item.userId) {
          const k = `I:${String(item.userId)}`;
          if (mapa.has(k)) return k;
        }
        const uname = norm(item.username || "");
        const unameKey = `U:${uname}`;
        if (mapa.has(unameKey)) return unameKey;

        // fallback: tentar encontrar por username comparando valores armazenados
        for (const existingKey of mapa.keys()) {
          const ex = mapa.get(existingKey);
          if (ex && norm(ex.username) === uname) return existingKey;
        }
        return null;
      }

      ganhosPorUsuario.forEach(g => {
        const item = {
          username: String(g.username || "Usuário"),
          token: g.token || null,
          real_total: Number(g.real_total || 0),
          source: "earnings",
          userId: g.userId ? String(g.userId) : null,
          is_current_user: (g.token && g.token === effectiveToken) || false
        };

        const existingKey = findExistingKeyFor(item);
        if (existingKey) {
          const ex = mapa.get(existingKey);

          // se existir e for fixed, comparar com projected e manter maior
          if (ex && ex.source === "fixed") {
            const pos = (typeof ex.fixedPosition === "number") ? ex.fixedPosition : null;
            const incrementoPorMinuto = pos !== null ? (perMinuteGain[pos] || 0) : 0;
            const projectedFixed = Number(ex.real_total || 0) + incrementoPorMinuto * intervalosDecorridos;

            if (Number(item.real_total) >= projectedFixed) {
              // earnings supera projected fixed -> substitui
              mapa.set(existingKey, {
                username: item.username || ex.username,
                token: item.token || ex.token,
                real_total: Number(item.real_total),
                source: "earnings",
                userId: item.userId || ex.userId || null,
                is_current_user: ex.is_current_user || item.is_current_user
              });
            } else {
              // mantém fixed (com campo earnings_total para debug)
              ex.earnings_total = Number(item.real_total);
              mapa.set(existingKey, ex);
            }
          } else {
            // substitui/atualiza com dados de earnings
            mapa.set(existingKey, {
              username: item.username,
              token: item.token || (ex && ex.token) || null,
              real_total: Number(item.real_total),
              source: item.source,
              userId: item.userId || (ex && ex.userId) || null,
              is_current_user: (ex && ex.is_current_user) || item.is_current_user
            });
          }
        } else {
          // cria nova chave por token ou username normalizado
          const key = item.token ? `T:${String(item.token)}` : `U:${norm(item.username)}`;
          mapa.set(key, { ...item });
        }
      });

      // monta array projetado
      const listaComProjetado = Array.from(new Map(
        // garantir unicidade por username/token/userId: reduce para map por chave definitiva (token>id>username)
        Array.from(mapa.values()).map(e => {
          // chave definitiva
          const definitiveKey = e.token ? `T:${e.token}` : (e.userId ? `I:${e.userId}` : `U:${norm(e.username)}`);
          return [definitiveKey, e];
        })
      ).values()).map(entry => {
        const e = { ...entry };
        if (e.source === "fixed") {
          const pos = (typeof e.fixedPosition === "number") ? e.fixedPosition : null;
          const incrementoPorMinuto = pos !== null ? (perMinuteGain[pos] || 0) : 0;
          const projected = Number(e.real_total || 0) + incrementoPorMinuto * intervalosDecorridos;
          e.current_total = Number(projected);
        } else {
          e.current_total = Number(e.real_total || 0);
        }
        return e;
      });

      // preencher apenas com entradas salvas em DailyRanking (embaralhadas) quando faltar
if (listaComProjetado.length < 10) {
  const need = 10 - listaComProjetado.length;
  const used = new Set(listaComProjetado.map(x => norm(x.username)));
  for (const nm of fillerNames) {
    if (listaComProjetado.length >= 10) break;
    if (!used.has(norm(nm))) {
      const idxForBaseline = listaComProjetado.length;
      listaComProjetado.push({
        username: nm,
        token: null,
        real_total: Number(baselineValores[idxForBaseline] ?? 0),
        current_total: Number(baselineValores[idxForBaseline] ?? 0),
        source: "fixed",
        is_current_user: false,
        userId: null
      });
      used.add(norm(nm));
    }
  }
        // se ainda faltar, completar com fillerNames (não duplicar)
        if (listaComProjetado.length < 10) {
          const need = 10 - listaComProjetado.length;
          const used = new Set(listaComProjetado.map(x => norm(x.username)));
          for (const nm of fillerNames) {
            if (listaComProjetado.length >= 10) break;
            if (!used.has(norm(nm))) {
              listaComProjetado.push({
                username: nm,
                token: null,
                real_total: 0,
                current_total: 0,
                source: "filler",
                is_current_user: false,
                userId: null
              });
              used.add(norm(nm));
            }
          }
        }
      }

      // Ordena pelo valor projetado (current_total) DECRESCENTE e só então pega top10
      listaComProjetado.sort((a, b) => Number(b.current_total || b.real_total || 0) - Number(a.current_total || a.real_total || 0));

      console.log("DEBUG: top 12 after projection:", listaComProjetado.slice(0, 12).map((x, i) => `${i+1}=${x.username}:${(Number(x.current_total||x.real_total)||0).toFixed(2)}(src=${x.source})`));

      const top10 = listaComProjetado.slice(0, 10);

      function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

      baseRankingRaw = top10.map((item) => ({
        username: item.username,
        token: item.token || null,
        real_total: round2(Number(item.current_total || item.real_total || 0)),
        source: item.source || "unknown",
        is_current_user: !!item.is_current_user
      }));
    } else {
      // fallback original: gera a partir do DB (sem fixed) - mantém comportamento
      const ganhosPorUsuario = await DailyEarning.aggregate([
        { $group: { _id: "$userId", totalGanhos: { $sum: "$valor" } } },
        { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "usuario" } },
        { $unwind: { path: "$usuario", preserveNullAndEmptyArrays: true } },
        { $project: { userId: "$_id", username: { $ifNull: ["$usuario.nome", "Usuário"] }, total_balance: "$totalGanhos", token: { $ifNull: ["$usuario.token", null] } } },
        { $sort: { total_balance: -1 } },
        { $limit: 10 }
      ]);

      baseRankingRaw = (ganhosPorUsuario || [])
        .filter((item) => (item.total_balance ?? 0) > 0)
        .map((item) => ({
          username: item.username || "Usuário",
          token: item.token || null,
          real_total: Number(item.total_balance || 0),
          is_current_user: item.token === effectiveToken,
          source: "earnings"
        }));

      // completar apenas com DailyRanking salvo se necessário (embaralhado)
      if (baseRankingRaw.length < 10) {
        const saved = await DailyRanking.findOne({}).lean().catch(() => null);
        if (saved && Array.isArray(saved.ranking)) {
          const extrasShuffled = shuffleArray((saved.ranking || []).slice());
          for (const r of extrasShuffled) {
            if (baseRankingRaw.length >= 10) break;
            const uname = norm(r.username || r.nome || "Usuário");
            if (!baseRankingRaw.some(x => norm(x.username) === uname)) {
              baseRankingRaw.push({
                username: r.username || r.nome || "Usuário",
                token: r.token || null,
                real_total: Number(r.real_total || 0),
                is_current_user: false,
                source: "fixed_from_saved"
              });
            }
          }
        }
      }

      baseRankingRaw.sort((a, b) => Number(b.real_total) - Number(a.real_total));
    }

    // === 6) Limita a 10 posições ===
    let finalRankingRaw = (baseRankingRaw || []).slice(0, 10);

    // === 7) Formata e responde ===
    const formatter = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const finalRanking = finalRankingRaw.map((item, idx) => ({
      position: idx + 1,
      username: item.username,
      total_balance: formatter.format(Number(item.real_total || 0)),
      real_total: Number(item.real_total || 0),
      is_current_user: !!(item.token && item.token === effectiveToken),
      source: item.source || "unknown"
    }));

    // Atualiza cache
    ultimoRanking = finalRanking;
    ultimaAtualizacao = agora;
    zeroedAtMidnight = false;

    console.log("🔢 final top3 (numeros reais):", finalRanking.slice(0, 3).map(r => `${r.username}=${r.real_total}`));
    return res.status(200).json({ ranking: finalRanking });

  } catch (error) {
    console.error("❌ Erro ao buscar ranking:", error);
    return res.status(500).json({ error: "Erro interno ao buscar ranking" });
  }
});

export default router;
