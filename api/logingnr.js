import axios from "axios";

// 🔑 Sua chave do CapMonster
const CAPMONSTER_API_KEY = "cbbe3f324b95a704eeb9a2d3aa1565b3";

// 🔗 Dados do site alvo
const WEBSITE_URL = "https://www.ganharnasredes.com/painel/?pagina=login";
const WEBSITE_KEY = "6LeHHAoaAAAAAO8g8W16nDsmqD7sh1co6HBy_hpT"; // <-- Pegue do código fonte da página

// 🎯 Credenciais de login
const EMAIL = "renissontk@gmail.com";
const SENHA = "ffffff";

// Função para criar a task no CapMonster
async function createCaptchaTask() {
  const { data } = await axios.post(
    "https://api.capmonster.cloud/createTask",
    {
      clientKey: CAPMONSTER_API_KEY,
      task: {
        type: "NoCaptchaTaskProxyless",
        websiteURL: WEBSITE_URL,
        websiteKey: WEBSITE_KEY,
      },
    }
  );
  if (data.errorId !== 0) {
    throw new Error(`Erro ao criar task: ${data.errorDescription}`);
  }
  return data.taskId;
}

// Função para pegar o resultado do captcha
async function getCaptchaResult(taskId) {
  while (true) {
    const { data } = await axios.post(
      "https://api.capmonster.cloud/getTaskResult",
      {
        clientKey: CAPMONSTER_API_KEY,
        taskId,
      }
    );
    if (data.errorId !== 0) {
      throw new Error(`Erro ao obter resultado: ${data.errorDescription}`);
    }
    if (data.status === "ready") {
      console.log("✅ Captcha resolvido.");
      return data.solution.gRecaptchaResponse;
    }
    console.log("⏳ Aguardando resolução do captcha...");
    await new Promise((r) => setTimeout(r, 5000)); // espera 5 segundos
  }
}

// Função para fazer login
async function fazerLogin(captchaToken) {
  const formData = new URLSearchParams();
  formData.append("email", EMAIL);
  formData.append("senha", SENHA);
  formData.append("g-recaptcha-response", captchaToken);

  try {
    const response = await axios.post(
      "https://www.ganharnasredes.com/painel/",
      formData.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
          Referer: WEBSITE_URL,
        },
        maxRedirects: 0, // Opcional: não seguir redirects
        validateStatus: (status) => status < 500,
      }
    );

    if (response.status === 302 || response.headers["set-cookie"]) {
      console.log("🎉 Login efetuado com sucesso!");
      console.log("🍪 Cookies:", response.headers["set-cookie"]);
    } else {
      console.log("❌ Falha no login.");
      console.log(response.data);
    }
  } catch (error) {
    console.error("Erro no login:", error.message);
  }
}

// 🚀 Função principal
(async () => {
  try {
    console.log("🚩 Criando task no CapMonster...");
    const taskId = await createCaptchaTask();

    console.log("🚩 Aguardando resolução...");
    const captchaToken = await getCaptchaResult(taskId);

    console.log("🚩 Fazendo login...");
    await fazerLogin(captchaToken);
  } catch (error) {
    console.error("❌ Erro:", error.message);
  }
})();
