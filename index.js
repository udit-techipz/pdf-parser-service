const fetch = global.fetch;
const express = require("express");
const pdfParse = require("pdf-parse");
const { createClient } = require("@supabase/supabase-js");
const cors = require("cors");
const multer = require("multer");

const upload = multer({
  limits: { filesize: 50 * 1024 * 1024 } // 50MB
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

function buildExecutiveScript(text) {
  const cleaned = text
    .replace(/Page \d+/gi, "")
    .replace(/\n{2,}/g, "\n")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Split into meaningful paragraphs
  const paragraphs = cleaned
    .split(/\n/)
    .map(p => p.trim())
    .filter(p => p.length > 300);

  // Intelligent compression:
  // Take spaced samples instead of first 90k characters
  const total = paragraphs.length;
  const selected = [];

  const targetSections = 40; // ~30–40 minute output
  const step = Math.floor(total / targetSections);

  for (let i = 0; i < total; i += step) {
    selected.push(paragraphs[i]);
    if (selected.length >= targetSections) break;
  }

  const body = selected.join("\n\n");

  return `
Executive Briefing

This session distills the strategic architecture of the book into a structured executive synthesis.

-----------------------------------------------------

PART 1 — Core Thesis

At its foundation, the book advances the following central argument:

${body.slice(0, 6000)}

-----------------------------------------------------

PART 2 — Structural Principles

The recurring patterns and frameworks can be understood as:

${body.slice(6000, 14000)}

-----------------------------------------------------

PART 3 — Strategic Implications

For decision-making, leadership, and performance, the implications are:

${body.slice(14000, 22000)}

-----------------------------------------------------

PART 4 — Execution Blueprint

To translate insight into measurable progress:

${body.slice(22000)}

-----------------------------------------------------

Closing Reflection:

Which principle, if implemented immediately, would create disproportionate leverage in your life or work?

End of briefing.
`;
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
    
    const script = buildExecutiveScript(parsed.text);

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