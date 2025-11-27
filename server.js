import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { logToFile } from "./logger.js";

// Corrige caminhos dos arquivos
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// Serve index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Serve logs.html
app.get("/logs", (req, res) => {
  res.sendFile(path.join(__dirname, "logs.html"));
});

// Endpoint que retorna os logs
app.get("/api/logs", (req, res) => {
  const logPath = path.join(__dirname, "logs.txt");

  // Garante que o arquivo exista
  fs.access(logPath, fs.constants.F_OK, (err) => {
    if (err) {
      return res.json([]);
    }
    const logs = fs.readFileSync(logPath, "utf8").trim().split("\n");
    res.json(logs.reverse());
  });
});

// Qualquer outra rota passa para handler.js (se usar)
app.use("/api", async (req, res) => {
  const { default: handler } = await import("./handler.js");
  return handler(req, res);
});

// Porta Railway / fallback local
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));
