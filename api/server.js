import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

// obter dirname da pasta /api
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==============================
//  ROTAS DA API
// ==============================

import handler from "./handler.js";
app.use("/api", handler);

// ==============================
//  ARQUIVOS ESTÁTICOS
// ==============================
//
// Servimos index.html, logs.html e outros
// APENAS da pasta atual (/api)
// ==============================

app.use(express.static(__dirname));

// Página de logs (precisa antes do catch-all)
app.get("/logs", (req, res) => {
  res.sendFile(path.join(__dirname, "logs.html"));
});

// Página inicial
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ==============================
//  CATCH-ALL
// ==============================
// se não for /api/*, não for /logs e não for /,
// devolve index.html
// ==============================

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ==============================
//  INICIAR SERVIDOR
// ==============================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🔥 Servidor rodando na porta " + PORT)
);
