import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

// Diretório atual
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Função para logar em arquivo
export function logToFile(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFile("/app/logs.txt", line, () => {});
}

// Rotas da API
import handler from "./api/handler.js";
app.use("/api", handler);

// SERVIR ARQUIVOS HTML
app.use(express.static(__dirname));

// 🔥 SERVIR PÁGINA DE LOGS (PRECISA VIR ANTES DO app.get("*"))
app.get("/logs", (req, res) => {
  res.sendFile(path.join(__dirname, "logs.html"));
});

// FALLBACK — qualquer rota que não seja /api/... ou arquivo real → index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Subir servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🔥 Servidor rodando na porta " + PORT));
