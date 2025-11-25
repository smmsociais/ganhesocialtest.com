import axios from "axios";
import https from 'https';
import { v4 as uuidv4 } from 'uuid';
import connectDB from "./db.js";
import nodemailer from 'nodemailer';
import { sendRecoveryEmail } from "./mailer.js";
import crypto from "crypto";
import { User, ActionHistory, DailyEarning, Pedido, DailyRanking } from "./schema.js";

console.log(">>> MONGODB_URI:", process.env.MONGODB_URI);

// ===== Variáveis globais (colocar no topo do arquivo, fora do handler) =====
let ultimoRanking = null;
let ultimaAtualizacao = 0;
let top3FixosHoje = null;
let diaTop3 = null;
let horaInicioRanking = null;
let zeroedAtMidnight = false;
let dailyFixedRanking = null;

// ---- HELPERS E CONSTANTES GLOBAIS (apenas uma vez) ----
function norm(s) { return String(s || "").trim().toLowerCase(); }

function shuffleArray(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// baseline consistente usada sempre que preencher com nomes (10 posições)
const baselineValores = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3];


export default async function handler(req, res) {
    const { method, url, query } = req;

    // 🚨 RESET MANUAL DO RANKING (via variável de ambiente OU parâmetro na URL)
    const resetPorEnv = process.env.RESET_RANKING === 'true';
    const resetPorURL = query?.reset === 'true';

if (resetPorEnv || resetPorURL) {
    await connectDB(); // garante conexão antes de limpar o banco

    // 🧹 Limpa todos os ganhos diários (zera saldos)
    const resultado = await DailyEarning.deleteMany({});
    console.log(`🧾 ${resultado.deletedCount} registros de ganhos diários removidos.`);

    // 🧠 Limpa cache do ranking
    ultimoRanking = null;
    ultimaAtualizacao = 0;
    top3FixosHoje = null;
    diaTop3 = null;
    horaInicioRanking = Date.now();
    console.log("🔥 Ranking e saldos reiniciados manualmente", resetPorEnv ? "(via ENV)" : "(via URL)");

    if (resetPorURL) {
        return res.status(200).json({
            success: true,
            message: `Ranking e saldos zerados (${resultado.deletedCount} ganhos removidos).`
        });
    }
}
    async function salvarAcaoComLimitePorUsuario(novaAcao) {
        const LIMITE = 2000;
        const total = await ActionHistory.countDocuments({ user: novaAcao.user });

        if (total >= LIMITE) {
            const excess = total - LIMITE + 1;
            await ActionHistory.find({ user: novaAcao.user })
                .sort({ createdAt: 1 })
                .limit(excess)
                .deleteMany();
        }

        await novaAcao.save();
    }

    const formatarValorRanking = (valor) => {
        if (valor <= 1) return "1+";
        if (valor > 1 && valor < 5) return "1+";
        if (valor < 10) return "5+";
        if (valor < 50) return "10+";
        if (valor < 100) return "50+";
        if (valor < 500) return "100+";
        if (valor < 1000) return "500+";
        const base = Math.floor(valor / 1000) * 1000;
        return `${base}+`;
    };


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

const norm = (s) => String(s || "").trim().toLowerCase();

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Rota: /api/contas_instagram (GET, POST, DELETE)
if (url.startsWith("/api/contas_instagram")) {
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
        if (method === "POST") {
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
        if (method === "GET") {
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
        if (method === "DELETE") {
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
}

// Rota: /api/contas_tiktok (GET, POST, DELETE)
if (url.startsWith("/api/contas_tiktok")) {
    try {
        await connectDB();

        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: "Acesso negado, token não encontrado." });

        const token = authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : authHeader;
        console.log("🔹 Token recebido:", token);

        if (!token) return res.status(401).json({ error: "Token inválido." });

        const user = await User.findOne({ token });
        if (!user) return res.status(404).json({ error: "Usuário não encontrado ou token inválido." });

        // ===========================
        // 📌 POST → Adicionar conta
        // ===========================
        if (method === "POST") {
            const { nomeConta, id_conta, id_tiktok } = req.body;

            if (!nomeConta) {
                return res.status(400).json({ error: "Nome da conta é obrigatório." });
            }

            const nomeNormalized = String(nomeConta).trim();

            // 🔍 Verifica se a conta já existe no próprio usuário
            const contaExistente = user.contas.find(c => c.nomeConta === nomeNormalized);

            if (contaExistente) {
                if (contaExistente.status === "ativa") {
                    return res.status(400).json({ error: "Esta conta já está ativa." });
                }

                // 🔄 Reativar conta
                contaExistente.status = "ativa";
                contaExistente.rede = "TikTok"; // 🔥 Garantir que a conta tenha rede correta
                contaExistente.id_conta = id_conta ?? contaExistente.id_conta;
                contaExistente.id_tiktok = id_tiktok ?? contaExistente.id_tiktok;
                contaExistente.dataDesativacao = undefined;

                await user.save();
                return res.status(200).json({ message: "Conta reativada com sucesso!" });
            }

            // ❌ Verifica se outro usuário já tem esta conta
            const contaDeOutroUsuario = await User.findOne({
                _id: { $ne: user._id },
                "contas.nomeConta": nomeNormalized
            });

            if (contaDeOutroUsuario) {
                return res.status(400).json({ error: "Já existe uma conta com este nome de usuário." });
            }

            // ➕ Adiciona nova conta TikTok
            user.contas.push({
                nomeConta: nomeNormalized,
                id_conta,
                id_tiktok,
                rede: "TikTok",  // 🔥 Definindo rede
                status: "ativa"
            });

            await user.save();

            return res.status(201).json({
                message: "Conta adicionada com sucesso!",
                nomeConta: nomeNormalized
            });
        }
    
// ===========================
// 📌 GET → Listar contas TikTok ATIVAS
// ===========================

if (method === "GET") {
    console.log("▶ GET /api/contas_tiktok - iniciando");
    console.log("▶ Token usado:", token);

    if (!user) {
        console.log("⚠ Usuário não encontrado para token:", token);
        return res.status(404).json([]);
    }

    console.log(`▶ user ${user._id} tem ${Array.isArray(user.contas) ? user.contas.length : 0} contas`);

    (user.contas || []).forEach((c, idx) => {
        console.log(
            `  - conta[${idx}].nomeConta='${c.nomeConta}', rede='${String(c.rede ?? "")}', status='${String(c.status ?? "")}'`
        );
    });

    // 🔥 AGORA FILTRA SOMENTE CONTAS TIKTOK *ATIVAS*
    const contasTikTok = (user.contas || [])
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

    console.log("▶ contasTikTok encontradas:", contasTikTok.length, contasTikTok.map(c => c.nomeConta));

    return res.status(200).json(contasTikTok);
}
        // ===========================
        // 📌 DELETE → Desativar conta
        // ===========================
        if (method === "DELETE") {
            const { nomeConta } = req.query;

            if (!nomeConta) {
                return res.status(400).json({ error: "Nome da conta não fornecido." });
            }

            console.log("🔹 Nome da conta recebido para exclusão:", nomeConta);

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
}

// Rota: /api/profile (GET ou PUT)
if (url.startsWith("/api/profile")) {
  if (method !== "GET" && method !== "PUT") {
    return res.status(405).json({ error: "Método não permitido." });
  }

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

    if (method === "GET") {
      let actionHistory = null;

      if (usuario.historico_acoes?.length > 0) {
        actionHistory = await ActionHistory.findOne({
          _id: { $in: usuario.historico_acoes }
        }).sort({ data: -1 });
      }

      return res.status(200).json({
        nome_usuario: usuario.nome,
        email: usuario.email,
        token: usuario.token
      });
    }

    if (method === "PUT") {
      const { nome_usuario, email, senha } = req.body;

      const updateFields = { nome: nome_usuario, email };
      if (senha) {
        updateFields.senha = senha; // ⚠️ Criptografar se necessário
      }

      const usuarioAtualizado = await User.findOneAndUpdate(
        { token },
        updateFields,
        { new: true }
      );

      if (!usuarioAtualizado) {
        return res.status(404).json({ error: "Usuário não encontrado." });
      }

      return res.status(200).json({ message: "Perfil atualizado com sucesso!" });
    }
  } catch (error) {
    console.error("💥 Erro ao processar /profile:", error);
    return res.status(500).json({ error: "Erro ao processar perfil." });
  }
}

// Rota: /api/historico_acoes (GET)
if (url.startsWith("/api/historico_acoes")) {
  if (method !== "GET") {
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
}

// Rota: /api/get_saldo (GET)
if (url.startsWith("/api/get_saldo")) {
    if (method !== "GET") {
        return res.status(405).json({ error: "Método não permitido." });
    }

    await connectDB();

    const { token } = req.query;
    if (!token) {
        return res.status(400).json({ error: "Token obrigatório." });
    }

    try {
        const usuario = await User.findOne({ token }).select("saldo pix_key _id");
        if (!usuario) {
            return res.status(403).json({ error: "Acesso negado." });
        }
        
        // calcula o saldo pendente com base nas ações ainda não validadas
        const pendentes = await ActionHistory.find({
            user: usuario._id,
            acao_validada: "pendente"
        }).select("valor_confirmacao");
        
        const saldo_pendente = pendentes.reduce((soma, acao) => soma + (acao.valor_confirmacao || 0), 0);
        
        return res.status(200).json({
            saldo_disponivel: typeof usuario.saldo === "number" ? usuario.saldo : 0,
            saldo_pendente,
            pix_key: usuario.pix_key
        });
        
    } catch (error) {
        console.error("💥 Erro ao obter saldo:", error);
        return res.status(500).json({ error: "Erro ao buscar saldo." });
    }
}

// Rota: /api/login
if (url.startsWith("/api/login")) {
        if (req.method !== "POST") {
            return res.status(405).json({ error: "Método não permitido" });
        }
    
        try {
            await connectDB();
    
            const { email, senha } = req.body;
    
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
    };

if (url.startsWith("/api/signup") && method === "POST") {
  await connectDB();

  const { email, senha, ref } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ error: "Todos os campos são obrigatórios." });
  }

  try {

    // ✅ Verifica se e-mail já existe
    const emailExiste = await User.findOne({ email });
    if (emailExiste) return res.status(400).json({ error: "E-mail já cadastrado." });

    // ✅ Gera token obrigatório
    const token = crypto.randomBytes(32).toString("hex");

    // ✅ Função para gerar código de afiliado numérico (8 dígitos)
    const gerarCodigo = () =>
      Math.floor(10000000 + Math.random() * 90000000).toString();

    // Retentativa para evitar colisão de código
    const maxRetries = 5;
    let attempt = 0;
    let savedUser = null;

    while (attempt < maxRetries && !savedUser) {
      const codigo_afiliado = gerarCodigo();

      // Novo usuário
      const ativo_ate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 dias de ativo
      const novoUsuario = new User({
        email,
        senha,
        token,
        codigo_afiliado,
        status: "ativo",
        ativo_ate,
        indicado_por: ref || null, // vincula ao código do afiliado, se houver
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
      return res.status(500).json({ error: "Não foi possível gerar um código de afiliado único. Tente novamente." });
    }

    return res.status(201).json({
      message: "Usuário registrado com sucesso!",
      token: savedUser.token,
      codigo_afiliado: savedUser.codigo_afiliado,
      id: savedUser._id,
    });

  } catch (error) {
    console.error("Erro ao cadastrar usuário:", error);
    if (error?.code === 11000 && error.keyPattern?.email) {
      return res.status(400).json({ error: "E-mail já cadastrado." });
    }
    return res.status(500).json({ error: "Erro interno ao registrar usuário. Tente novamente mais tarde." });
  }
}

// Rota: /api/change-password
if (url.startsWith("/api/change-password")) {
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
    }; 

 // Rota: /api/recover-password
if (url.startsWith("/api/recover-password")) { 
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

    const link = `https://ganhesocial.com/reset-password?token=${token}`;
    await sendRecoveryEmail(email, link);

    return res.status(200).json({ message: "Link enviado com sucesso" });
  } catch (err) {
    console.error("Erro em recover-password:", err);
    return res.status(500).json({ error: "Erro interno no servidor" });
  }
}

 // Rota: api/validate-reset-token
 if (url.startsWith("/api/validate-reset-token")) { 
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
    };

// 🔹 Rota: /api/withdraw
if (url.startsWith("/api/withdraw")) {
  if (method !== "GET" && method !== "POST") {
    console.log("[DEBUG] Método não permitido:", method);
    return res.status(405).json({ error: "Método não permitido." });
  }

  const OPENPIX_API_KEY = process.env.OPENPIX_API_KEY;
  const OPENPIX_API_URL = process.env.OPENPIX_API_URL || "https://api.openpix.com.br";

  // conecta DB (assume função global connectDB e modelo User)
  await connectDB();

  // 🔹 Autenticação
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    console.log("[DEBUG] Token ausente ou inválido:", authHeader);
    return res.status(401).json({ error: "Token ausente ou inválido." });
  }
  const token = authHeader.split(" ")[1];
  const user = await User.findOne({ token });
  if (!user) {
    console.log("[DEBUG] Usuário não encontrado para token:", token);
    return res.status(401).json({ error: "Usuário não autenticado." });
  }

  try {
    if (method === "GET") {
      const saquesFormatados = (user.saques || []).map(s => ({
        amount: s.valor ?? s.amount ?? null,
        pixKey: s.chave_pix ?? s.pixKey ?? null,
        keyType: s.tipo_chave ?? s.keyType ?? null,
        status: s.status ?? null,
        date: s.data ? (s.data instanceof Date ? s.data.toISOString() : new Date(s.data).toISOString()) : null,
        externalReference: s.externalReference || null,
        providerId: s.providerId || s.wooviId || s.openpixId || null,
      }));
      console.log("[DEBUG] Histórico de saques retornado:", saquesFormatados);
      return res.status(200).json(saquesFormatados);
    }

    // ===== POST =====
    // Normaliza body (compatível com body já parseado ou string)
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (e) { /* keep as-is */ }
    }

    const { amount, payment_method, payment_data } = body || {};
    console.log("[DEBUG] Dados recebidos para saque:", { amount, payment_method, payment_data });

    // Validações básicas
    if (!amount || (typeof amount !== "number" && typeof amount !== "string")) {
      console.log("[DEBUG] Valor de saque inválido:", amount);
      return res.status(400).json({ error: "Valor de saque inválido (mínimo R$0,01)." });
    }
    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      console.log("[DEBUG] Valor de saque inválido após parse:", amountNum);
      return res.status(400).json({ error: "Valor de saque inválido." });
    }

    if (!payment_method || !payment_data?.pix_key || !payment_data?.pix_key_type) {
      console.log("[DEBUG] Dados de pagamento incompletos:", payment_data);
      return res.status(400).json({ error: "Dados de pagamento incompletos." });
    }

    // Verifica saldo (assumindo user.saldo em reais)
    if ((user.saldo ?? 0) < amountNum) {
      console.log("[DEBUG] Saldo insuficiente:", { saldo: user.saldo, amount: amountNum });
      return res.status(400).json({ error: "Saldo insuficiente." });
    }

    // Permitir apenas CPF por enquanto (ajuste se quiser permitir outros)
    const allowedTypes = ["CPF"];
    const keyType = (payment_data.pix_key_type || "").toUpperCase();
    if (!allowedTypes.includes(keyType)) {
      console.log("[DEBUG] Tipo de chave PIX inválido:", keyType);
      return res.status(400).json({ error: "Tipo de chave PIX inválido." });
    }

    // Formata chave
    let pixKey = String(payment_data.pix_key || "");
    if (keyType === "CPF" || keyType === "CNPJ") pixKey = pixKey.replace(/\D/g, "");
    console.log("[DEBUG] Chave PIX formatada:", pixKey);

    // Salva PIX do usuário se ainda não existir; se existir e diferente, bloqueia
    if (!user.pix_key) {
      user.pix_key = pixKey;
      user.pix_key_type = keyType;
      console.log("[DEBUG] Chave PIX salva no usuário:", { pixKey, keyType });
    } else if (user.pix_key !== pixKey) {
      console.log("[DEBUG] Chave PIX diferente da cadastrada:", { userPix: user.pix_key, novaPix: pixKey });
      return res.status(400).json({ error: "Chave PIX já cadastrada e não pode ser alterada." });
    }

    // Cria externalReference único
    const externalReference = `saque_${user._id}_${Date.now()}`;
    console.log("[DEBUG] externalReference gerada:", externalReference);

    // Monta objeto de saque e atualiza saldo & array (marca PENDING inicialmente)
    const novoSaque = {
      valor: amountNum,
      chave_pix: pixKey,
      tipo_chave: keyType,
      status: "PENDING",
      data: new Date(),
      providerId: null,
      externalReference,
      ownerName: user.name || user.nome || "Usuário",
    };

    // Deduz saldo e armazena saque
    user.saldo = (user.saldo ?? 0) - amountNum;
    user.saques = user.saques || [];
    user.saques.push(novoSaque);
    await user.save();
    console.log("[DEBUG] Usuário atualizado com novo saque. Saldo agora:", user.saldo);

    // ===== Comunica com o provedor OpenPix (create -> approve) =====
    const valueInCents = Math.round(amountNum * 100);

    if (!OPENPIX_API_KEY) {
      console.error("[ERROR] OPENPIX_API_KEY não configurada");
      // restaura saldo e marca erro
      const idxErr0 = user.saques.findIndex(s => s.externalReference === externalReference);
      if (idxErr0 >= 0) {
        user.saques[idxErr0].status = "FAILED";
        user.saques[idxErr0].error = { msg: "OPENPIX_API_KEY não configurada" };
        user.saldo += amountNum;
        await user.save();
      }
      return res.status(500).json({ error: "Configuração do provedor ausente." });
    }

    const createHeaders = {
      "Content-Type": "application/json",
      "Authorization": OPENPIX_API_KEY,
      "Idempotency-Key": externalReference
    };

    const createPayload = {
      value: valueInCents,
      destinationAlias: pixKey,
      destinationAliasType: keyType,
      correlationID: externalReference,
      comment: `Saque para ${user._id}`
    };

    console.log("[DEBUG] Payload createPayment enviado ao OpenPix:", createPayload);

    // Faz create payment
    let createRes;
    try {
      createRes = await fetch(`${OPENPIX_API_URL}/api/v1/payment`, {
        method: "POST",
        headers: createHeaders,
        body: JSON.stringify(createPayload)
      });
    } catch (err) {
      console.error("[ERROR] Falha na requisição createPayment:", err);
      // marca erro no saque e restaura saldo
      const idxErr = user.saques.findIndex(s => s.externalReference === externalReference);
      if (idxErr >= 0) {
        user.saques[idxErr].status = "FAILED";
        user.saques[idxErr].error = { msg: "Falha na requisição createPayment", detail: err.message };
        user.saldo += amountNum; // restaura saldo
        await user.save();
      }
      return res.status(500).json({ error: "Erro ao comunicar com o provedor de pagamentos." });
    }

    const createText = await createRes.text();
    let createData;
    try { createData = JSON.parse(createText); } catch (err) {
      console.error("[ERROR] Resposta createPayment não-JSON:", createText);
      // restaura saldo e marca erro
      const idx = user.saques.findIndex(s => s.externalReference === externalReference);
      if (idx >= 0) {
        user.saques[idx].status = "FAILED";
        user.saques[idx].error = { msg: "Resposta createPayment inválida", raw: createText };
        user.saldo += amountNum;
        await user.save();
      }
      return res.status(createRes.status || 500).json({ error: createText });
    }

    console.log("[DEBUG] Resposta createPayment:", createData, "Status HTTP:", createRes.status);

    if (!createRes.ok) {
      console.error("[DEBUG] Erro createPayment:", createData);
      // marca erro no saque e restaura saldo
      const idxErr = user.saques.findIndex(s => s.externalReference === externalReference);
      if (idxErr >= 0) {
        user.saques[idxErr].status = "FAILED";
        user.saques[idxErr].error = createData;
        user.saldo += amountNum;
        await user.save();
      }

      if (createRes.status === 403) {
        return res.status(403).json({ error: createData.error || createData.message || "Recurso não habilitado." });
      }

      return res.status(400).json({ error: createData.message || createData.error || "Erro ao criar pagamento no provedor." });
    }

    // Extrai possíveis identificadores úteis
    const paymentId = createData.id || createData.paymentId || createData.payment_id || createData.transaction?.id || null;
    const returnedCorrelation = createData.correlationID || createData.correlationId || createData.correlation || null;

    console.log("[DEBUG] paymentId extraído:", paymentId, "correlation retornada:", returnedCorrelation);

    // Atualiza o saque com providerId/correlation, mantendo status PENDING
    const createdIndex = user.saques.findIndex(s => s.externalReference === externalReference);
    if (createdIndex >= 0) {
      if (paymentId) user.saques[createdIndex].providerId = paymentId;
      if (!user.saques[createdIndex].externalReference) user.saques[createdIndex].externalReference = externalReference;
      user.saques[createdIndex].status = "PENDING";
      await user.save();
    }

    // Decide identificador para aprovação
    const toApproveIdentifier = paymentId || returnedCorrelation || externalReference;

    if (!toApproveIdentifier) {
      console.warn("[WARN] createPayment não retornou identificador usável — saque permanece PENDING.");
      return res.status(200).json({
        message: "Saque criado, aguardando aprovação manual (identificador não retornado).",
        create: createData
      });
    }

    // ===== Approve =====
    const approveHeaders = {
      "Content-Type": "application/json",
      "Authorization": OPENPIX_API_KEY,
      "Idempotency-Key": `approve_${toApproveIdentifier}`
    };

    const approvePayload = paymentId ? { paymentId } : { correlationID: toApproveIdentifier };
    console.log("[DEBUG] Enviando approvePayment:", approvePayload);

    let approveRes;
    try {
      approveRes = await fetch(`${OPENPIX_API_URL}/api/v1/payment/approve`, {
        method: "POST",
        headers: approveHeaders,
        body: JSON.stringify(approvePayload)
      });
    } catch (err) {
      console.error("[ERROR] Falha na requisição approvePayment:", err);
      if (createdIndex >= 0) {
        user.saques[createdIndex].status = "PENDING_APPROVAL";
        user.saques[createdIndex].error = { msg: "Falha na requisição de aprovação", detail: err.message };
        await user.save();
      }
      return res.status(500).json({ error: "Erro ao aprovar pagamento (comunicação com provedor)." });
    }

    const approveText = await approveRes.text();
    let approveData;
    try { approveData = JSON.parse(approveText); } catch (err) {
      console.error("[ERROR] Resposta approvePayment não-JSON:", approveText);
      if (createdIndex >= 0) {
        user.saques[createdIndex].status = "PENDING_APPROVAL";
        user.saques[createdIndex].error = { msg: "Resposta de aprovação inválida", raw: approveText };
        await user.save();
      }
      return res.status(approveRes.status || 500).json({ error: approveText });
    }

    console.log("[DEBUG] Resposta approvePayment:", approveData, "Status HTTP:", approveRes.status);

    if (!approveRes.ok) {
      console.error("[DEBUG] Erro approvePayment:", approveData);
      if (approveRes.status === 403) {
        if (createdIndex >= 0) {
          user.saques[createdIndex].status = "PENDING_APPROVAL";
          user.saques[createdIndex].error = approveData;
          await user.save();
        }
        return res.status(403).json({ error: approveData.error || approveData.message || "Aprovação negada." });
      }

      if (createdIndex >= 0) {
        user.saques[createdIndex].status = "PENDING_APPROVAL";
        user.saques[createdIndex].error = approveData;
        await user.save();
      }
      return res.status(400).json({ error: approveData.message || approveData.error || "Erro ao aprovar pagamento." });
    }

    // Se approve ok -> atualiza status conforme retorno
    const approveStatus = approveData.status || approveData.transaction?.status || "COMPLETED";
    if (createdIndex >= 0) {
      user.saques[createdIndex].status = (approveStatus === "COMPLETED" || approveStatus === "EXECUTED") ? "COMPLETED" : approveStatus;
      user.saques[createdIndex].providerId = user.saques[createdIndex].providerId || paymentId || approveData.id || null;
      await user.save();
    }

    // ===== Processar comissão de afiliado (5%) se saque COMPLETED =====
    try {
      const COMMISSION_RATE = 0.05;
      const isCompleted = approveStatus === "COMPLETED" || approveStatus === "EXECUTED";
      if (isCompleted) {
        // Recarrega user para garantir dados atualizados (opcional)
        const saqueRecord = (user.saques || []).find(s => s.externalReference === externalReference || s.providerId === (paymentId || null));
        const saqueValor = saqueRecord ? (saqueRecord.valor ?? amountNum) : amountNum;

        console.log("[DEBUG] Saque finalizado para comissão. Valor:", saqueValor, "externalReference:", externalReference);

        // Verifica se usuário foi indicado
        if (user.indicado_por) {
          // Evita pagar duas vezes: verificar se já existe ActionHistory para esse externalReference + tipo comissao
          const existente = await ActionHistory.findOne({ id_action: externalReference, tipo: "comissao" });
          if (existente) {
            console.log("[DEBUG] Comissão já registrada para esse saque (ignorar).", externalReference);
          } else {
            // verifica se o usuário que sacou está ativo (dentro do período ativo_ate)
            const agora = new Date();
            if (user.ativo_ate && new Date(user.ativo_ate) > agora) {
              // encontra afiliado (quem indicou)
              const afiliado = await User.findOne({ codigo_afiliado: user.indicado_por });
              if (afiliado) {
                const comissaoValor = Number((saqueValor * COMMISSION_RATE).toFixed(2)); // em reais, 2 decimais
                console.log("[DEBUG] Criando comissão para afiliado:", afiliado._id.toString(), "valor:", comissaoValor);

// cria registro de comissão no ActionHistory (com url_dir preenchido)
const acaoComissao = new ActionHistory({
  user: afiliado._id,
  token: afiliado.token || null,
  nome_usuario: afiliado.nome || afiliado.email || null,
  id_action: externalReference,                     // usado para evitar duplicidade
  id_pedido: `comissao_${externalReference}`,        // identificador próprio
  id_conta: user._id.toString(),                    // conta/usuário que gerou o saque
  unique_id: null,
  // Preenchendo url_dir com referência ao saque - evita erro de validação
  url_dir: `/saques/${externalReference}`,          
  acao_validada: "valida",
  valor_confirmacao: comissaoValor,
  quantidade_pontos: 0,
  tipo_acao: "comissao",
  rede_social: "Sistema",
  tipo: "comissao",
  afiliado: afiliado.codigo_afiliado,
  valor: comissaoValor,
  data: new Date(),
});
await acaoComissao.save();

                // Atualiza saldo do afiliado e histórico
                afiliado.saldo = (afiliado.saldo ?? 0) + comissaoValor;
                afiliado.historico_acoes = afiliado.historico_acoes || [];
                afiliado.historico_acoes.push(acaoComissao._id);
                await afiliado.save();

                console.log("[DEBUG] Comissão registrada e saldo do afiliado atualizado:", { afiliadoId: afiliado._id, novoSaldo: afiliado.saldo });
              } else {
                console.log("[DEBUG] Afiliado não encontrado para codigo:", user.indicado_por);
              }
            } else {
              console.log("[DEBUG] Usuário que sacou não está ativo ou ativo_ate expirou, sem comissão.", { indicado_por: user.indicado_por, ativo_ate: user.ativo_ate });
            }
          }
        } else {
          console.log("[DEBUG] Usuário não foi indicado (sem comissão).");
        }
      } else {
        console.log("[DEBUG] Saque não finalizado (status:", approveStatus, ") — sem comissão.");
      }
    } catch (errCom) {
      console.error("[ERROR] Falha ao processar comissão de afiliado:", errCom);
      // Não reverte o saque — apenas loga o erro
    }

    return res.status(200).json({
      message: "Saque processado (create → approve).",
      create: createData,
      approve: approveData
    });

  } catch (error) {
    console.error("💥 Erro em /withdraw:", error);
    return res.status(500).json({ error: "Erro ao processar saque." });
  }
}

// Rota: /api/tiktok/get_user
if (url.startsWith("/api/tiktok/get_user") && method === "GET") {
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
}

// Rota: /api/tiktok/get_action (GET) — comportamento: permite N contas até quantidade, exceto a mesma conta
if (url.startsWith("/api/tiktok/get_action") && method === "GET") {
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

// valida usuário pelo token (encontra o usuário dono do token)
const usuario = await User.findOne({ token });
if (!usuario) {
  console.log("[GET_ACTION] Token inválido");
  return res.status(401).json({ error: "Token inválido" });
}

// garante que o token corresponde à conta nome_usuario enviada
const contaVinculada = Array.isArray(usuario.contas) &&
  usuario.contas.some(c => c.nome_usuario === nome_usuario);

if (!contaVinculada) {
  console.log("[GET_ACTION] Token não pertence à conta solicitada:", nome_usuario);
  return res.status(401).json({ error: "Token não pertence à conta solicitada" });
}
    // normalizar tipo
    const tipoNormalized = typeof tipo === 'string' ? String(tipo).trim().toLowerCase() : null;
    let tipoBanco;
    if (tipo === "2" || tipoNormalized === "2" || tipoNormalized === "curtir") tipoBanco = "curtir";
    else if (tipo === "3" || tipoNormalized === "3" || tipoNormalized === "seguir_curtir")
      tipoBanco = { $in: ["seguir", "curtir"] };
    else tipoBanco = "seguir";

    // query base — tiktok, status e quantidade disponível
    const query = {
      quantidade: { $gt: 0 },
      status: { $in: ["pendente", "reservada"] },
      rede: { $regex: new RegExp(`^tiktok$`, "i") }
    };
    if (typeof tipoBanco === "string") query.tipo = tipoBanco;
    else query.tipo = tipoBanco;

    const totalMatching = await Pedido.countDocuments(query);
    console.log(`[GET_ACTION] Pedidos que batem com query inicial: ${totalMatching}`);

    const pedidos = await Pedido.find(query).sort({ dataCriacao: -1 }).lean();
    console.log(`[GET_ACTION] ${pedidos.length} pedidos encontrados (após find)`);

    if (debug === "1") {
      return res.status(200).json({ debug: true, totalMatching, sampleQuery: query, pedidosSample: pedidos.slice(0, 6) });
    }

for (const pedido of pedidos) {
  const id_pedido = pedido._id;
  const idPedidoStr = String(id_pedido);

  // garantir que quantidade é número válido
  const quantidadePedido = Number(pedido.quantidade || 0);
  if (isNaN(quantidadePedido) || quantidadePedido <= 0) continue;

  // 0) Se já houver N confirmações (valida) igual ou maior que quantidade, fecha
  const validadas = await ActionHistory.countDocuments({
    $or: [{ id_pedido }, { id_action: idPedidoStr }],
    status: "valida"
  });
  if (validadas >= quantidadePedido) continue;

  // 1) Total feitas (pendente + valida)
  const feitas = await ActionHistory.countDocuments({
    $or: [{ id_pedido }, { id_action: idPedidoStr }],
    status: { $in: ["pendente", "valida"] }
  });
  if (feitas >= quantidadePedido) continue;

  // 2) Verificar se ESTE NOME_DE_CONTA pulou => bloqueia só esta conta
  const pulada = await ActionHistory.findOne({
    $or: [{ id_pedido }, { id_action: idPedidoStr }],
    nome_usuario: nome_usuario,
    status: "pulada"
  });
  if (pulada) continue;

  // 3) Verificar se ESTE NOME_DE_CONTA já possui pendente/valida => bloqueia só esta conta
  const jaFez = await ActionHistory.findOne({
    $or: [{ id_pedido }, { id_action: idPedidoStr }],
    nome_usuario: nome_usuario,
    status: { $in: ["pendente", "valida"] }
  });
  if (jaFez) {
    console.log(`Usuário ${nome_usuario} já possuí ação pendente/validada para pedido ${id_pedido} — pulando`);
    continue;
  }
      // Se chegou aqui: feitas < quantidade AND este usuário ainda NÃO fez => pode pegar
      // extrair nome do perfil alvo (tiktok tolerant)
      let nomeUsuarioAlvo = "";
      if (typeof pedido.link === "string") {
        if (pedido.link.includes("@")) {
          nomeUsuarioAlvo = pedido.link.split("@")[1].split(/[/?#]/)[0];
        } else {
          try {
            const m = pedido.link.match(/tiktok\.com\/@?([^\/?#&]+)/i);
            if (m && m[1]) nomeUsuarioAlvo = m[1].replace(/\/$/, "");
          } catch (e) { /* ignore */ }
        }
      }

      console.log(`✅ Ação disponível para ${nome_usuario}: ${nomeUsuarioAlvo || '<sem-usuario>'} (pedido ${id_pedido}) — feitas=${feitas}/${quantidadePedido}`);

      const valorFinal = typeof pedido.valor !== "undefined" && pedido.valor !== null
        ? String(pedido.valor)
        : (pedido.tipo === "curtir" ? "0.001" : "0.006");

      return res.status(200).json({
        status: "success",
        nome_usuario,
        id_action: idPedidoStr,
        url: pedido.link,
        nome_usuario_perfil: nomeUsuarioAlvo,
        tipo_acao: pedido.tipo,
        valor: valorFinal
      });
    }

    console.log("[GET_ACTION] Nenhuma ação disponível");
    return res.status(200).json({ status: "fail", message: "nenhuma ação disponível no momento" });

  } catch (err) {
    console.error("[GET_ACTION] Erro ao buscar ação:", err);
    return res.status(500).json({ error: "Erro interno ao buscar ação" });
  }
}

// ROTA: /api/tiktok/confirm_action (POST)
if (url.startsWith("/api/tiktok/confirm_action") && method === "POST") {
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

    // Extrair nome de usuário do perfil alvo
    let nomeDoPerfil = "";
    if (url_dir.includes("@")) {
      nomeDoPerfil = url_dir.split("@")[1].split(/[/?#]/)[0];
    }

    // Criar registro no histórico
    const newAction = new ActionHistory({
      user: usuario._id,
      token,
      nome_usuario,
      nome_usuario_perfil: nomeDoPerfil,
      tipo_acao,
      tipo: tipo_acao,
      quantidade_pontos: valorFinal,
      valor_confirmacao: valorFinal,
      rede_social: "TikTok",
      url: url_dir,            // ✔ CORRIGIDO
      id_action,
      acao_validada: "pendente",
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
}

// Rota: /api/instagram/get_user
if (url.startsWith("/api/instagram/get_user") && method === "GET") {
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
}

// Rota: /api/instagram/get_action (GET) — compatível com registros que usam `status` ou `acao_validada`
if (url.startsWith("/api/instagram/get_action") && method === "GET") {
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

    // normalizar tipo
    const tipoNormalized = typeof tipo === 'string' ? String(tipo).trim().toLowerCase() : null;
    let tipoBanco;
    if (tipo === "2" || tipoNormalized === "2" || tipoNormalized === "curtir") tipoBanco = "curtir";
    else if (tipo === "3" || tipoNormalized === "3" || tipoNormalized === "seguir_curtir")
      tipoBanco = { $in: ["seguir", "curtir"] };
    else tipoBanco = "seguir";

    // query base — instagram, status e quantidade disponível
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
      const id_pedido = pedido._id;
      const idPedidoStr = String(id_pedido);

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

      // helpers para checar estados: consideram tanto acao_validada quanto status
      const matchValida = { $or: [{ acao_validada: "valida" }, { status: "valida" }] };
      const matchPendenteOrValida = { $or: [{ acao_validada: { $in: ["pendente", "valida"] } }, { status: { $in: ["pendente", "valida"] } }] };
      const matchPulada = { $or: [{ acao_validada: "pulada" }, { status: "pulada" }] };

      // 0) Se já houver N confirmações (valida) igual ou maior que quantidade, fecha
      const validadas = await ActionHistory.countDocuments({
        $or: [{ id_pedido }, { id_action: idPedidoStr }],
        $or: [ { acao_validada: "valida" }, { status: "valida" } ]
      });
      if (validadas >= quantidadePedido) {
        console.log(`[GET_ACTION][IG] Pedido ${id_pedido} fechado — já tem ${validadas} validações.`);
        continue;
      }

      // 1) Total feitas (pendente + valida)
      const feitas = await ActionHistory.countDocuments({
        $or: [{ id_pedido }, { id_action: idPedidoStr }],
        $or: [
          { acao_validada: { $in: ["pendente", "valida"] } },
          { status: { $in: ["pendente", "valida"] } }
        ]
      });
      console.log(`[GET_ACTION][IG] Ação ${id_pedido}: feitas=${feitas}, limite=${quantidadePedido}`);
      if (feitas >= quantidadePedido) {
        console.log(`[GET_ACTION][IG] Pedido ${id_pedido} atingiu limite — pulando`);
        continue;
      }

      // 2) Verificar se ESTE NOME_DE_CONTA pulou => bloqueia só esta conta
      const pulada = await ActionHistory.findOne({
        $or: [{ id_pedido }, { id_action: idPedidoStr }],
        nome_usuario: nomeUsuarioRequest,
        $or: [
          { acao_validada: "pulada" },
          { status: "pulada" }
        ]
      });
      if (pulada) {
        console.log(`[GET_ACTION][IG] Usuário ${nomeUsuarioRequest} pulou o pedido ${id_pedido} — pulando`);
        continue;
      }

      // 3) Verificar se ESTE NOME_DE_CONTA já possui pendente/valida => bloqueia só esta conta
      const jaFez = await ActionHistory.findOne({
        $or: [{ id_pedido }, { id_action: idPedidoStr }],
        nome_usuario: nomeUsuarioRequest,
        $or: [
          { acao_validada: { $in: ["pendente", "valida"] } },
          { status: { $in: ["pendente", "valida"] } }
        ]
      });
      if (jaFez) {
        console.log(`[GET_ACTION][IG] Usuário ${nomeUsuarioRequest} já possuí ação pendente/validada para pedido ${id_pedido} — pulando`);
        continue;
      }

      // Se chegou aqui: feitas < quantidade AND este nome_usuario ainda NÃO fez => pode pegar
      // extrair alvo do link (Instagram tolerant)
      let nomeUsuarioAlvo = "";
      if (typeof pedido.link === "string") {
        const link = pedido.link.trim();

        // 1) post (curtir): /p/POST_ID/
        const postMatch = link.match(/instagram\.com\/p\/([^\/?#&]+)/i);
        if (postMatch && postMatch[1]) {
          nomeUsuarioAlvo = postMatch[1]; // devolve o id do post (ex: DQfvCmnDYNN)
        } else {
          // 2) perfil: /username/  (pega primeiro segmento após instagram.com)
          const m = link.match(/instagram\.com\/@?([^\/?#&\/]+)/i);
          if (m && m[1]) {
            nomeUsuarioAlvo = m[1].replace(/\/$/, "");
          } else {
            // fallback: usar campo nome do pedido, se existir
            nomeUsuarioAlvo = pedido.nome || "";
          }
        }
      }

      console.log(`[GET_ACTION][IG] Ação disponível para ${nomeUsuarioRequest}: ${nomeUsuarioAlvo || '<sem-usuario>'} (pedido ${id_pedido}) — feitas=${feitas}/${quantidadePedido}`);

      const valorFinal = typeof pedido.valor !== "undefined" && pedido.valor !== null
        ? String(pedido.valor)
        : (pedido.tipo === "curtir" ? "0.001" : "0.006");

      return res.status(200).json({
        status: "success",
        nome_usuario: nomeUsuarioRequest,
        id_action: idPedidoStr,
        url: pedido.link,
        nome_usuario_perfil: nomeUsuarioAlvo,
        tipo_acao: pedido.tipo,
        valor: valorFinal
      });
    }

    console.log("[GET_ACTION][IG] Nenhuma ação disponível");
    return res.status(200).json({ status: "fail", message: "nenhuma ação disponível no momento" });

  } catch (err) {
    console.error("[GET_ACTION][IG] Erro ao buscar ação:", err);
    return res.status(500).json({ error: "Erro interno ao buscar ação" });
  }
}

// ROTA: /api/instagram/confirm_action (POST)
if (url.startsWith("/api/instagram/confirm_action") && method === "POST") {
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

    // Valor da ação (mesma regra já usada)
    const valorFinal = tipo_acao === "curtir" ? 0.001 : 0.006;

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

    // Criar registro no histórico — salvando ambos id_pedido (número) e id_action (string)
    const newAction = new ActionHistory({
      user: usuario._id,
      token,
      nome_usuario,                       // conta que executou a ação (normalizada)
      nome_usuario_perfil: nomeDoPerfil,  // alvo (perfil ou post id)
      tipo_acao,
      tipo: tipo_acao,
      quantidade_pontos: valorFinal,
      valor_confirmacao: valorFinal,
      rede_social: "Instagram",           // importante: rede Instagram
      url: url_dir,
      id_pedido: pedidoLocal._id,         // salva id_pedido numérico
      id_action: String(pedidoLocal._id), // salva id_action em string (compatibilidade)
      acao_validada: "pendente",
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
}

// ROTA: /api/pular_acao
if (url.startsWith("/api/pular_acao") && method === "POST") {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  const {
    token,
    id_pedido,
    id_conta,
    nome_usuario,        // ✔ agora este nome será salvo corretamente
    url_dir,
    quantidade_pontos,
    tipo_acao,
    tipo
  } = req.body;

  if (
    !token ||
    !id_pedido ||
    !id_conta ||
    !nome_usuario ||
    !url_dir ||
    !quantidade_pontos ||
    !tipo_acao ||
    !tipo
  ) {
    return res.status(400).json({ error: "Campos obrigatórios ausentes" });
  }

  try {
    await connectDB();

    const user = await User.findOne({ token });
    if (!user) {
      return res.status(401).json({ error: "Token inválido" });
    }

    // Verificar se já existe ação pulada deste pedido + conta
    const existente = await ActionHistory.findOne({
      id_pedido,
      id_conta,
      acao_validada: "pulada",
    });

    if (existente) {
      return res.status(200).json({ status: "JA_PULADA" });
    }

    // Registrar ação pulada
    const novaAcao = new ActionHistory({
      user: user._id,
      token,
      nome_usuario,         // ✔ salvo corretamente
      id_action: crypto.randomUUID(),
      id_pedido,
      id_conta,
      url_dir,
      quantidade_pontos,
      tipo_acao,
      tipo,
      acao_validada: "pulada",
      rede_social: "TikTok",
      createdAt: new Date(),
    });

    await novaAcao.save();

    return res.status(200).json({ status: "PULADA_REGISTRADA" });

  } catch (error) {
    console.error("Erro ao registrar ação pulada:", error);
    return res.status(500).json({ error: "Erro interno" });
  }
}

// 🔹 Rota: /api/afiliados
if (url.startsWith("/api/afiliados") && method === "POST") {
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
}

// Rota: /api/registrar_acao_pendente
if (url.startsWith("/api/registrar_acao_pendente")) {
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

  const {
    id_conta,
    id_pedido,
    nome_usuario,
    url,
    tipo_acao,
    quantidade_pontos,
    unique_id
  } = req.body;

  if (!id_pedido || !id_conta || !nome_usuario || !tipo_acao || quantidade_pontos == null) {
    return res.status(400).json({ error: "Campos obrigatórios ausentes." });
  }

  try {
    const idPedidoStr = id_pedido.toString();

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

    // === Cálculo de valores ===
    const pontos = parseFloat(quantidade_pontos);
    const valorBruto = pontos / 1000;
    const valorDescontado = (valorBruto > 0.003) ? valorBruto - 0.001 : valorBruto;
    const valorFinalCalculado = Math.min(Math.max(valorDescontado, 0.003), 0.006).toFixed(3);
    const valorConfirmacaoFinal = (tipoAcaoFinal === "curtir") ? "0.001" : valorFinalCalculado;

    // === Criar Ação ===
    const novaAcao = new ActionHistory({
      user: usuario._id,
      token: usuario.token,
      nome_usuario,
      id_pedido: idPedidoStr,
      id_action: idPedidoStr,
      id_conta,
      url,
      unique_id,
      tipo_acao,
      quantidade_pontos,
      tipo: tipoAcaoFinal,
      rede_social: redeFinal,     // <---- AQUI AGORA ESTÁ CORRETO
      valor_confirmacao: valorConfirmacaoFinal,
      acao_validada: "pendente",
      data: new Date()
    });

    // Salvar com limite
    await salvarAcaoComLimitePorUsuario(novaAcao);

    return res.status(200).json({ status: "pendente", message: "Ação registrada com sucesso." });

  } catch (error) {
    console.error("Erro ao registrar ação pendente:", error);
    return res.status(500).json({ error: "Erro ao registrar ação." });
  }
}

// Rota: /api/test/ranking_diario (POST)
if (url.startsWith("/api/ranking_diario") && method === "POST") {
  const rankingQuery = query || {};
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
      "Allef 🔥","🤪","-","noname","⚡","💪","-","KingdosMTD🥱🥱","kaduzinho",
      "Rei do ttk 👑","Deus🔥","Mago ✟","-","ldzz tiktok uva🍇","unknown",
      "vitor das continhas","-","@_01.kaio0","Lipe Rodagem Interna 😄","-","dequelbest 🧙","Luiza","-","xxxxxxxxxx",
      "Bruno TK","-","[GODZ] MK ☠️","[GODZ] Leozin ☠️","Junior","Metheus Rangel","Hackerzin☯","VIP++++","sagaz🐼","-"
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
} // fim if /api/ranking_diario

  if (!url.startsWith("/api/gerenciar_acoes")) {
    console.log("❌ Rota não corresponde:", url);
    return res.status(404).json({ error: "Rota não encontrada." });
  }

  console.log("👉 [ROTA] /api/test/gerenciar_acoes acessada.");
  console.log("🔹 Método:", method);

  try {
    console.log("🟧 Conectando ao banco...");
    await connectDB();
    console.log("🟩 Banco conectado.");

    // ========================
    // 1️⃣ Autenticação (verifica token apenas para permitir acesso)
    // ========================
    console.log("🔍 Verificando header Authorization...");
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      console.log("❌ Token não enviado.");
      return res.status(401).json({ error: "Acesso negado, token não encontrado." });
    }

    const token = authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : authHeader;

    console.log("🔍 Token recebido:", token);

    const user = await User.findOne({ token });
    console.log("🔍 Usuário encontrado:", user ? user._id : "NÃO ENCONTRADO");

    if (!user) {
      console.log("❌ Usuário não encontrado, token inválido.");
      return res.status(404).json({ error: "Usuário não encontrado ou token inválido." });
    }

    // ========================
    // 2️⃣ Somente POST
    // ========================
    console.log("🔸 Verificando método POST...");
    if (method !== "POST") {
      console.log("❌ Método inválido:", method);
      return res.status(405).json({ error: "Use POST." });
    }

    console.log("📥 Body recebido:", req.body);
    const { modo, periodo, status, tipo, pagina = 1 } = req.body;

    // Helper: calcula data inicial com base no 'periodo' que o frontend envia
    function calcularInicioPorPeriodo(p) {
      if (!p || p === "all" || p === "todos") return null;
      const agora = Date.now();

      switch (String(p)) {
        case "24h":
        case "24horas":
          return new Date(agora - 24 * 60 * 60 * 1000);
        case "7d":
        case "7dias":
          return new Date(agora - 7 * 24 * 60 * 60 * 1000);
        case "30d":
        case "30dias":
          return new Date(agora - 30 * 24 * 60 * 60 * 1000);
        case "90d":
        case "90dias":
          return new Date(agora - 90 * 24 * 60 * 60 * 1000);
        case "365d":
        case "365dias":
          return new Date(agora - 365 * 24 * 60 * 60 * 1000);
        case "hoje":
          const inicioHoje = new Date();
          inicioHoje.setHours(0, 0, 0, 0);
          return inicioHoje;
        default:
          return null;
      }
    }

    // =====================================================================================
    // 3️⃣ MODO RESUMO (agrega TODAS as ações do sistema)
    // =====================================================================================
// === INÍCIO: bloco modo === "resumo" ajustado para respeitar filtros ===
if (modo === "resumo") {
    console.log("📌 MODO RESUMO ativado (com filtros).");
    // monta filtros a partir do que veio no body
    const filtrosResum = {};

    // STATUS
    if (status && status !== "todos" && status !== "all") {
        const mapStatus = { pending: "pendente", valid: "valida", invalid: "invalida" };
        filtrosResum.acao_validada = mapStatus[status] || status;
        console.log("🔍 Resumo -> filtro status:", filtrosResum.acao_validada);
    }

    // TIPO
    if (tipo && tipo !== "todos" && tipo !== "all") {
        filtrosResum.tipo = tipo;
        console.log("🔍 Resumo -> filtro tipo:", filtrosResum.tipo);
    }

    // PERÍODO (usa a mesma função/calculo do modo lista)
    function calcularInicioPorPeriodo(p) {
        if (!p || p === "all" || p === "todos") return null;
        const agora = Date.now();
        switch (String(p)) {
            case "24h": return new Date(agora - 24 * 60 * 60 * 1000);
            case "7d": return new Date(agora - 7 * 24 * 60 * 60 * 1000);
            case "30d": return new Date(agora - 30 * 24 * 60 * 60 * 1000);
            case "90d": return new Date(agora - 90 * 24 * 60 * 60 * 1000);
            case "365d": return new Date(agora - 365 * 24 * 60 * 60 * 1000);
            case "hoje":
                const inicioHoje = new Date(); inicioHoje.setHours(0,0,0,0); return inicioHoje;
            default: return null;
        }
    }

    if (periodo && periodo !== "todos" && periodo !== "all") {
        const inicio = calcularInicioPorPeriodo(periodo);
        if (inicio) {
            // sua collection tem createdAt, então filtramos por createdAt
            filtrosResum.createdAt = { $gte: inicio };
            console.log("🔍 Resumo -> filtro período desde:", inicio.toISOString());
        } else {
            console.log("🔍 Resumo -> período não mapeado:", periodo);
        }
    }

    // Agora usamos filtrosResum para contar (cada contagem pode adicionar/alterar acao_validada)
    console.log("🔍 Resumo -> filtro final:", filtrosResum);

    console.log("🔄 Contando ações pendentes (com filtros)...");
    console.time("⏱ pendentes");
    const pendentes = await ActionHistory.countDocuments({
        ...filtrosResum,
        acao_validada: "pendente"
    });
    console.timeEnd("⏱ pendentes");
    console.log("📌 Pendentes (filtrados):", pendentes);

    console.log("🔄 Contando ações válidas (com filtros)...");
    console.time("⏱ validas");
    const validas = await ActionHistory.countDocuments({
        ...filtrosResum,
        acao_validada: "valida"
    });
    console.timeEnd("⏱ validas");
    console.log("📌 Válidas (filtradas):", validas);

    console.log("🔄 Contando ações inválidas (com filtros)...");
    console.time("⏱ invalidas");
    const invalidas = await ActionHistory.countDocuments({
        ...filtrosResum,
        acao_validada: "invalida"
    });
    console.timeEnd("⏱ invalidas");
    console.log("📌 Inválidas (filtradas):", invalidas);

    // Para o total somamos apenas as válidas, mas respeitando outros filtros (tipo/periodo)
    console.log("🔄 Calculando total ganho (válidas + filtros)...");
    console.time("⏱ total");
    const ganhosMatch = { ...filtrosResum, acao_validada: "valida" };
    const totalGanhoArr = await ActionHistory.aggregate([
        { $match: ganhosMatch },
        { $group: { _id: null, soma: { $sum: "$valor" } } }
    ]);
    console.timeEnd("⏱ total");
    console.log("📌 Aggregation total ganho (filtrado):", totalGanhoArr);

    const total = totalGanhoArr[0]?.soma || 0;
    console.log("💰 Total ganho calculado (filtrado):", total);

    return res.status(200).json({
        pendentes,
        validas,
        invalidas,
        total
    });
}
// === FIM: bloco modo === "resumo" ajustado ===

    // =====================================================================================
    // 4️⃣ MODO LISTA (filtros, periodo, status, tipo, paginação) — lista TODAS as ações do sistema
    // =====================================================================================

    console.log("📌 MODO LISTA ativado.");

    const filtros = {}; // lista ações de todo mundo
    console.log("🔍 Filtros iniciais:", filtros);

    // STATUS (aceita 'all' ou 'todos' para sem filtro)
    if (status && status !== "todos" && status !== "all") {
      const mapStatus = {
        pending: "pendente",
        valid: "valida",
        invalid: "invalida"
      };
      filtros.acao_validada = mapStatus[status] || status;
      console.log("🔍 Filtro por status:", filtros.acao_validada);
    }

    // TIPO (aceita 'all' para sem filtro)
    if (tipo && tipo !== "todos" && tipo !== "all") {
      filtros.tipo = tipo;
      console.log("🔍 Filtro por tipo:", tipo);
    }

    // PERÍODO (aceita valores do frontend: 24h, 7d, 30d, 90d, 365d, all)
    if (periodo && periodo !== "todos" && periodo !== "all") {
      const inicio = calcularInicioPorPeriodo(periodo);
      if (inicio) {
        // sua collection usa createdAt (conforme exemplos), então filtramos por createdAt
        filtros.createdAt = { $gte: inicio };
        console.log("🔍 Filtro por período:", filtros.createdAt);
      } else {
        console.log("🔍 Período informado não mapeado para intervalo:", periodo);
      }
    }

    // PAGINAÇÃO
    const porPagina = 20;
    const page = Number(pagina) > 0 ? Number(pagina) : 1;
    const skip = (page - 1) * porPagina;

    console.log("🔢 Paginando: página", page, "skip", skip);

    console.log("🔄 Contando total de documentos com filtro...");
    const total = await ActionHistory.countDocuments(filtros);
    const totalPaginas = Math.ceil(total / porPagina);
    console.log("📌 Total registros:", total, "| Total páginas:", totalPaginas);

    console.log("🔄 Buscando ações...");
    const acoes = await ActionHistory.find(filtros)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(porPagina)
      .lean();

    console.log("📌 Ações encontradas:", acoes.length);

    // FORMATAÇÃO
    const resultado = acoes.map(a => ({
      data: a.createdAt,
      tipo: a.tipo,
      descricao: a.descricao || "",
      status:
        a.acao_validada === "valida"
          ? "valid"
          : a.acao_validada === "invalida"
          ? "invalid"
          : "pending",
      valor: Number(a.valor || 0)
    }));

    console.log("📦 Enviando lista com", resultado.length, "registros.");

    return res.status(200).json({
      pagina_atual: page,
      total_paginas: totalPaginas,
      acoes: resultado
    });

  } catch (error) {
    console.error("❌ ERRO GERAL EM /api/gerenciar_acoes:");
    console.error("📄 Mensagem:", error.message);
    console.error("📄 Stack:", error.stack);


    return res.status(500).json({ error: "Erro interno no servidor." });
  }
}
