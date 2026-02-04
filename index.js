const express = require("express");
const pdfParse = require("pdf-parse");

const app = express();
app.use(express.json());

app.post("/parse", async (req, res) => {
  try {
    const { pdf_url } = req.body;

    if (!pdf_url) {
      return res.status(400).json({ error: "pdf_url required" });
    }

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

    res.json({
      ok: true,
      text_length: parsed.text.length,
      text: parsed.text,
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
