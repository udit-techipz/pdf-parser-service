// index.js — Executive Single Script Version

const fetch = global.fetch;
const express = require("express");
const pdfParse = require("pdf-parse");
const { createClient } = require("@supabase/supabase-js");
const cors = require("cors");

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
	// Clean text
	const cleaned = text
		.replace(/\n+/g, " ")
		.replace(/\s+/g, " ")	
		.replace(/Page \d+/gi, " ")
		.trim();

	// Guardrail ~25-30 minutes
	const trimmed = cleaned.slice(0, 85000); 

	// Break into logical chunks
	const sections = [
		trimmed.slice(0, 15000),
		trimmed.slice(15000, 35000),
		trimmed.slice(35000, 60000),
		trimmed.slice(60000, 75000),
		trimmed.slice(75000)
	];
		

  return `
Welcome to your Executive Briefing.

This session distills the strategic core of this book into a focused, high-leverage narrative designed for implementation.

-----------------------------------------------------

PART 1 — The Core Thesis

${sections[0]}

-----------------------------------------------------

PART 2 — Foundational Principles

${sections[1]}

-----------------------------------------------------

PART 3 — Structural Insights & Mental Models

${sections[2]}

-----------------------------------------------------

PART 4 — Strategic Implications

${sections[3]}

-----------------------------------------------------

PART 5 — Execution Blueprint

${sections[4]}

-----------------------------------------------------

Closing Reflection:

If you were to implement just one of these ideas immediately — which one would move your life forward most dramatically?

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

app.post("/parse", async (req, res) => {
  try {
    const { pdf_url } = req.body;
    if (!pdf_url) {
      return res.status(400).json({ error: "pdf_url required" });
    }

    const { data: job } = await supabase
      .from("jobs")
      .insert({ status: "processing" })
      .select()
      .single();

    const job_id = job.id;

    const response = await fetch(pdf_url);
    if (!response.ok) throw new Error("PDF download failed");

    const buffer = Buffer.from(await response.arrayBuffer());
    const parsed = await pdfParse(buffer);

    if (!parsed.text) throw new Error("Text extraction failed");

    const script = buildExecutiveScript(parsed.text);

    await supabase
      .from("jobs")
      .update({
        script,
        status: "script_ready",
      })
      .eq("id", job_id);

    return res.json({
      ok: true,
      job_id,
      estimated_minutes: 25,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
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
