// index.js — Executive Single Script Version

const fetch = global.fetch;
const express = require("express");
const pdfParse = require("pdf-parse");
const { createClient } = require("@supabase/supabase-js");
const cors = require("cors");
const multer = require("multer");
const upload = multer();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();
app.use(cors());
app.use(express.json({ strict: true }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ================== SCRIPT GENERATOR ==================

function buildExecutiveScript(text) {
  // 1. Clean noise
  const cleaned = text
    .replace(/Page \d+/gi, "")
    .replace(/\n{2,}/g, "\n")
    .replace(/\s{2,}/g, " ")
    .trim();

  // 2. Guardrail for ~30 min
  const trimmed = cleaned.slice(0, 90000);

  // 3. Split into meaningful paragraphs
  const paragraphs = trimmed
    .split(/\n/)
    .map(p => p.trim())
    .filter(p => p.length > 200);

  // 4. Select high-density paragraphs
  const selected = paragraphs.slice(0, 60).join("\n\n");

  return `
Welcome to your Executive Briefing.

This session distills the strategic core of this book into a focused, high-leverage narrative designed for implementation.

-----------------------------------------------------

PART 1 — The Core Thesis

The author’s central argument can be understood through the following key idea:

${selected.slice(0, 20000)}

-----------------------------------------------------

PART 2 — Structural Patterns

As the ideas develop, several recurring patterns emerge:

${selected.slice(20000, 45000)}

-----------------------------------------------------

PART 3 — Strategic Implications

What does this mean for how you operate, decide, and lead?

${selected.slice(45000, 70000)}

-----------------------------------------------------

PART 4 — Execution Blueprint

To translate insight into action, consider this practical synthesis:

${selected.slice(70000)}

-----------------------------------------------------

Closing Reflection:

If you were to implement one principle immediately, which would create disproportionate leverage in your life or work?

End of briefing.
`;
}


// ================== TTS ==================

async function synthesizeSpeech(text, filename) {
  const response = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_TTS_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
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

  const { error } = await supabase.storage
    .from("audio")
    .upload(filename, audioBuffer, {
      contentType: "audio/mpeg",
      upsert: true,
    });

  if (error) throw error;

  const { data: publicUrlData } = supabase
    .storage
    .from("audio")
    .getPublicUrl(filename);

  return publicUrlData.publicUrl;
}

// ================== PARSE ==================

app.post("/parse", upload.single("pdf"), async (req, res) => {
  try {
    let buffer;

    if (req.file) {
      // Uploaded file
      buffer = req.file.buffer;
    } else if (req.body.pdf_url) {
      // Public URL
      const response = await fetch(req.body.pdf_url);
      if (!response.ok) throw new Error("PDF download failed");
      buffer = Buffer.from(await response.arrayBuffer());
    } else {
      return res.status(400).json({ error: "PDF file or URL required" });
    }

    // Now parse buffer
    const parsed = await pdfParse(buffer);
    if (!parsed.text) throw new Error("Text extraction failed");

    const script = buildExecutiveScript(parsed.text);

    const {data: job, error: jobError } = await supabase
	.from("jobs")
	.insert({
	  script,
	  status: "script_ready"
	})
	.select()
	.single();

    if (jobError) throw jobError;

    return res.json({
	ok.true,
	job_id: job_id,
	estimated minutes: 25
    });

    } catch (err) {
      console.error("PARSE ERROR:", err);
      return res.status(500).json({ ok: false, error:err.message });
    }
});

// ================== GENERATE AUDIO ==================

app.post("/generate-audio", async (req, res) => {
  try {
    const { job_id } = req.body;
    if (!job_id) {
      return res.status(400).json({ error: "job_id required" });
    }

    res.json({ ok: true, message: "Audio generation started" });

    (async () => {
      try {
        const { data: job, error: jobError } = await supabase
          .from("jobs")
          .select("*")
          .eq("id", job_id)
          .single();

        if (jobError) throw jobError;
        if (!job.script) throw new Error("No script found");

        await supabase
          .from("jobs")
          .update({ status: "audio_generating" })
          .eq("id", job_id);

        const CHUNK_SIZE = 4000;
        const script = job.script;
        const chunks = [];

        for (let i = 0; i < script.length; i += CHUNK_SIZE) {
          chunks.push(script.slice(i, i + CHUNK_SIZE));
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
            throw new Error(`TTS chunk failed: ${err}`);
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
        console.error("Background audio error:", err);

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


// ================== JOB STATUS ==================

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

// ================== START ==================

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Executive parser running on port ${PORT}`);
});
