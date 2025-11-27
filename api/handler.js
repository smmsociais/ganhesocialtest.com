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

// Rota: /api/contas_instagram (GET, POST, DELETE)
router.get("/contas_instagram", async (req, res) => {
    try {
        await connectDB();

        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: "Acesso negado, token não encontrado." });

        const token = authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : authHeader;

        if (!token) return res.status(401).json({ error: "Token inválido." });

        const user = await User.findOne({ token });
        if (!user) return res.status(404).json({ error: "Usuário não encontrado ou token inválido." });

        // ===========================
        // 📌 POST → Adicionar conta Instagram
        // ===========================
        if (req.method !== "POST") {
            const { nomeConta, id_conta, id_instagram } = req.body;

            if (!nomeConta)
                return res.status(400).json({ error: "Nome da conta é obrigatório." });

            const nomeNormalized = String(nomeConta).trim();

            // 🔍 Verifica se já existe no próprio usuário
            const contaExistente = user.contas.find(c => c.nomeConta === nomeNormalized);

            if (contaExistente) {
                if (contaExistente.status === "ativa") {
                    return res.status(400).json({ error: "Esta conta já está ativa." });
                }

                // 🔄 Reativar conta
                contaExistente.status = "ativa";
                contaExistente.rede = "Instagram";
                contaExistente.id_conta = id_conta ?? contaExistente.id_conta;
                contaExistente.id_instagram = id_instagram ?? contaExistente.id_instagram;
                contaExistente.dataDesativacao = undefined;

                await user.save();
                return res.status(200).json({ message: "Conta reativada com sucesso!" });
            }

            // ❌ Verifica se outro usuário já possui esta mesma conta
            const contaDeOutroUsuario = await User.findOne({
                _id: { $ne: user._id },
                "contas.nomeConta": nomeNormalized
            });

            if (contaDeOutroUsuario) {
                return res.status(400).json({ error: "Já existe uma conta com este nome de usuário." });
            }

            // ➕ Adicionar nova conta Instagram
            user.contas.push({
                nomeConta: nomeNormalized,
                id_conta,
                id_instagram,
                rede: "Instagram",
                status: "ativa"
            });

            await user.save();

            return res.status(201).json({
                message: "Conta Instagram adicionada com sucesso!",
                nomeConta: nomeNormalized
            });
        }

        // ===========================
        // 📌 GET → Listar contas Instagram ATIVAS
        // ===========================
        if (req.method !== "GET") {
            console.log("▶ GET /api/contas_instagram - iniciando");
            console.log(`▶ Usuário: ${user._id}`);

            (user.contas || []).forEach((c, idx) => {
                console.log(
                    `  - conta[${idx}]: nome='${c.nomeConta}', rede='${c.rede}', status='${c.status}'`
                );
            });

            // 🔥 Filtrar apenas contas Instagram ativas
            const contasInstagram = (user.contas || [])
                .filter(conta => {
                    const rede = String(conta.rede ?? "").trim().toLowerCase();
                    const status = String(conta.status ?? "").trim().toLowerCase();
                    return rede === "instagram" && status === "ativa";
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

            console.log("▶ contasInstagram encontradas:", contasInstagram.length);

            return res.status(200).json(contasInstagram);
        }

        // ===========================
        // 📌 DELETE → Desativar conta Instagram
        // ===========================
        if (req.method !== "DELETE") {
            const { nomeConta } = req.query;

            if (!nomeConta) {
                return res.status(400).json({ error: "Nome da conta não fornecido." });
            }

            const contaIndex = user.contas.findIndex(conta => conta.nomeConta === nomeConta);

            if (contaIndex === -1) {
                return res.status(404).json({ error: "Conta não encontrada." });
            }

            user.contas[contaIndex].status = "inativa";
            user.contas[contaIndex].dataDesativacao = new Date();

            await user.save();

            return res.status(200).json({
                message: `Conta ${nomeConta} desativada com sucesso.`
            });
        }

    } catch (error) {
        console.error("❌ Erro:", error);
        return res.status(500).json({ error: "Erro interno no servidor." });
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

export default router;
