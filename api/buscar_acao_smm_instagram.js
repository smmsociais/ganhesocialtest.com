// api/buscar_acao_smm_instagram.js
import connectDB from './db.js';
import mongoose from 'mongoose';
import { User, ActionHistory, Pedido } from "./schema.js";
import { getValorAcao } from "./handler.js";

const handler = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  const { token, tipo, nome_usuario, rede: redeQuery, debug } = req.query;

  console.log("➡️ Requisição recebida (Instagram):", { token: !!token, tipo, nome_usuario, redeQuery });

  if (!tipo || !token) {
    return res.status(400).json({ error: "tipo e token são obrigatórios" });
  }

  try {
    await connectDB();
    console.log("✅ Conexão com o banco estabelecida");

    const usuario = await User.findOne({ token });
    if (!usuario) {
      console.log("❌ Token inválido");
      return res.status(401).json({ error: "Token inválido" });
    }

    // Se foi passado nome_usuario, validar que pertence ao usuário (token)
    // Caso não seja passado, tentamos inferir quando o usuário tem apenas 1 conta vinculada.
    let contaSolicitante = null;
    if (nome_usuario) {
      const nomeLower = String(nome_usuario).trim().toLowerCase();
      const achou = Array.isArray(usuario.contas) && usuario.contas.some(c =>
        String(c.nome_usuario ?? c.nomeConta ?? "").toLowerCase() === nomeLower
      );
      if (!achou) {
        console.log("❌ Conta solicitante não pertence ao token:", nome_usuario);
        return res.status(401).json({ error: "Conta não vinculada ao token" });
      }
      contaSolicitante = String(nome_usuario).trim();
    } else {
      // inferir se o usuário tem exatamente 1 conta vinculada
      if (Array.isArray(usuario.contas) && usuario.contas.length === 1) {
        contaSolicitante = String(usuario.contas[0].nome_usuario ?? usuario.contas[0].nomeConta ?? '').trim();
        console.log(`ℹ Inferido nome_usuario = ${contaSolicitante} (1 conta encontrada)`);
      } else {
        // se não podemos inferir com segurança, pedir que o cliente passe o nome
        return res.status(400).json({ error: "nome_usuario é obrigatório quando o usuário tem múltiplas contas" });
      }
    }

    // Mapeamento dos tipos
    const tipoMap = { seguir: "seguir", curtir: "curtir" };
    const tipoBanco = tipoMap[(tipo || "").toString().toLowerCase()] || tipo;

    // rede: permitir override ?rede=instagram, ou usar 'instagram' por padrão
    const redeNormalized = typeof redeQuery === 'string' && redeQuery.trim().length
      ? redeQuery.trim()
      : 'instagram';

    // Query base para pedidos Instagram — não usamos mais reservas
    const query = {
      quantidade: { $gt: 0 },
      status: { $in: ["pendente"] },
      rede: { $regex: new RegExp(`^${redeNormalized}$`, 'i') } // aceita "Instagram", "instagram", etc.
    };

    if ((tipo || "").toString().toLowerCase() === "seguir_curtir") {
      query.tipo = { $in: ["seguir", "curtir"] };
    } else if (tipoBanco) {
      query.tipo = tipoBanco;
    }

    const pedidos = await Pedido.find(query).sort({ dataCriacao: -1 }).lean();
    console.log(`📦 ${pedidos.length} pedidos encontrados (Instagram)`);

    for (const pedido of pedidos) {
      // normalizar id como string
      const idPedidoStr = String(pedido._id);

      console.log("🔍 Verificando pedido:", {
        id_pedido: idPedidoStr,
        tipo: pedido.tipo,
        status: pedido.status,
        quantidade: pedido.quantidade,
        valor: pedido.valor,
        link: pedido.link,
        rede: pedido.rede
      });

      const quantidadePedido = Number(pedido.quantidade || 0);
      if (isNaN(quantidadePedido) || quantidadePedido <= 0) {
        console.log(`⚠ Ignorando pedido ${idPedidoStr} por quantidade inválida:`, pedido.quantidade);
        continue;
      }

      // 1) Total validadas (somente 'valida')
      const validadas = await ActionHistory.countDocuments({
        $and: [
          { $or: [{ id_pedido: idPedidoStr }, { id_action: idPedidoStr }] },
          { $or: [{ status: "valida" }, { acao_validada: "valida" }] }
        ]
      });
      if (validadas >= quantidadePedido) {
        console.log(`⛔ Pedido ${idPedidoStr} fechado — já tem ${validadas} validações.`);
        continue;
      }

      // 2) Conta pulou esse pedido?
      const nome = contaSolicitante;
      const pulada = await ActionHistory.findOne({
        $and: [
          { $or: [{ id_pedido: idPedidoStr }, { id_action: idPedidoStr }] },
          { nome_usuario: nome },
          { $or: [{ status: "pulada" }, { acao_validada: "pulada" }] }
        ]
      });
      if (pulada) {
        console.log(`🚫 Conta ${nome} pulou o pedido ${idPedidoStr}`);
        continue;
      }

      // 3) Conta já fez (pendente ou validada)
      const jaFez = await ActionHistory.findOne({
        $and: [
          { $or: [{ id_pedido: idPedidoStr }, { id_action: idPedidoStr }] },
          { nome_usuario: nome },
          { $or: [
              { status: { $in: ["pendente", "valida"] } },
              { acao_validada: { $in: ["pendente", "valida"] } }
            ]
          }
        ]
      });
      if (jaFez) {
        console.log(`🚫 Conta ${nome} já fez o pedido ${idPedidoStr}`);
        continue;
      }

      // 4) Quantas ações já foram feitas (inclui pendentes)
      const feitas = await ActionHistory.countDocuments({
        $and: [
          { $or: [{ id_pedido: idPedidoStr }, { id_action: idPedidoStr }] },
          { $or: [
              { status: { $in: ["pendente", "valida"] } },
              { acao_validada: { $in: ["pendente", "valida"] } }
            ]
          }
        ]
      });
      console.log(`📊 Ação ${idPedidoStr}: feitas=${feitas}, limite=${quantidadePedido}`);
      if (feitas >= quantidadePedido) {
        console.log(`⏩ Pedido ${idPedidoStr} atingiu o limite total.`);
        continue;
      }

      // 5) Extrair nome do usuário alvo do pedido (tolerante)
      let nomeUsuario = "";
      if (typeof pedido.link === 'string') {
        if (pedido.link.includes("@")) {
          nomeUsuario = pedido.link.split("@")[1].split(/[/?#]/)[0];
        } else {
          const m = pedido.link.match(/instagram\.com\/([^\/?#&]+)/i);
          if (m && m[1]) nomeUsuario = m[1].replace(/\/$/, "");
        }
      }

const valorParaEnviar = Number(getValorAcao(pedido, "Instagram"));

      return res.json({
        status: "ENCONTRADA",
        nome_usuario: nomeUsuario,
        valor: valorParaEnviar,
        url: pedido.link,
        tipo_acao: pedido.tipo,
        id_pedido: pedido._id,
        save_on_confirm: true
      });
    }

    console.log("📭 Nenhuma ação disponível");
    return res.json({ status: "NAO_ENCONTRADA" });

  } catch (error) {
    console.error("🔥 Erro ao buscar ação (Instagram):", error);
    return res.status(500).json({ error: "Erro interno" });
  }
};

export default handler;
