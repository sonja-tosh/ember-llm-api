import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
const chatHistory = [];
const lastBotResponses = [];
const PORT = process.env.PORT || 3001;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(bodyParser.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 🔁 Deduplication
function isSimilar(newText) {
  const normalize = (str) => str.toLowerCase().replace(/[^a-z0-9]/gi, '');
  const newNormalized = normalize(newText);
  return lastBotResponses.some(old =>
    normalize(old).includes(newNormalized) || newNormalized.includes(normalize(old))
  );
}

// 🎙️ LaTeX to speech
function convertForSpeech(text) {
  return text
    .replace(/\\\((.*?)\\\)/g, (_, latex) => {
      return latex
        .replace(/\^\{?(\d+)\}?/g, (_, exp) => ` to the power of ${exp}`)
        .replace(/\\times/g, ' times')
        .replace(/\s+/g, ' ');
    })
    .replace(/\\\[/g, '')
    .replace(/\\\]/g, '')
    .replace(/\$\$(.*?)\$\$/g, (_, math) => math)
    .replace(/\$/g, '')
    .replace(/\\text\{(.*?)\}/g, '$1');
}

// ✨ Chat route
app.post('/api/chat', async (req, res) => {
  const { message, image, answers, lastEditedProblem } = req.body;
  if (!message) return res.status(400).json({ error: 'No message provided' });

  chatHistory.push({ role: 'user', content: message });

  let contextText = '';
  if (answers && typeof answers === 'object') {
    contextText += "The student filled out the worksheet:\n";
    for (const [label, value] of Object.entries(answers)) {
      if (value) contextText += `${label}: "${value}"\n`;
    }
  }
  if (lastEditedProblem) {
    contextText += `\nFocus your response on: ${lastEditedProblem}`;
  }

  const model = 'gpt-4-turbo';
  const basePrompt = `
You are EMBER, the world’s best math tutor. You are warm, encouraging, and extremely good at helping students learn through their thinking and problem solving.

You specialize in Common Core Math, especially standard 6.EE.1. You're helping a student named Sonja.

Your tone is warm, responsive, and age-appropriate. Always scaffold slowly — only ask one question or make one comment at a time. Avoid long or complex instructions.

Use clear, inline LaTeX math like \(2^3\), and don’t give answers away. Gently guide Sonja to think through the next step herself.

If Sonja types a question or makes a guess (e.g. "how?" or "2, 3 times?"), respond to it directly. Don’t ignore it or continue your plan.`;

  const payload = {
    model,
    temperature: 0.3,
    messages: image
      ? [
          { role: 'system', content: basePrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: `${message}\n\n${contextText.trim()}` },
              { type: 'image_url', image_url: { url: image } }
            ]
          }
        ]
      : [
          { role: 'system', content: basePrompt },
          ...chatHistory
        ]
  };

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await openaiRes.json();
    let responseText = data?.choices?.[0]?.message?.content || "Oops! I didn’t get a response.";

    // 🔁 De-duplicate
    if (isSimilar(responseText)) {
      console.log('🔁 Rephrasing similar response...');
      const rephraseRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content: "You are a math tutor. Rephrase this to avoid repeating past ideas. Make it short and scaffolded. Use inline LaTeX like \\(2^3\\)."
            },
            { role: 'user', content: responseText }
          ],
          temperature: 0.6
        })
      });

      const retryData = await rephraseRes.json();
      responseText = retryData?.choices?.[0]?.message?.content || responseText;
    }

    // 🧠 Clarify if student asked a direct question or made a guess
    const studentMsg = message.toLowerCase();
    const isFollowUp = studentMsg.includes('?') || studentMsg.includes('how') || studentMsg.match(/\d.*times?/);
    if (isFollowUp) {
      console.log('🪄 Detected follow-up. Clarifying...');
      const clarifyRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content: "You are a math tutor. The student asked a question or made a guess. Rewrite the reply to directly respond, kindly and clearly:"
            },
            {
              role: 'user',
              content: `Student said: "${message}"\nTutor reply: "${responseText}"`
            }
          ],
          temperature: 0.6
        })
      });

      const clarifyData = await clarifyRes.json();
      responseText = clarifyData?.choices?.[0]?.message?.content || responseText;
    }

    // Save
    chatHistory.push({ role: 'assistant', content: responseText });
    lastBotResponses.unshift(responseText);
    if (lastBotResponses.length > 3) lastBotResponses.pop();

    // 🗣️ ElevenLabs voice
    const voiceId = '21m00Tcm4TlvDq8ikWAM';
    const audioPath = path.join(__dirname, 'public', 'ember-response.mp3');
    const spokenText = convertForSpeech(responseText);

    console.log("🗣️ Spoken text:", spokenText);

    if (!spokenText.trim()) {
      console.warn("⚠️ Skipping audio — spokenText is empty.");
      return res.json({ response: responseText, audioUrl: null });
    }

    const audioRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: spokenText,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.75
        }
      })
    });

    if (!audioRes.ok) {
      const errorText = await audioRes.text();
      console.error("🧨 ElevenLabs error:", errorText);
      return res.json({ response: responseText, audioUrl: null });
    }

    const audioStream = fs.createWriteStream(audioPath);
    await new Promise((resolve, reject) => {
      audioRes.body.pipe(audioStream);
      audioRes.body.on("error", reject);
      audioStream.on("finish", resolve);
    });

    res.json({ response: responseText, audioUrl: '/ember-response.mp3' });

  } catch (err) {
    console.error('❌ Error talking to OpenAI or ElevenLabs:', err);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// 👋 Greet route (unchanged)
app.get('/api/greet', async (req, res) => {
  try {
    const prompt = `
You are EMBER, a cheerful and kind math tutor. Say a one-sentence greeting to a student named Sonja who's starting a worksheet today. Be warm and supportive.`;

    const greetRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4-turbo',
        messages: [{ role: 'system', content: prompt }],
        temperature: 0.8
      })
    });

    const data = await greetRes.json();
    const greetingText = data?.choices?.[0]?.message?.content?.trim() || "Hi Sonja! Ready to dive into some math?";

    const voiceId = '21m00Tcm4TlvDq8ikWAM';
    const greetingPath = path.join(__dirname, 'public', 'greeting-dynamic.mp3');

    const audioRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: greetingText,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.75
        }
      })
    });

    if (!audioRes.ok) {
      const errorText = await audioRes.text();
      console.error("🧨 ElevenLabs greeting error:", errorText);
      return res.json({ greeting: greetingText, audioUrl: null });
    }

    const audioStream = fs.createWriteStream(greetingPath);
    await new Promise((resolve, reject) => {
      audioRes.body.pipe(audioStream);
      audioRes.body.on("error", reject);
      audioStream.on("finish", resolve);
    });

    res.json({ greeting: greetingText, audioUrl: '/greeting-dynamic.mp3' });

  } catch (err) {
    console.error("❌ Error generating greeting:", err);
    res.status(500).json({ error: "Failed to create greeting." });
  }
});

app.listen(PORT, () => console.log(`🔥 EMBER API running on http://localhost:${PORT}`));
