// api/transcribe.js
import formidable from "formidable";
import fs from "fs";
import fetch from "node-fetch";

export const config = {
  api: {
    bodyParser: false, // important for file upload
  },
};

// Helper: format seconds → SRT timecode
function srtTime(seconds) {
  const ms = Math.floor((seconds - Math.floor(seconds)) * 1000);
  const total = Math.floor(seconds);
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  const ms3 = String(ms).padStart(3, "0");
  return `${h}:${m}:${s},${ms3}`;
}

// Build SRT word by word
function buildSRT_word(words) {
  return words
    .map(
      (w, i) =>
        `${i + 1}\n${srtTime(w.start)} --> ${srtTime(w.end)}\n${w.text}\n`
    )
    .join("\n");
}

// Build SRT space-wise (grouped)
function buildSRT_space(words, maxChars = 60) {
  const captions = [];
  let cur = { start: null, end: null, text: "" };
  for (const w of words) {
    if (cur.start === null) {
      cur = { start: w.start, end: w.end, text: w.text };
      continue;
    }
    const gap = w.start - cur.end;
    if (cur.text.length + w.text.length + 1 > maxChars || gap > 0.8) {
      captions.push({ ...cur });
      cur = { start: w.start, end: w.end, text: w.text };
    } else {
      cur.text += " " + w.text;
      cur.end = w.end;
    }
  }
  if (cur.start !== null) captions.push(cur);

  return captions
    .map(
      (c, i) =>
        `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`
    )
    .join("\n");
}

// Main function
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    const form = formidable({});
    const [fields, files] = await form.parse(req);

    const language = fields.language?.[0] || "auto";
    const mode = fields.mode?.[0] || "space";
    const file = files.file?.[0];
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    const data = fs.readFileSync(file.filepath);

    // 🔹 Upload audio to AssemblyAI
    const uploadRes = await fetch("https://api.assemblyai.com/v2/upload", {
      method: "POST",
      headers: { authorization: process.env.TRANSCRIBE_API_KEY },
      body: data,
    });
    const uploadJson = await uploadRes.json();

    // 🔹 Request transcription
    const transcriptRes = await fetch("https://api.assemblyai.com/v2/transcript", {
      method: "POST",
      headers: {
        authorization: process.env.TRANSCRIBE_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        audio_url: uploadJson.upload_url,
        language_code: language === "auto" ? undefined : language,
        word_timestamps: true,
      }),
    });
    const transcriptJson = await transcriptRes.json();

    // 🔹 Poll for completion
    let transcript = null;
    for (let i = 0; i < 60; i++) {
      const poll = await fetch(
        `https://api.assemblyai.com/v2/transcript/${transcriptJson.id}`,
        { headers: { authorization: process.env.TRANSCRIBE_API_KEY } }
      );
      const pollJson = await poll.json();
      if (pollJson.status === "completed") {
        transcript = pollJson;
        break;
      } else if (pollJson.status === "error") {
        throw new Error("Transcription failed");
      }
      await new Promise((r) => setTimeout(r, 3000));
    }

    if (!transcript) throw new Error("Timed out waiting for transcript");

    const words = transcript.words.map((w) => ({
      text: w.text,
      start: w.start / 1000,
      end: w.end / 1000,
    }));

    const srt =
      mode === "word" ? buildSRT_word(words) : buildSRT_space(words);

    res.status(200).json({
      filename: "captions.srt",
      srt,
      preview: srt.split("\n").slice(0, 15).join("\n"),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
