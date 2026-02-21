const fetch = global.fetch;
const express = require("express");
const pdfParse = require("pdf-parse");
const { createClient } = require("@supabase/supabase-js");
const cors = require("cors");
const multer = require("multer");

const upload = multer({
  limits: { filesize: 50 * 1024 * 1024 } // 50MB
});

const OpenAI = require("opernai");

const openai = new OpenAI({
  apikey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});


// ================= SCRIPT GENERATOR =================

async function buildExecutiveScriptLLM(text) {
  return '
Executive Strategic Briefing

THIS IS A TEST SCRIPT FROM LLM.

If you hear this sentence in the audio ,
then the OpenAI synthesis layer is working.

End of briefing.
';
}  

const cleaned = text
    .replace(/Page \d+/gi, "")
    .replace(/\n{2,}/g, "\n")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Limit input to prevent token explosion
  const trimmed = cleaned.slice(0, 60000);

  const prompt = `
You are an executive synthesis engine.

Transform the following book content into a 30–40 minute strategic executive briefing.

Rules:
- Remove narrative storytelling.
- Remove repetition.
- Remove chapter references.
- Focus only on conceptual frameworks, principles, and strategic implications.
- Rewrite in a confident executive tone.
- Structure into 4 sections:
  1. Core Thesis
  2. Structural Principles
  3. Strategic Implications
  4. Execution Framework
- End with a reflective closing question.
- Do not quote the book directly.
- Do not summarize chapter by chapter.
- Write as a cohesive narrative.

Book Content:
${trimmed}
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a high-level executive editor." },
      { role: "user", content: prompt }
    ],
    temperature: 0.4,
    max_tokens: 6000
  });

  return response.choices[0].message.content;
}


// ================= PARSE ROUTE =================

app.post("/parse", upload.single("pdf"), async (req, res) => {
  try {
    let buffer;

    // Case 1: file upload
    if (req.file) {
      console.log ("Upload file size:", req.file.size);
      buffer = req.file.buffer;
    }


    // Case 2: URL provided
    else if (req.body.pdf_url) {
      const response = await fetch(req.body.pdf_url);
      if (!response.ok) throw new Error("PDF download failed");
      buffer = Buffer.from(await response.arrayBuffer());
    }

    // Case 3: neither provided
    else {
      return res.status(400).json({ error: "PDF file or URL required" });
    }

    const parsed = await pdfParse(buffer);

    if (!parsed.text || parsed.text.length < 5000) {
  return res.status(400).json({
    ok: false,
    error: "This PDF appears to be scanned or contains insufficient selectable text. Please upload a text-based PDF."
  });
}   

    console.log("Extracted text lenght:", parsed.text.length);
    
    const script = await buildExecutiveScriptLLM(parsed.text);

    const { data: job } = await supabase
      .from("jobs")
      .insert({ status: "script_ready", script })
      .select()
      .single();

    return res.json({
      ok: true,
      job_id: job.id,
      estimated_minutes: 25
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

    res.json({ ok: true, message: "Audio generation started" });

    (async () => {
      try {
        const { data: job, error } = await supabase
          .from("jobs")
          .select("*")
          .eq("id", job_id)
          .single();

        if (error) throw error;
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

          if (!response.ok) {
            const err = await response.text();
            throw new Error(`TTS failed: ${err}`);
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

      } catch (err) {
        console.error("AUDIO ERROR:", err);

        await supabase
          .from("jobs")
          .update({ status: "failed" })
          .eq("id", job_id);
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

    const { data: job, error } = await supabase
      .from("jobs")
      .select("*")
      .eq("id", job_id)
      .single();

    if (error) throw error;

    return res.json({ ok: true, job });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});


// ================= START =================

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Executive parser running on port ${PORT}`);
});