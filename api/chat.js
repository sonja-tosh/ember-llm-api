import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { message } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Invalid or missing 'message'" });
    }

    const chatCompletion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: "You are a kind and supportive math tutor helping a 6th grader with standard 6.EE.1 (evaluating expressions using exponents). Keep your responses clear and encouraging.",
        },
        {
          role: "user",
          content: message,
        },
      ],
      max_tokens: 150,
    });

    const reply = chatCompletion.choices[0].message.content;
    res.status(200).json({ reply });
  } catch (err) {
    console.error("🔥 OpenAI Error:", err.response?.data || err.message || err);
    res.status(500).json({
      error: "OpenAI API call failed: " + (err.response?.data?.error?.message || err.message || "Unknown"),
    });
  }
}
