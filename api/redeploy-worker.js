import axios from "axios";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  const { RENDER_SERVICE_ID, RENDER_API_KEY } = process.env;

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

    res.status(200).json({ ok: true, data: response.data });
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
}
