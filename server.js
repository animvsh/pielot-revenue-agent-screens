import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 8080);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/demo", (_req, res) => {
  res.sendFile(path.join(__dirname, "demo.html"));
});

function fallbackResponse(message) {
  const lower = (message || "").toLowerCase();
  if (lower.includes("why")) {
    return "A flat 20% discount may improve redemptions but hurts margin. $5 off $30+ keeps AOV higher and protects profit.";
  }
  if (lower.includes("deploy")) {
    return "Campaign deployed. Live tracking started. I created a production campaign and enabled analytics events.";
  }
  return "I found a strong Tuesday 2-6 PM revenue gap (-24%). I recommend a win-back campaign for 1,248 at-risk weekday customers.";
}

app.post("/api/demo-chat", async (req, res) => {
  try {
    const message = String(req.body?.message || "");
    const baseUrl = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
    const apiKey = process.env.MINIMAX_API_KEY || process.env.OPENAI_API_KEY || "";
    const model = process.env.DEMO_MODEL || "gpt-4.1-mini";

    if (!apiKey) {
      return res.json({ ok: true, mode: "fallback", text: fallbackResponse(message) });
    }

    const prompt = `You are Pielot, an AI revenue copilot for local restaurants. Keep responses under 80 words, practical, and ROI-focused.\nUser: ${message}`;
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        messages: [
          { role: "system", content: "You are a restaurant revenue strategist." },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      return res.json({ ok: true, mode: "fallback", text: fallbackResponse(message) });
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || fallbackResponse(message);
    return res.json({ ok: true, mode: "live", text });
  } catch {
    return res.json({ ok: true, mode: "fallback", text: fallbackResponse(req.body?.message || "") });
  }
});

app.listen(port, () => {
  console.log(`Pielot running on port ${port}`);
});
