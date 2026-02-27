require("dotenv").config();

const fetch = global.fetch;
const express = require("express");
const pdfParse = require("pdf-parse");
const { createClient } = require("@supabase/supabase-js");
const cors = require("cors");
const multer = require("multer");
const OpenAI = require("openai");
const { GoogleGenerativeAI } = require("@google/generative-ai");

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

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

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
      const result = await provider.fn();
      console.log(`Success with: ${provider.name}`);
      return result;
    } catch (err) {
      const message = (err?.message || "").toLowerCase();

      const isQuotaOrRate =
        message.includes("rate limit") ||
        message.includes("quota") ||
        message.includes("429");

      if (isQuotaOrRate) {
        console.log(`${provider.name} quota/rate limited. Trying next...`);
        await new Promise(res => setTimeout(res, 1000));
        continue;
      }

      console.log(`${provider.name} failed with non-rate error.`);
      console.log(err);
      throw err;
    }
  }

  throw new Error("All LLM providers exhausted");
}

// ================= PROVIDER CALLS =================

async function callGemini(prompt) {
  const model = genAI.getGenerativeModel({
    model: "gemini-1.0-pro"
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
    max_tokens: 5000
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
    max_tokens: 5000
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

  const trimmed = cleaned.slice(0, 40000);

  const prompt = `
You are an executive synthesis engine.

Rewrite the following book content into a 30–40 minute strategic executive briefing.

Rules:
- Abstract the concepts.
- Remove narrative examples.
- Focus only on frameworks and strategic implications.
- Structure into 4 sections:
  1. Core Thesis
  2. Structural Principles
  3. Strategic Implications
  4. Execution Framework
- End with one reflective closing question.

Book Content:
${trimmed}
`;

  return await callLLMWithFallback(prompt);
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

    const script = await buildExecutiveScriptLLM(parsed.text);

    const { data: job } = await supabase
      .from("jobs")
      .insert({ status: "script_ready", script })
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

        if (!job.script) throw new Error("No script found");

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
                  name: "en-US-Neural2-D",
                },
                audioConfig: { audioEncoding: "MP3" },
              }),
            }
          );

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

// ================= START =================

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Executive parser running on port ${PORT}`);
});          //   r e d e p l o y   t r i g g e r 
 
 