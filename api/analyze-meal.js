const GEMINI_MODEL_FALLBACKS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-1.5-flash-8b",
];

function parseGeminiJson(text) {
  let t = String(text || "").trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(t);
  if (fence) t = fence[1].trim();
  return JSON.parse(t);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "サーバー環境変数 GEMINI_API_KEY が未設定です" });
  }

  const { base64Image, mimeType, prompt } = req.body || {};
  if (!base64Image || !mimeType || !prompt) {
    return res.status(400).json({ error: "リクエストが不正です" });
  }

  const body = JSON.stringify({
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: base64Image } }
      ]
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
      responseMimeType: "application/json"
    }
  });

  const maxAttemptsPerModel = 4;
  let last404Body = "";
  let lastOverloadBody = "";

  try {
    for (const model of GEMINI_MODEL_FALLBACKS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

      for (let attempt = 0; attempt < maxAttemptsPerModel; attempt++) {
        if (attempt > 0) {
          const waitMs = Math.min(12000, 2000 * Math.pow(2, attempt - 1));
          await sleep(waitMs);
        }

        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body
        });
        const text = await r.text();

        if (r.ok) {
          const data = JSON.parse(text);
          const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!raw) {
            return res.status(502).json({ error: "Gemini応答が空です" });
          }
          const analysis = parseGeminiJson(raw);
          return res.status(200).json({ analysis });
        }

        if (r.status === 404) {
          last404Body = text;
          break;
        }

        if (r.status === 503 || r.status === 429) {
          lastOverloadBody = text;
          if (attempt === maxAttemptsPerModel - 1) break;
          continue;
        }

        return res.status(r.status).json({ error: `Gemini API: ${r.status} ${text}` });
      }
    }

    if (lastOverloadBody) {
      return res.status(503).json({
        error: "Gemini API が混雑中（503）か利用枠に達しています（429）。数分後に再試行してください。"
      });
    }

    return res.status(404).json({
      error: "利用可能なGeminiモデルが見つかりません。Vercel環境変数とモデル設定を確認してください。"
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "サーバーエラー" });
  }
}
