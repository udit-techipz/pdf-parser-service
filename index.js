// FORCE_REDEPLOY_2026_02_XX

const fetch = global.fetch;
const { buildChapters } = require("./buildChapters");
const express = require("express");
const pdfParse = require("pdf-parse");
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);


const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function synthesizeSpeech(text, filename) {
  const response = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_TTS_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode: "en-US",
          name: "en-US-Neural2-D"
        },
        audioConfig: {
          audioEncoding: "MP3"
        }
      })
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
      upsert: true
    });

  if (error) {
    throw new Error("Failed to upload audio");
  }

  return filename;
}

const app = express();
app.use(express.json({ strict: true }));

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/parse", async (req, res) => {
  try {
    
const { pdf_url } = req.body;

    if (!pdf_url) {
      return res.status(400).json({ error: "pdf_url required" });
    }

// 1. Create job
const { data: job, error: jobError } = await supabase
  .from("jobs")
  .insert({
    status: "uploaded"
  })
  .select()
  .single();

if (jobError) {
  throw new Error("Failed to create job");
}

const job_id = job.id;

    // ✅ Use native Node fetch (Node 18+)
    const response = await fetch(pdf_url);

    if (!response.ok) {
      return res
        .status(500)
        .json({ error: `Failed to download PDF (${response.status})` });
    }

    // ✅ Convert to real Node Buffer
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // ✅ pdf-parse works ONLY like this
    const parsed = await pdfParse(buffer);

    if (!parsed.text || parsed.text.length < 500) {
      return res
        .status(500)
        .json({ error: "PDF text extraction failed" });
    }


// 2. Build chapters from parsed text
const chapters = buildChapters(parsed.text);

// 3. Remove any existing chapters for this job (safety)
await supabase
  .from("chapters")
  .delete()
  .eq("job_id", job_id);

// 4. Insert chapters
const chapterRows = chapters.map(c => ({
  job_id,
  chapter_index: c.chapter_index,
  title: c.title,
  raw_text: c.raw_text,
  word_count: c.word_count,
  estimated_minutes: c.estimated_minutes
}));

const { error: chapterError } = await supabase
  .from("chapters")
  .insert(chapterRows);

if (chapterError) {
  throw new Error("Failed to insert chapters");
}

// 5. Compute total estimated minutes
const totalMinutes = chapters.reduce(
  (sum, c) => sum + c.estimated_minutes,
  0
);

// 6. Update job with total duration
await supabase
  .from("jobs")
  .update({
    estimated_total_minutes: totalMinutes,
    status: "chapters_ready"
  })
  .eq("id", job_id);

// 7. Decide bullet count based on total duration
function decideBulletCount(total) {
  if (total <= 120) return 7;
  if (total <= 150) return 6;
  if (total <= 180) return 5;
  return 3;
}

const bulletCount = decideBulletCount(totalMinutes);

// 8. Clear any existing summaries for this job
await supabase
  .from("chapter_summaries")
  .delete()
  .eq("job_id", job_id);

// 9. Fetch stored chapters (with IDs)
const { data: storedChapters, error: fetchError } = await supabase
  .from("chapters")
  .select("*")
  .eq("job_id", job_id)
  .order("chapter_index");

if (fetchError) {
  throw new Error("Failed to fetch chapters for summarisation");
}

// 10. Generate real summaries with OpenAI
for (const chapter of storedChapters) {
  const prompt = `
You are creating a podcast-style summary of a self-help book chapter.

Chapter title:
"${chapter.title}"

Instructions:
- Create exactly ${bulletCount} bullet points.
- Each bullet captures one key idea.
- Use clear, conversational language.
- No fluff. No repetition.

Then convert the bullets into a short dialogue:
- Host explains the idea.
- Guest adds reflection or example.
- Calm, practical tone.

Chapter text:
"""
${chapter.raw_text}
"""
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.4
  });

  const summaryText =
    completion.choices[0]?.message?.content?.trim();

  if (!summaryText) {
    throw new Error("Empty summary returned from OpenAI");
  }

  await supabase
    .from("chapter_summaries")
    .insert({
      job_id,
      chapter_id: chapter.id,
      bullet_count: bulletCount,
      summary: summaryText
    });
}



// 11. Generate audio for each chapter summary
for (const chapter of storedChapters) {
  const { data: summaryRow, error: summaryFetchError } = await supabase
    .from("chapter_summaries")
    .select("summary")
    .eq("chapter_id", chapter.id)
    .single();

  if (summaryFetchError) {
    throw new Error("Failed to fetch chapter summary for TTS");
  }

  const audioFilename = `${job_id}/chapter-${chapter.chapter_index}.mp3`;

  await synthesizeSpeech(
    summaryRow.summary,
    audioFilename
  );
}

// 12. Finalise job
await supabase
  .from("jobs")
  .update({ status: "summarised" })
  .eq("id", job_id);

// 13. Return final response
res.json({
  ok: true,
  job_id,
  chapters: storedChapters.length,
  estimated_total_minutes: totalMinutes
});


  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PDF parser running on port ${PORT}`);
});
