import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const app = express();
app.use(express.json());

function logToFile(msg) {
    const data = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFile("/app/logs.txt", data, () => {});
}

// Caminhos
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ⬇️ 1) ROTA /logs **ANTES DE TUDO**
app.get("/logs", (req, res) => {
    res.sendFile(path.join(__dirname, "logs.html"));
});

// ⬇️ 2) ROTA /api/logs (para o painel ler os logs)
app.get("/api/logs", (req, res) => {
    fs.readFile("/app/logs.txt", "utf8", (err, data) => {
        if (err) return res.json({ logs: "Nenhum log encontrado ainda." });
        res.json({ logs: data.split("\n").filter(l => l.trim() !== "") });
    });
});

// ⬇️ 3) IMPORTANDO SUAS ROTAS DA API
import handler from "./api/handler.js";
app.use("/api", handler);

// ⬇️ 4) SERVIR FRONTEND
app.use(express.static(__dirname));

// ⬇️ 5) CATCH-ALL (DEVE SER O ÚLTIMO!)
app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// INICIAR SERVIDOR
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🔥 Servidor rodando na porta " + PORT)
);
