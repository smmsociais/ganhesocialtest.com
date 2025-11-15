import axios from "axios";

const RENDER_SERVICE_ID = "srv-d4333k63jp1c73e5qtb0"; // <- coloque o seu ID
const RENDER_API_KEY = "rnd_v818izwf6NF12w8dy331LwsHE83d"; // <- coloque sua API key

async function redeploy() {
  try {
    const response = await axios.post(
      `https://api.render.com/v1/services/${RENDER_SERVICE_ID}/deploys`,
      {},
      {
        headers: {
          Authorization: `Bearer ${RENDER_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );
    console.log("✅ Deploy acionado com sucesso:", response.data);
  } catch (error) {
    console.error("❌ Erro ao acionar deploy:", error.response?.data || error.message);
  }
}

redeploy();
