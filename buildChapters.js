function buildChapters(text) {
  return [
    {
      chapter_index: 1,
      title: "Full Book",
      raw_text: text,
      word_count: text.split(/\s+/).length,
      estimated_minutes: Math.ceil(text.split(/\s+/).length / 160)
    }
  ];
}

module.exports = { buildChapters };
