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
export default router;
