// api/buscar_acao_smm_tiktok.js
import connectDB from './db.js';
import mongoose from 'mongoose';
import { User, ActionHistory, Pedido } from "./schema.js";

const handler = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  const { token, tipo, nome_usuario } = req.query;

  console.log("➡️ Requisição recebida:");
  console.log("token:", token ? `***${String(token).slice(-6)}` : null);
  console.log("tipo:", tipo);
  console.log("nome_usuario:", nome_usuario);

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
    }

    // Mapeamento dos tipos
    const tipoMap = { seguir: "seguir", curtir: "curtir" };
    const tipoBanco = tipoMap[tipo] || tipo;

    // Query base para pedidos TikTok
    const query = {
      quantidade: { $gt: 0 },
      status: { $in: ["pendente", "reservada"] }, // pedidos ainda aceitáveis
      rede: { $regex: /^tiktok$/i }
    };

    if (tipo === "seguir_curtir") {
      query.tipo = { $in: ["seguir", "curtir"] };
    } else if (tipoBanco) {
      query.tipo = tipoBanco;
    }

    const pedidos = await Pedido.find(query).sort({ dataCriacao: -1 }).lean();
    console.log(`📦 ${pedidos.length} pedidos encontrados (TikTok)`);

    for (const pedido of pedidos) {
      const id_pedido = pedido._id;
      const idPedidoStr = String(id_pedido);
      console.log("🔍 Verificando pedido:", {
        id_pedido: idPedidoStr,
        tipo: pedido.tipo,
        status: pedido.status,
        quantidade: pedido.quantidade,
        valor: pedido.valor,
        link: pedido.link,
        rede: pedido.rede
      });

      // 1) Total validadas (somente 'valida')
      const validadas = await ActionHistory.countDocuments({
        $or: [{ id_pedido }, { id_action: idPedidoStr }],
        $or: [{ status: "valida" }, { acao_validada: "valida" }]
      });
      if (validadas >= (Number(pedido.quantidade) || 0)) {
        console.log(`⛔ Pedido ${idPedidoStr} fechado — já tem ${validadas} validações.`);
        continue;
      }

      // 2) Total feitas (pendente + reservada + valida)
      const feitas = await ActionHistory.countDocuments({
        $or: [{ id_pedido }, { id_action: idPedidoStr }],
        $or: [
          { status: { $in: ["pendente", "reservada", "valida"] } },
          { acao_validada: { $in: ["pendente", "reservada", "valida"] } }
        ]
      });
      console.log(`📊 Ação ${idPedidoStr}: feitas=${feitas}, limite=${pedido.quantidade}`);
      if (feitas >= (Number(pedido.quantidade) || 0)) {
        console.log(`⏩ Pedido ${idPedidoStr} atingiu o limite total.`);
        continue;
      }

      // 3) Verificar se a conta solicitante pulou/ja fez/reservou essa ação (quando fornecida)
      if (contaSolicitante) {
        const nome = contaSolicitante;

        // pulada?
        const pulada = await ActionHistory.findOne({
          $or: [{ id_pedido }, { id_action: idPedidoStr }],
          nome_usuario: nome,
          $or: [{ status: "pulada" }, { acao_validada: "pulada" }]
        });
        if (pulada) {
          console.log(`🚫 Conta ${nome} pulou o pedido ${idPedidoStr}`);
          continue;
        }

        // já fez / pendente / reservada?
        const jaFez = await ActionHistory.findOne({
          $or: [{ id_pedido }, { id_action: idPedidoStr }],
          nome_usuario: nome,
          $or: [
            { status: { $in: ["pendente", "reservada", "valida"] } },
            { acao_validada: { $in: ["pendente", "reservada", "valida"] } }
          ]
        });
        if (jaFez) {
          console.log(`🚫 Conta ${nome} já fez/reservou o pedido ${idPedidoStr}`);
          continue;
        }
      }

      // 4) Também verificar se o pedido foi pulado por qualquer conta? (opcional)
      // (Já temos pulada global? Se quiser manter global, descomente abaixo)
      // const puladaGlobal = await ActionHistory.findOne({ id_pedido, status: "pulada" });
      // if (puladaGlobal) continue;

      // 5) Extrair nome do usuário alvo do pedido
      let nomeUsuario = "";
      if (typeof pedido.link === "string") {
        if (pedido.link.includes("@")) {
          nomeUsuario = pedido.link.split("@")[1].split(/[/?#]/)[0];
        } else {
          const m = pedido.link.match(/tiktok\.com\/@?([^\/?#&]+)/i);
          if (m && m[1]) nomeUsuario = m[1].replace(/\/$/, "");
        }
      }

      // determina valor padrão por tipo (seguir -> 0.006, curtir -> 0.001)
      const tipoPedido = (pedido.tipo || "").toString().toLowerCase();
      let valorParaEnviar = 0;
      if (typeof pedido.valor === "number" && pedido.valor > 0) {
        valorParaEnviar = Number(pedido.valor);
      } else {
        if (tipoPedido === "seguir") {
          valorParaEnviar = 0.006;
        } else if (tipoPedido === "curtir") {
          valorParaEnviar = 0.001;
        } else if (tipoPedido === "seguir_curtir") {
          valorParaEnviar = 0.006;
        } else {
          valorParaEnviar = 0.006;
        }
      }
      valorParaEnviar = Number(valorParaEnviar.toFixed(3));

      // 6) Criar reserva para a conta solicitante (se fornecida). Se não houver conta solicitante,
      //    apenas retorna a ação sem criar reserva (comportamento antigo).
      if (contaSolicitante) {
        const nome = contaSolicitante;

        // checar se já existe reserva (por segurança)
        const reservaExistente = await ActionHistory.findOne({
          $or: [{ id_pedido }, { id_action: idPedidoStr }],
          nome_usuario: nome,
          $or: [{ status: "reservada" }, { acao_validada: "reservada" }]
        });

        if (reservaExistente) {
          console.log(`⚠ Conta ${nome} já tem reserva para pedido ${idPedidoStr} — pulando.`);
          continue;
        }

        // Criar uma reserva (documento) — usado para evitar race conditions simples
        try {
          const reserva = new ActionHistory({
            user: usuario._id,
            token: usuario.token,
            nome_usuario: nome,
            id_pedido: pedido._id,
            id_action: idPedidoStr,
            url: pedido.link,
            tipo_acao: pedido.tipo,
            quantidade_pontos: pedido.valor ?? null,
            valor: valorParaEnviar,
            tipo: pedido.tipo,
            rede_social: pedido.rede,
            status: "reservada",
            acao_validada: "reservada",
            data: new Date()
          });

          await reserva.save();
          console.log(`🔒 Reserva criada para conta ${nome} no pedido ${idPedidoStr}`);
        } catch (err) {
          // se falhar ao criar reserva, continua para próximo pedido
          console.warn("Falha ao criar reserva (ignorar e tentar próximo pedido):", err);
          continue;
        }

        // retorna a ação já reservada
        return res.json({
          status: "ENCONTRADA",
          nome_usuario: nomeUsuario,
          valor: valorParaEnviar,
          url: pedido.link,
          tipo_acao: pedido.tipo,
          id_pedido: pedido._id
        });

      } else {
        // Sem conta solicitante: retorna sem criar reserva (compatibilidade com fluxo antigo)
        return res.json({
          status: "ENCONTRADA",
          nome_usuario: nomeUsuario,
          valor: valorParaEnviar,
          url: pedido.link,
          tipo_acao: pedido.tipo,
          id_pedido: pedido._id
        });
      }
    } // end for

    console.log("📭 Nenhuma ação disponível");
    return res.json({ status: "NAO_ENCONTRADA" });

  } catch (error) {
    console.error("🔥 Erro ao buscar ação:", error);
    return res.status(500).json({ error: "Erro interno" });
  }
};

export default handler;
