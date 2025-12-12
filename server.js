//server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import apiRoutes from "./api/handler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Arquivos estáticos
app.use(express.static(__dirname));

// Rotas da API
app.use("/api", apiRoutes);

// Página principal
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Lista de páginas HTML
const pages = [
  "dashboard", "login", "login-success","signup", "realizar_acoes",
  "realizar_acoes_tiktok", "realizar_acoes_instagram",
  "adicionar_conta", "adicionar_conta_instagram", "adicionar_conta_tiktok",
  "conta_adicionada_instagram", "conta_adicionada_tiktok",
  "gerenciar_contas", "gerenciar_contas_tiktok", "gerenciar_contas_instagram",
  "historico_acoes", "refer", "detail_account", "profile",
  "solicitar_saque", "historico_saques", "recover-password",
  "reset-password", "ranking", "gerenciar_acoes"
];

// Roteamento automático
pages.forEach(page => {
  app.get(`/${page}`, (req, res) => {
    res.sendFile(path.join(__dirname, `${page}.html`));
  });
});

// Docs
app.get("/docs/api/tiktok", (req, res) => {
  res.sendFile(path.join(__dirname, "docs/api/tiktok.html"));
});

// Iniciar servidor
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));
