import axios from "axios";
import FormData from "form-data";
import { RekognitionClient, RecognizeCelebritiesCommand } from "@aws-sdk/client-rekognition";

const rekognition = new RekognitionClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

export const config = {
  api: { bodyParser: false },
};

async function readBuffer(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function identifyWithRekognition(imageBuffer) {
  const command = new RecognizeCelebritiesCommand({
    Image: {
      Bytes: imageBuffer,
    },
  });

  const response = await rekognition.send(command);

  const celebrity = response.CelebrityFaces?.[0];
  if (!celebrity) return null;

  return {
    name: celebrity.Name,
    confidence: celebrity.MatchConfidence / 100,
  };
}


async function filmographyFromTMDb(name) {
  const key = process.env.TMDB_API_KEY;

  const search = await axios.get("https://api.themoviedb.org/3/search/person", {
    params: { api_key: key, query: name, include_adult: false },
  });

  const person = search.data?.results?.[0];
  if (!person) return null;

  const credits = await axios.get(`https://api.themoviedb.org/3/person/${person.id}/combined_credits`, {
    params: { api_key: key },
  });

  return {
    id: person.id,
    name: person.name,
    profile_path: person.profile_path,
    credits: credits.data?.cast ?? [],
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    const imageBuffer = await readBuffer(req);
    if (!imageBuffer?.length) return res.status(400).json({ error: "No image data received" });

    const match = await identifyWithRekognition(imageBuffer);
    if (!match) return res.status(404).json({ error: "No match found" });

    const filmography = await filmographyFromTMDb(match.name);
    if (!filmography) return res.status(404).json({ error: "TMDb person not found" });

    return res.status(200).json({ match, filmography });
  } catch (e) {
    console.error(e?.response?.data ?? e?.message);
    return res.status(500).json({ error: "Server error" });
  }
}
