require("dotenv").config();

const express = require("express");
const pdfParse = require("pdf-parse");
const { createClient } = require("@supabase/supabase-js");
const cors = require("cors");
const multer = require("multer");
const OpenAI = require("openai");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const fetch = global.fetch;

// ================= ENV CHECK =================

console.log("ENV CHECK:");
console.log("OPENAI:", process.env.OPENAI_API_KEY ? "OK" : "MISSING");
console.log("GEMINI:", process.env.GEMINI_API_KEY ? "OK" : "MISSING");
console.log("GROQ:", process.env.GROQ_API_KEY ? "OK" : "MISSING");
console.log("SUPABASE:", process.env.SUPABASE_URL ? "OK" : "MISSING");

// ================= PROVIDERS =================

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

// ================= SUPABASE =================

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ================= EXPRESS =================

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ================= HEALTH =================

app.get("/health", async (_req, res) => {
  try {
    await supabase.from("jobs").select("id").limit(1);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// ================= TIMEOUT HELPER =================

async function withTimeout(promise, ms) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("LLM timeout")), ms)
  );
  return Promise.race([promise, timeout]);
}

// ================= LLM ROUTER =================

async function callLLMWithFallback(prompt) {
  const providers = [
    { name: "gemini", fn: () => callGemini(prompt) },
    { name: "groq", fn: () => callGroq(prompt) },
    { name: "openai", fn: () => callOpenAI(prompt) },
  ];

  for (const provider of providers) {
    try {
      console.log(`Trying provider: ${provider.name}`);
      const result = await withTimeout(provider.fn(), 45000);
      console.log(`Success with: ${provider.name}`);

      return {
        content: result,
        provider: provider.name
      };

    } catch (err) {
      const message = (err?.message || "").toLowerCase();
      const status = err?.status || err?.response?.status;

      const isRetryable =
        status === 429 ||
        status === 500 ||
        status === 503 ||
        message.includes("rate") ||
        message.includes("quota") ||
        message.includes("overloaded") ||
        message.includes("timeout");

      if (isRetryable) {
        console.log(`${provider.name} retryable failure. Trying next...`);
        await new Promise(res => setTimeout(res, 1000));
        continue;
      }

      throw err;
    }
  }

  throw new Error("All LLM providers exhausted");
}

// ================= PROVIDER CALLS =================

async function callGemini(prompt) {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash"
  });

  const result = await model.generateContent(prompt);
  return result.response.text();
}

async function callGroq(prompt) {
  const response = await groq.chat.completions.create({
    model: "llama3-70b-8192",
    messages: [
      { role: "system", content: "You are a high-level executive editor." },
      { role: "user", content: prompt }
    ],
    temperature: 0.3,
    max_tokens: 4000
  });

  return response.choices[0].message.content;
}

async function callOpenAI(prompt) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a high-level executive editor." },
      { role: "user", content: prompt }
    ],
    temperature: 0.3,
    max_tokens: 4000
  });

  return response.choices[0].message.content;
}

// ================= SCRIPT GENERATOR =================

async function buildExecutiveScriptLLM(text) {
  const cleaned = text
    .replace(/Page \d+/gi, "")
    .replace(/\n{2,}/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  const MAX_CHARS = 60000;
  const trimmed =
    cleaned.length > MAX_CHARS
      ? cleaned.slice(0, MAX_CHARS)
      : cleaned;

const prompt = `
You are advising a CEO in a closed-door strategy session.

Transform the following book content into a high-level executive briefing.

This is not a summary.

Your job is to extract the governing strategic logic behind the material.

Requirements:

• Identify the core governing thesis.
• Distill repeatable mental models and operating systems.
• Surface hidden assumptions embedded in the ideas.
• Expose trade-offs and second-order effects.
• Translate insights into decision implications for capital allocation, hiring, risk tolerance, and strategic focus.
• Where appropriate, quantify impact or risk directionally.

Tone constraints:

• Analytical — structured, logical, no emotional language.
• Decisive — take positions; avoid hedging.
• Provocative — challenge conventional thinking, but without theatrics.
• No storytelling.
• No inspirational tone.
• No rhetorical fluff.

Structure the briefing as:

1. Core Strategic Thesis  
2. Structural Logic & Frameworks  
3. Decision Implications  
4. Organizational Consequences  
5. One uncomfortable question leadership must confront

Use short paragraphs.
Keep sentences under 20 words.
Avoid multi-clause constructions.

Assume the audience is intelligent, time-constrained, and intolerant of vagueness.

Book Content:
${trimmed}
`;

  const llmResult = await callLLMWithFallback(prompt);

  return {
    script: llmResult.content,
    provider: llmResult.provider
  };
}

// ================= PARSE ROUTE =================

app.post("/parse", upload.single("pdf"), async (req, res) => {
  try {
    let buffer;

    if (req.file) {
      buffer = req.file.buffer;
    } else if (req.body.pdf_url) {
      const response = await fetch(req.body.pdf_url);
      if (!response.ok) throw new Error("PDF download failed");
      buffer = Buffer.from(await response.arrayBuffer());
    } else {
      return res.status(400).json({ error: "PDF file or URL required" });
    }

    const parsed = await pdfParse(buffer);

    if (!parsed.text || parsed.text.length < 5000) {
      return res.status(400).json({
        ok: false,
        error: "PDF contains insufficient selectable text."
      });
    }

   const { script, provider } =
     await buildExecutiveScriptLLM(parsed.text);

    const { data: job } = await supabase
      .from("jobs")
      .insert({
 	 status: "script_ready",
 	 script,
 	 provider_used: provider
	})
      .select()
      .single();

    return res.json({
      ok: true,
      job_id: job.id,
      estimated_minutes: 35
    });

  } catch (err) {
    console.error("PARSE ERROR:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ================= GENERATE AUDIO =================

app.post("/generate-audio", async (req, res) => {
  try {
    const { job_id } = req.body;
    if (!job_id) {
      return res.status(400).json({ error: "job_id required" });
    }

    res.json({ ok: true });

    (async () => {
      try {
        const { data: job } = await supabase
          .from("jobs")
          .select("*")
          .eq("id", job_id)
          .single();

        if (!job || !job.script) throw new Error("No script found");
        if (job.status === "audio_ready") return;

        await supabase
          .from("jobs")
          .update({ status: "audio_generating" })
          .eq("id", job_id);

        const CHUNK_SIZE = 4000;
        const chunks = [];

        for (let i = 0; i < job.script.length; i += CHUNK_SIZE) {
          chunks.push(job.script.slice(i, i + CHUNK_SIZE));
        }

        let combinedBuffer = Buffer.alloc(0);

        for (const chunk of chunks) {
          const response = await fetch(
            `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_TTS_API_KEY}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                input: { text: chunk },
                voice: {
                  languageCode: "en-US",
                  name: "en-US-Neural2-J",
                },
                audioConfig: {
		  audioEncoding: "MP3",
		  speakingRate: 0.92,
		  pitch: -1.0
		}
              }),
            }
          );

          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`TTS failed: ${errText}`);
          }

          const data = await response.json();
          const audioBuffer = Buffer.from(data.audioContent, "base64");
          combinedBuffer = Buffer.concat([combinedBuffer, audioBuffer]);
        }

        const filename = `${job_id}/executive.mp3`;

        await supabase.storage
          .from("audio")
          .upload(filename, combinedBuffer, {
            contentType: "audio/mpeg",
            upsert: true,
          });

        const { data: publicUrlData } = supabase.storage
          .from("audio")
          .getPublicUrl(filename);

        await supabase
          .from("jobs")
          .update({
            status: "audio_ready",
            audio_url: publicUrlData.publicUrl,
          })
          .eq("id", job_id);

      } catch (err) {
        console.error("AUDIO ERROR:", err);
        await supabase.from("jobs").update({ status: "failed" }).eq("id", job_id);
      }
    })();

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ================= JOB STATUS =================

app.get("/job-status/:job_id", async (req, res) => {
  try {
    const { job_id } = req.params;

    const { data: job } = await supabase
      .from("jobs")
      .select("*")
      .eq("id", job_id)
      .single();

    return res.json({ ok: true, job });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ================= GLOBAL CRASH GUARDS =================

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
  process.exit(1);
});

// ================= START =================

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Executive parser running on port ${PORT}`);
});