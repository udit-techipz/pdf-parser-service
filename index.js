// index.js — Railway orchestrator (stable async audio version)

const fetch = global.fetch;
const express = require("express");
const pdfParse = require("pdf-parse");
const { createClient } = require("@supabase/supabase-js");
const { buildChapters } = require("./buildChapters");

// ================== ENV + CLIENTS ==================

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ================== APP ==================

const app = express();
app.use(express.json({ strict: true }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ================== HELPERS ==================

async function synthesizeSpeech(text, filename) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

  try {
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
        signal: controller.signal
      }
    );

    clearTimeout(timeout);

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

    if (error) throw new Error("Failed to upload audio");

    return filename;

  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("TTS request timed out");
    }
    throw err;
  }
}

// ================== ROUTES ==================

app.post("/parse", async (req, res) => {
  try {
    const { pdf_url } = req.body;
    if (!pdf_url || typeof pdf_url !== "string") {
      return res.status(400).json({ error: "Valid_pdf_url required" });
    }

    // 1. Create job
    const { data: job, error: jobError } = await supabase
      .from("jobs")
      .insert({ status: "uploaded" })
      .select()
      .single();

    if (jobError) throw jobError;
    const job_id = job.id;

    // 2. Download PDF
    const response = await fetch(pdf_url);
    if (!response.ok) {
      throw new Error(`Failed to download PDF (${response.status})`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const parsed = await pdfParse(buffer);

    if (!parsed.text || parsed.text.length < 500) {
      throw new Error("PDF text extraction failed");
    }

    // 3. Build chapters
    const chapters = buildChapters(parsed.text);

    // 4. Persist chapters
    await supabase.from("chapters").delete().eq("job_id", job_id);

    const { error: chapterInsertError } = await supabase
      .from("chapters")
      .insert(
        chapters.map((c) => ({
          job_id,
          chapter_index: c.chapter_index,
          title: c.title,
          raw_text: c.raw_text,
          word_count: c.word_count,
          estimated_minutes: c.estimated_minutes,
        }))
      );

    if (chapterInsertError) {
      throw new Error("Chapter insert failed: " + chapterInsertError.message);
    }

    // 5. Compute total duration
    const totalMinutes = chapters.reduce(
      (sum, c) => sum + c.estimated_minutes,
      0
    );

    await supabase
      .from("jobs")
      .update({
        estimated_total_minutes: totalMinutes,
        status: "summaries_ready",
      })
      .eq("id", job_id);

    return res.json({
      ok: true,
      job_id,
      chapters: chapters.length,
      estimated_total_minutes: totalMinutes,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ================== ASYNC AUDIO ==================

app.post("/generate-audio", async (req, res) => {
  try {
    const { job_id } = req.body;
    if (!job_id) {
      return res.status(400).json({ error: "job_id required" });
    }

const { data: jobData } = await supabase
  .from("jobs")
  .select("status")
  .eq("id", job_id)
  .single();

if (jobData.status === "audio_ready") {
  return res.json({ ok: true, message: "Audio already generated", job_id });
}

    const { data: chapters, error } = await supabase
      .from("chapters")
      .select("*")
      .eq("job_id", job_id)
      .order("chapter_index");

    if (error) throw error;
    if (!chapters || chapters.length === 0) {
      throw new Error("No chapters found for job");
    }

    await supabase
      .from("jobs")
      .update({ status: "audio_generating" })
      .eq("id", job_id);

    for (const chapter of chapters) {
      const filename = `${job_id}/chapter-${chapter.chapter_index}.mp3`;

      await synthesizeSpeech(
        chapter.raw_text.slice(0, 4500),
        filename
      );

      await new Promise((r) => setTimeout(r, 400));
    }

    await supabase
      .from("jobs")
      .update({ status: "audio_ready" })
      .eq("id", job_id);

    return res.json({ ok: true, job_id });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
console.log('Generating audio for chapter ${chapter.chapter_index}');
});

// ===================Job Status Endpoint ================
app.get("/job-status/:job_id", async (req, res) => {
  try {
    const { job_id } = req.params;

    const { data, error } = await supabase
      .from("jobs")
      .select("*")
      .eq("id", job_id)
      .single();

    if (error) throw error;

    return res.json({ ok: true, job: data });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ================== START ==================

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`PDF parser running on port ${PORT}`);
});
