//server.js

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import apiRoutes from "./api/handler.js";   // ✔ IMPORTANTE

const router = express.Router();

// ROTAS SMM – INSTAGRAM E TIKTOK
router.get("/buscar_acao_smm_instagram", buscarInstagram);
router.get("/buscar_acao_smm_tiktok", buscarTikTok);

// ROTAS GET USER
router.get("/get-instagram-user", getInstagramUser);
router.get("/get-user-tiktok", getTikTokUser);

// ROTA PARA CONFIRMAR AÇÃO SMM
router.post("/smm_acao", smmAcao);

// ROTA PARA VERIFICAR SE SEGUE UM PERFIL
router.get("/user-following", verificarFollowing);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Serve arquivos estáticos
app.use(express.static(__dirname));

// Rotas da API (todas começam com /api)
app.use("/api", apiRoutes);   // ✔ Correto

// Rota principal
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Demais páginas (HTML)
const pages = [
  "dashboard",
  "login",
  "signup",
  "realizar_acoes",
  "realizar_acoes_tiktok",
  "realizar_acoes_instagram",
  "adicionar_conta",
  "adicionar_conta_instagram",
  "adicionar_conta_tiktok",
  "conta_adicionada_instagram",
  "conta_adicionada_tiktok",
  "gerenciar_contas",
  "gerenciar_contas_tiktok",
  "gerenciar_contas_instagram",
  "historico_acoes",
  "refer",
  "detail_account",
  "profile",
  "solicitar_saque",
  "historico_saques",
  "recover-password",
  "reset-password",
  "ranking",
  "gerenciar_acoes"
];

// gera rotas automáticas
pages.forEach(page => {
  app.get(`/${page}`, (req, res) => {
    res.sendFile(path.join(__dirname, `${page}.html`));
  });
});

// rota especial de docs
app.get("/docs/api/tiktok", (req, res) => {
  res.sendFile(path.join(__dirname, "docs/api/tiktok.html"));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log("Servidor rodando na porta " + PORT)
);

export default router;

