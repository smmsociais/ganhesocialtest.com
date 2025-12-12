// api/auth/google/callback.js
import axios from "axios";
import connectDB from "../../db.js";
import { User } from "../../schema.js";
import crypto from "crypto";

export default async function handler(req, res) {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).json({ error: "Código não fornecido." });

    // 1 - Troca code -> access token
    const { data: tokenData } = await axios.post(
      "https://oauth2.googleapis.com/token",
      {
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code",
      }
    );

    const googleAccessToken = tokenData.access_token;

    // 2 - Dados do Google
    const { data: googleUser } = await axios.get(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      { headers: { Authorization: `Bearer ${googleAccessToken}` } }
    );

    const { email, name } = googleUser;

    await connectDB();

    // 3 - Localiza usuário
    let user = await User.findOne({ email });

    // 4 - Se não existir → mesmo padrão de cadastro normal
    if (!user) {
      const token = crypto.randomBytes(32).toString("hex");

      const gerarCodigo = () =>
        Math.floor(10000000 + Math.random() * 90000000).toString();

      let savedUser = null;
      let attempt = 0;

      while (attempt < 5 && !savedUser) {
        const codigo_afiliado = gerarCodigo();

        const ativo_ate = new Date(Date.now() + 30 * 86400000);

        const novo = new User({
          email,
          nome: name,
          senha: "",
          token,
          codigo_afiliado,
          status: "ativo",
          ativo_ate,
          indicado_por: null,
          provider: "google",
        });

        try {
          savedUser = await novo.save();
        } catch (err) {
          if (err?.code === 11000) {
            attempt++;
            continue;
          }
          throw err;
        }
      }

      if (!savedUser) {
        return res.status(500).json({ error: "Erro ao gerar código afiliado." });
      }

      user = savedUser;
    }

    // 5 - Garante token caso usuário antigo não tenha
    if (!user.token) {
      user.token = crypto.randomBytes(32).toString("hex");
      await user.save();
    }

    // 6 - Redireciona para o frontend usando o MESMO token do banco
    const FRONTEND_BASE = process.env.FRONTEND_URL || "https://ganhesocialtest.com";
    return res.redirect(`${FRONTEND_BASE}/login-success?token=${user.token}`);

  } catch (error) {
    console.error("Erro Google login:", error?.response?.data || error);
    return res.status(500).json({ error: "Erro interno ao processar login." });
  }
}
