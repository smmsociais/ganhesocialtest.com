// Rota: /api/rankingantigo
if (url.startsWith("/api/ranking") && method === "POST") {
 if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

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

    const ganhosPorUsuario = await DailyEarning.aggregate([
      {
        $group: {
          _id: "$userId",
          totalGanhos: { $sum: "$valor" }
        }
      },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "usuario"
        }
      },
      { $unwind: "$usuario" },
      {
        $project: {
          _id: 0,
          username: { $ifNull: ["$usuario.nome", ""] },
          total_balance: "$totalGanhos",
          token: "$usuario.token"
        }
      }
    ]);

    // Aplica a formatação
const ranking = ganhosPorUsuario
  .filter(item => item.total_balance > 1) // 🔥 Remove usuários com valor ≤ 1
  .map(item => {
    const valorFormatado = formatarValorRanking(item.total_balance);

    return {
      username: item.username,
      total_balance: valorFormatado,
      is_current_user: item.token === tokenFromHeader
    };
  });

    // Ordena do maior para o menor (reverter ordenação usando o valor numérico real)
    ranking.sort((a, b) => {
      const numA = parseInt(a.total_balance);
      const numB = parseInt(b.total_balance);
      return numB - numA;
    });

    return res.status(200).json({ ranking });

  } catch (error) {
    console.error("❌ Erro ao buscar ranking:", error);
    return res.status(500).json({ error: "Erro interno ao buscar ranking" });
  }
};