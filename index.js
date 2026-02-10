const fetch = global.fetch;
const { buildChapters } = require("./buildChapters");
const express = require("express");
const pdfParse = require("pdf-parse");
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ---------- Helpers ----------
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

const sleep = ms => new Promise(res => setTimeout(res, ms));

function extractJsonArray(text) {
  const match = text.match(/\[\s*{[\s\S]*}\s*\]/);
  if (!match) {
    throw new Error("Gemini JSON block not found");
  }
  return JSON.parse(match[0]);
}
// -------- End helpers --------

// ---------- Clients ----------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({
  model: "gemini-2.5-flash"
});
// -------- End clients --------

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
      .insert({ status: "uploaded" })
      .select()
      .single();

    if (jobError) throw new Error("Failed to create job");
    const job_id = job.id;

    // 2. Fetch + parse PDF
    const response = await fetch(pdf_url);
    if (!response.ok) {
      return res.status(500).json({
        error: `Failed to download PDF (${response.status})`
      });
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const parsed = await pdfParse(buffer);

    if (!parsed.text || parsed.text.length < 500) {
      return res.status(500).json({ error: "PDF text extraction failed" });
    }

    // 3. Build chapters
    const chapters = buildChapters(parsed.text);

    await supabase.from("chapters").delete().eq("job_id", job_id);

    const chapterRows = chapters.map(c => ({
      job_id,
      chapter_index: c.chapter_index,
      title: c.title,
      raw_text: c.raw_text,
      word_count: c.word_count,
      estimated_minutes: c.estimated_minutes
    }));

    await supabase.from("chapters").insert(chapterRows);

    const totalMinutes = chapters.reduce(
      (sum, c) => sum + c.estimated_minutes,
      0
    );

    await supabase
      .from("jobs")
      .update({
        estimated_total_minutes: totalMinutes,
        status: "chapters_ready"
      })
      .eq("id", job_id);

    function decideBulletCount(total) {
      if (total <= 120) return 7;
      if (total <= 150) return 6;
      if (total <= 180) return 5;
      return 3;
    }

    const bulletCount = decideBulletCount(totalMinutes);

    await supabase
      .from("chapter_summaries")
      .delete()
      .eq("job_id", job_id);

    const { data: storedChapters } = await supabase
      .from("chapters")
      .select("*")
      .eq("job_id", job_id)
      .order("chapter_index");

    // 4. Gemini batched summaries (throttled)
    const BATCH_SIZE = 4;
    const chapterBatches = chunkArray(storedChapters, BATCH_SIZE);

    for (const batch of chapterBatches) {
      const prompt = `
You are creating podcast-style summaries of self-help book chapters.

Instructions:
- For EACH chapter below:
  - Create exactly ${bulletCount} bullet points
  - Clear, conversational language
  - No fluff or repetition
- Then write a short dialogue per chapter:
  - Host explains
  - Guest reflects

Return ONLY valid JSON in this format:
[
  { "chapter_index": number, "summary": "text" }
]

Chapters:
${batch
  .map(
    ch => `
Chapter ${ch.chapter_index}: "${ch.title}"
---
${ch.raw_text}
`
  )
  .join("\n\n")}
`;

      const result = await geminiModel.generateContent(prompt);
      const parsedJson = extractJsonArray(result.response.text());

      for (const item of parsedJson) {
        const chapter = batch.find(
          c => c.chapter_index === item.chapter_index
        );
        if (!chapter) continue;

        await supabase.from("chapter_summaries").insert({
          job_id,
          chapter_id: chapter.id,
          bullet_count: bulletCount,
          summary: item.summary
        });
      }

      // 🔒 Throttle to stay under free-tier quota
      await sleep(13000);
    }

    // 5. Finalise job
    await supabase
      .from("jobs")
      .update({ status: "summarised" })
      .eq("id", job_id);

    res.json({
      ok: true,
      job_id,
      chapters: storedChapters.length,
      estimated_total_minutes: totalMinutes
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`PDF parser running on port ${PORT}`);
});
