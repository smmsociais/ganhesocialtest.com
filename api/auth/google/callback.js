// api/auth/google/callback.js
import axios from "axios";
import connectDB from "../../db.js";
import { User } from "../../schema.js";
import jwt from "jsonwebtoken";

export default async function handler(req, res) {
  try {
    const code = req.query.code;

    if (!code) {
      return res.status(400).json({ error: "Código não fornecido." });
    }

    // 1 - Trocar "code" pelo token do Google
    const { data: tokenData } = await axios.post(
      "https://oauth2.googleapis.com/token",
      {
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code"
      }
    );

    const googleAccessToken = tokenData.access_token;

    // 2 - Obter dados do perfil Google
    const { data: googleUser } = await axios.get(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      { headers: { Authorization: `Bearer ${googleAccessToken}` } }
    );

    const { email, name } = googleUser;

    // 3 - Conectar ao banco
    await connectDB();

    // 4 - Verificar se usuário existe
    let user = await User.findOne({ email });

    if (!user) {
      user = await User.create({
        email,
        nome: name,
        provider: "google",
        saldo: 0
      });
    }

    // 5 - Gerar JWT
    // ❗ corrigido: backend precisa de "id", não "userId"
    const token = jwt.sign(
      { id: user._id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // 6 - Redirecionar de volta ao frontend
    // ❗ corrigido: redirecionar para uma rota *client-side*, não /api/*
const FRONTEND_BASE = process.env.FRONTEND_URL || "https://ganhesocialtest.com";
// redireciona para uma rota cliente que captura token e salva no localStorage
return res.redirect(`${FRONTEND_BASE}/login-success?token=${token}`);

  } catch (error) {
    console.error("Erro no callback do Google:", error);
    return res.status(500).json({ error: "Erro interno ao processar login." });
  }
}
