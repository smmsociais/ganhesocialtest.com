//handler.js

import axios from "axios";
import https from 'https';
import { v4 as uuidv4 } from 'uuid';
import connectDB from "./db.js";
import nodemailer from 'nodemailer';
import { sendRecoveryEmail } from "./mailer.js";
import crypto from "crypto";
import { User, ActionHistory, DailyEarning, Pedido, DailyRanking } from "./schema.js";
import express from "express";
import fs from "fs";

const router = express.Router();

// ROTA: /api/get_saldo (GET)
router.get("/get_saldo", async (req, res) => {
  try {
    await connectDB();

    const { token } = req.query;
    if (!token) {
      return res.status(400).json({ error: "Token obrigatório." });
    }

    const usuario = await User.findOne({ token }).select("saldo pix_key _id");
    if (!usuario) {
      return res.status(403).json({ error: "Acesso negado." });
    }

    // Busca ações pendentes (não validadas)
    const pendentes = await ActionHistory.find({
      user: usuario._id,
      acao_validada: "pendente"
    }).select("valor_confirmacao");

    const saldo_pendente = pendentes.reduce(
      (soma, acao) => soma + (acao.valor_confirmacao || 0),
      0
    );

    return res.status(200).json({
      saldo_disponivel:
        typeof usuario.saldo === "number" ? usuario.saldo : 0,
      saldo_pendente,
      pix_key: usuario.pix_key
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
      .find({ nome_usuario: nomeUsuarioParam, acao_validada: { $ne: "pulada" } })
      .sort({ data: -1 });
  
    const formattedData = historico.map(action => {
      let status;
      if (action.acao_validada === "valida") status = "Válida";
      else if (action.acao_validada === "invalida") status = "Inválida";
      else status = "Pendente";
  
      return {
        nome_usuario: action.nome_usuario,
        quantidade_pontos: action.quantidade_pontos,
        data: action.data,
        rede_social: action.rede_social,
        tipo: action.tipo,
        url: action.url,
        status
      };
    });
  
    return res.status(200).json(formattedData);
  }  

  try {
    const historico = await ActionHistory
      .find({ user: usuario._id, acao_validada: { $ne: "pulada" } })
      .sort({ data: -1 });

    const formattedData = historico.map(action => {
      let status;
      if (action.acao_validada === "valida") status = "Válida";
      else if (action.acao_validada === "invalida") status = "Inválida";
      else status = "Pendente";

      return {
        nome_usuario: action.nome_usuario,
        quantidade_pontos: action.quantidade_pontos,
        data: action.data,
        rede_social: action.rede_social,
        tipo: action.tipo,
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

      const valorFinal = pedido.valor
        ? String(pedido.valor)
        : (pedido.tipo === "curtir" ? "0.001" : "0.006");

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
router.get("/tiktok/confirm_action", async (req, res) => {
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

    // Valor da ação
    const valorFinal = tipo_acao === "curtir" ? 0.001 : 0.006;

    // URL do perfil alvo
    const url_dir = pedidoLocal.link;

    // Criar registro no histórico
    const newAction = new ActionHistory({
      user: usuario._id,
      token,
      nome_usuario,
      tipo_acao,
      tipo: tipo_acao,
      quantidade_pontos: valorFinal,
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

export default router;
