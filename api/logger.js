import fs from "fs";
import path from "path";

// Diretório base seguro para Railway
const LOG_DIR = "/app/logs";

// Garante que a pasta existe
if (!fs.existsSync(LOG_DIR)) {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    } catch (err) {
        console.error("❌ Erro ao criar diretório de logs:", err);
    }
}

// Gera nome do log diário: logs/2025-11-26.log
function getLogFilePath() {
    const date = new Date().toISOString().split("T")[0];
    return path.join(LOG_DIR, `${date}.log`);
}

// Função principal
export function logToFile(message) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}\n`;
    const logPath = getLogFilePath();

    // Grava log sem travar a API
    fs.appendFile(logPath, logLine, (err) => {
        if (err) {
            console.error("❌ Erro ao escrever log:", err);
        }
    });
}
