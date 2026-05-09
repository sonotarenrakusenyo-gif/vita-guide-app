const DEFAULT_ANALYSIS = {
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
  improvement_tips: [],
  lacking_nutrients: [],
  recommended_foods: [],
  goal_advice: "",
  meal_comment: ""
};

function toNumberOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseJsonFromText(text) {
  let t = String(text || "").trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(t);
  if (fence) t = fence[1].trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) t = t.slice(first, last + 1);
  return JSON.parse(t);
}

function normalize(input) {
  const src = input && typeof input === "object" ? input : {};
  const out = JSON.parse(JSON.stringify(DEFAULT_ANALYSIS));
  out.menu = Array.isArray(src.menu) && src.menu.length ? src.menu.map((x) => String(x)) : out.menu;
  out.calories_kcal = toNumberOrZero(src.calories_kcal);
  out.protein_g = toNumberOrZero(src.protein_g);
  out.fat_g = toNumberOrZero(src.fat_g);
  out.carbs_g = toNumberOrZero(src.carbs_g);
  Object.keys(out.vitamins).forEach((k) => { out.vitamins[k] = toNumberOrZero(src?.vitamins?.[k]); });
  Object.keys(out.minerals).forEach((k) => { out.minerals[k] = toNumberOrZero(src?.minerals?.[k]); });
  out.vitamin_insights = Array.isArray(src.vitamin_insights) ? src.vitamin_insights : [];
  out.mineral_insights = Array.isArray(src.mineral_insights) ? src.mineral_insights : [];
  out.improvement_tips = Array.isArray(src.improvement_tips) ? src.improvement_tips.map((x) => String(x)) : [];
  out.lacking_nutrients = Array.isArray(src.lacking_nutrients) ? src.lacking_nutrients.map((x) => String(x)) : [];
  out.recommended_foods = Array.isArray(src.recommended_foods) ? src.recommended_foods.map((x) => String(x)) : [];
  out.goal_advice = typeof src.goal_advice === "string" ? src.goal_advice : "";
  out.meal_comment = typeof src.meal_comment === "string" ? src.meal_comment : "";
  return out;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY が未設定です" });

  const { menuText, profile, baseAnalysis } = req.body || {};
  if (!menuText || !String(menuText).trim()) return res.status(400).json({ error: "menuText が必要です" });

  const prompt = `あなたは管理栄養士です。以下のメニュー文字列だけを元に栄養推定してください。
必ずJSONオブジェクトのみ返し、説明文やMarkdownは禁止です。

メニュー: ${String(menuText).trim()}
プロフィール: ${JSON.stringify(profile || {})}
参考情報(前回推定): ${JSON.stringify(baseAnalysis || {})}

JSON:
{
  "menu": ["推定メニュー名"],
  "calories_kcal": number,
  "protein_g": number,
  "fat_g": number,
  "carbs_g": number,
  "vitamins": {"A_ug_RAE": number,"B1_mg": number,"B2_mg": number,"B6_mg": number,"B12_ug": number,"C_mg": number,"D_ug": number,"E_mg": number,"folate_ug": number,"niacin_mg": number},
  "minerals": {"calcium_mg": number,"iron_mg": number,"zinc_mg": number,"magnesium_mg": number,"potassium_mg": number},
  "vitamin_insights": [{"key":"C_mg","status":"不足|適量|過多の可能性","note":"短い解説","food_sources":["食材"]}],
  "mineral_insights": [{"key":"iron_mg","status":"不足|適量|過多の可能性","note":"短い解説","food_sources":["食材"]}],
  "lacking_nutrients": ["不足しやすい栄養素名"],
  "recommended_foods": ["補える食材名"],
  "improvement_tips": ["次の食事での改善提案を短く"],
  "goal_advice": "短いアドバイス",
  "meal_comment": "短いコメント"
}`;

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 1600, responseMimeType: "application/json" }
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(apiKey)}`;
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    const text = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: `Gemini API: ${r.status} ${text}` });
    const data = JSON.parse(text);
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return res.status(502).json({ error: "再計算結果が空です" });
    let parsed;
    try {
      parsed = parseJsonFromText(raw);
    } catch {
      return res.status(502).json({ error: "再計算結果のJSON解析に失敗しました" });
    }
    return res.status(200).json({ analysis: normalize(parsed) });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "サーバーエラー" });
  }
}
