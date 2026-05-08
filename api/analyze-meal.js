const GEMINI_MODEL_FALLBACKS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-1.5-flash-8b",
];

function emptyAnalysis(mealComment) {
  return {
    menu: ["判定中"],
    calories_kcal: 0,
    protein_g: 0,
    fat_g: 0,
    carbs_g: 0,
    vitamins: {
      A_ug_RAE: 0, B1_mg: 0, B2_mg: 0, B6_mg: 0, B12_ug: 0,
      C_mg: 0, D_ug: 0, E_mg: 0, folate_ug: 0, niacin_mg: 0
    },
    minerals: {
      calcium_mg: 0, iron_mg: 0, zinc_mg: 0, magnesium_mg: 0, potassium_mg: 0
    },
    vitamin_insights: [],
    mineral_insights: [],
    goal_advice: "",
    meal_comment: mealComment || "AI出力の整形に失敗したため、再解析をおすすめします。"
  };
}

function parseGeminiJson(text) {
  let t = String(text || "").trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(t);
  if (fence) t = fence[1].trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();

  // 余計な前置き/後置き文があってもJSONオブジェクト本体を抽出する
  const extractObject = (src) => {
    let start = -1;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === "}") {
        if (depth > 0) depth--;
        if (depth === 0 && start >= 0) return src.slice(start, i + 1);
      }
    }
    return src;
  };

  const candidates = [];
  candidates.push(t);
  candidates.push(extractObject(t));
  candidates.push(extractObject(t).replace(/,\s*([}\]])/g, "$1"));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // next
    }
  }
  throw new Error("JSON_PARSE_FAILED");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function repairJsonWithGemini(apiKey, brokenText) {
  const repairModel = "gemini-2.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${repairModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const repairPrompt = [
    "次のテキストを、内容を変えずに有効なJSONオブジェクト1つへ修復してください。",
    "出力はJSONのみ。説明文、Markdown、コードブロックは禁止。",
    "末尾カンマ、クォート欠落、改行崩れを補正してください。",
    "",
    brokenText
  ].join("\n");

  const body = JSON.stringify({
    contents: [{ parts: [{ text: repairPrompt }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 2048,
      responseMimeType: "application/json"
    }
  });

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  if (!r.ok) return null;
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) return null;
  try {
    return parseGeminiJson(raw);
  } catch {
    return null;
  }
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
          let data;
          try {
            data = JSON.parse(text);
          } catch (e) {
            console.error("Gemini API response JSON.parse failed", { message: e?.message, textSnippet: text?.slice(0, 400) });
            return res.status(502).json({ error: "Gemini APIの応答形式が不正です（レスポンスJSONの解析失敗）" });
          }
          const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!raw) {
            return res.status(502).json({ error: "Gemini応答が空です" });
          }
          let analysis;
          try {
            analysis = parseGeminiJson(raw);
          } catch (e) {
            console.error("Gemini content JSON.parse failed", { message: e?.message, rawSnippet: String(raw).slice(0, 1200) });
            const repaired = await repairJsonWithGemini(apiKey, String(raw));
            if (repaired) {
              console.info("Gemini JSON repair succeeded");
              analysis = repaired;
            } else {
              console.error("Gemini JSON repair failed; returning safe fallback object");
              return res.status(200).json({
                analysis: emptyAnalysis("解析結果のJSONが不正だったため暫定表示です。もう一度お試しください。")
              });
            }
          }
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
    console.error("analyze-meal handler error", e);
    return res.status(500).json({ error: e?.message || "サーバーエラー" });
  }
}
