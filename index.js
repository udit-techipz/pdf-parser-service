require("dotenv").config();

const express = require("express");
const pdfParse = require("pdf-parse");
const { createClient } = require("@supabase/supabase-js");
const cors = require("cors");
const multer = require("multer");
const OpenAI = require("openai");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const fetch = global.fetch;

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

// ================= TIMEOUT =================

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
      const result = await withTimeout(provider.fn(), 45000);
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
        message.includes("timeout");

      if (isRetryable) continue;

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

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: 8000,
      temperature: 0.4
    }
  });

  return result.response.text();
}

async function callGroq(prompt) {
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
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
You are speaking to senior executives in a closed-door strategy session.

Deliver a strategic executive briefing as spoken speech — not a written document.

Do not structure this as sections.
Do not use headings.
Do not number points.
Do not reference a book, author, or text.
Do not narrate structure.

Speak continuously, as if addressing a leadership team directly.

The tone must be:
• Analytical
• Decisive
• Provocative (intellectually challenging, not dramatic)

Avoid:
• "First", "Second", "In conclusion"
• "This section"
• "The book argues"
• Any reference to formatting or structure

Favor:
• Direct declarative statements
• Clear logical progression
• Short paragraphs
• Sentences under 20 words

Minimum length requirement:
Deliver at least 4,500 words.
Expand depth if necessary.

Assume your audience is intelligent, skeptical, and time-constrained.

Book Content:
${trimmed}
`;

  const llmResult = await callLLMWithFallback(prompt);

  return {
    script: llmResult.content,
    provider: llmResult.provider
  };
}

// ================= PARSE =================

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
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ================= GENERATE AUDIO =================

function sanitizeForTTS(text) {
  return text
    .replace(/[*_#•]/g, "")                 // remove markdown/bullets
    .replace(/\s+/g, " ")                   // normalize spacing
    .trim();
}

app.post("/generate-audio", async (req, res) => {
  try {
    const { job_id } = req.body;

    if (!job_id) {
      return res.status(400).json({ error: "job_id required" });
    }

    const { data: job, error } = await supabase
      .from("jobs")
      .select("*")
      .eq("id", job_id)
      .single();

    if (error) throw error;
    if (!job || !job.script) throw new Error("No script found");

    await supabase
      .from("jobs")
      .update({ status: "audio_generating" })
      .eq("id", job_id);

    const cleanScript = sanitizeForTTS(job.script);

    const CHUNK_SIZE = 2800;
    const chunks = [];

    for (let i = 0; i < cleanScript.length; i += CHUNK_SIZE) {
      chunks.push(cleanScript.slice(i, i + CHUNK_SIZE));
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
              name: "en-US-Studio-O",
            },
            audioConfig: {
              audioEncoding: "MP3",
              speakingRate: 0.95,
              pitch: -0.5
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

    const { error: uploadError } = await supabase.storage
      .from("audio")
      .upload(filename, combinedBuffer, {
        contentType: "audio/mpeg",
        upsert: true,
      });

    if (uploadError) throw uploadError;

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

    return res.json({
      ok: true,
      audio_url: publicUrlData.publicUrl
    });

  } catch (err) {
    console.error("AUDIO ERROR:", err);
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

// ================= CRASH GUARDS =================

process.on("unhandledRejection", () => {});
process.on("uncaughtException", () => process.exit(1));

// ================= START =================

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Executive parser running on port ${PORT}`);
});
