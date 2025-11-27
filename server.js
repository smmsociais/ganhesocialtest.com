import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import router from "./handler.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Corrigir path base (porque estamos dentro de /app/api/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Caminho da raiz do projeto
const ROOT = path.join(__dirname, "..");   // volta de /api para /app

// Servir arquivos estáticos da raiz
app.use(express.static(ROOT));

// Rotas da API
app.use("/api", router);

// Página de logs
app.get("/logs", (req, res) => {
  res.sendFile(path.join(ROOT, "logs.html"));
});

// Página inicial (corrige o erro ENOENT)
app.get("/", (req, res) => {
  res.sendFile(path.join(ROOT, "index.html"));
});

// Inicia servidor
app.listen(PORT, () =>
  console.log(`🚀 Servidor rodando na porta ${PORT}`)
);
