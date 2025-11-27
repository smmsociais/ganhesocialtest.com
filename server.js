import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Serve arquivos estáticos da raiz
app.use(express.static(__dirname));

// Rota API
app.use("/api", async (req, res) => {
  const { default: handler } = await import("./api/handler.js");
  return handler(req, res);
});

// Rota da página inicial
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Rotas definidas no arquivo
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "login.html"));
});

app.get("/signup", (req, res) => {
  res.sendFile(path.join(__dirname, "signup.html"));
});

app.get("/realizar_acoes", (req, res) => {
  res.sendFile(path.join(__dirname, "realizar_acoes.html"));
});

app.get("/realizar_acoes_tiktok", (req, res) => {
  res.sendFile(path.join(__dirname, "realizar_acoes_tiktok.html"));
});

app.get("/realizar_acoes_instagram", (req, res) => {
  res.sendFile(path.join(__dirname, "realizar_acoes_instagram.html"));
});

app.get("/adicionar_conta", (req, res) => {
  res.sendFile(path.join(__dirname, "adicionar_conta.html"));
});

app.get("/adicionar_conta_instagram", (req, res) => {
  res.sendFile(path.join(__dirname, "adicionar_conta_instagram.html"));
});

app.get("/adicionar_conta_tiktok", (req, res) => {
  res.sendFile(path.join(__dirname, "adicionar_conta_tiktok.html"));
});

app.get("/conta_adicionada_instagram", (req, res) => {
  res.sendFile(path.join(__dirname, "conta_adicionada_instagram.html"));
});

app.get("/conta_adicionada_tiktok", (req, res) => {
  res.sendFile(path.join(__dirname, "conta_adicionada_tiktok.html"));
});

app.get("/gerenciar_contas", (req, res) => {
  res.sendFile(path.join(__dirname, "gerenciar_contas.html"));
});

app.get("/gerenciar_contas_tiktok", (req, res) => {
  res.sendFile(path.join(__dirname, "gerenciar_contas_tiktok.html"));
});

app.get("/gerenciar_contas_instagram", (req, res) => {
  res.sendFile(path.join(__dirname, "gerenciar_contas_instagram.html"));
});

app.get("/historico_acoes", (req, res) => {
  res.sendFile(path.join(__dirname, "historico_acoes.html"));
});

app.get("/refer", (req, res) => {
  res.sendFile(path.join(__dirname, "refer.html"));
});

app.get("/detail_account", (req, res) => {
  res.sendFile(path.join(__dirname, "detail_account.html"));
});

app.get("/profile", (req, res) => {
  res.sendFile(path.join(__dirname, "profile.html"));
});

app.get("/solicitar_saque", (req, res) => {
  res.sendFile(path.join(__dirname, "solicitar_saque.html"));
});

app.get("/historico_saques", (req, res) => {
  res.sendFile(path.join(__dirname, "historico_saques.html"));
});

app.get("/recover-password", (req, res) => {
  res.sendFile(path.join(__dirname, "recover-password.html"));
});

app.get("/reset-password", (req, res) => {
  res.sendFile(path.join(__dirname, "reset-password.html"));
});

app.get("/ranking", (req, res) => {
  res.sendFile(path.join(__dirname, "ranking.html"));
});

app.get("/docs/api/tiktok", (req, res) => {
  res.sendFile(path.join(__dirname, "docs/api/tiktok.html"));
});

app.get("/gerenciar_acoes", (req, res) => {
  res.sendFile(path.join(__dirname, "gerenciar_acoes.html"));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));
