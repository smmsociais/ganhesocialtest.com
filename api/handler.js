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
    logToFile("➡️ /get_saldo chamado com token: " + req.query.token);
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

export default router;
