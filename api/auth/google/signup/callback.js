// api/auth/google/signup/callback.js
import axios from "axios";
import connectDB from "../../../db.js";
import { User } from "../../../schema.js";
import jwt from "jsonwebtoken";

const FRONTEND_BASE = process.env.FRONTEND_URL || "https://ganhesocialtest.com";

export default async function handler(req, res) {
  try {
    await connectDB();

    // === 1) Se for POST: tratamos credential (Google Identity / One Tap)
    if (req.method === "POST") {
      const { credential } = req.body;
      if (!credential) {
        return res.status(400).json({ success: false, error: "credential ausente" });
      }

      // Validar id_token (credential) via tokeninfo
      const { data: info } = await axios.get(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`
      );

      // info contém email, name, picture quando válido
      const { email, name } = info;

      // cria / encontra usuário
      let user = await User.findOne({ email });
      if (!user) {
        user = await User.create({
          email,
          nome: name,
          provider: "google",
          senha: "",
          token
        });
      }

      const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "7d" });

      // Retorna JSON para o fetch do frontend (signup.html espera JSON)
      return res.status(200).json({ success: true, token });
    }

    // === 2) Se for GET: tratamos o fluxo OAuth (code -> exchange -> redirect)
    if (req.method === "GET") {
      const code = req.query.code;
      if (!code) return res.status(400).json({ error: "Código não fornecido." });

      const { data: tokenData } = await axios.post(
        "https://oauth2.googleapis.com/token",
        {
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: process.env.GOOGLE_REDIRECT_URI_SIGNUP,
          grant_type: "authorization_code",
        }
      );

      const googleAccessToken = tokenData.access_token;

      const { data: googleUser } = await axios.get(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        { headers: { Authorization: `Bearer ${googleAccessToken}` } }
      );

      const { email, name } = googleUser;

      let user = await User.findOne({ email });
      if (!user) {
        user = await User.create({
          email,
          nome: name,
          provider: "google",
          senha: "",
          token
        });
      }

      const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "7d" });

      // REDIRECIONA PARA O FRONTEND COM O TOKEN NA QUERY
      // IMPORTANTE: FRONTEND_BASE deve ser só o domínio base (sem /painel)
      return res.redirect(`${FRONTEND_BASE}/login-success?token=${token}`);
    }

    // método não permitido
    res.setHeader("Allow", "GET, POST");
    return res.status(405).end("Method Not Allowed");

  } catch (err) {
    console.error("Erro em signup/callback:", err?.response?.data || err);
    return res.status(500).json({ success: false, error: "Erro interno" });
  }
}
