import axios from "axios";
import { RekognitionClient, RecognizeCelebritiesCommand } from "@aws-sdk/client-rekognition";
import { createHandler } from "../../lib/hoozat.js";
import { DEFAULT_LIMITS, HOUR, DAY } from "../../lib/rate-limit.js";

export const config = {
  api: { bodyParser: false },
};

const rekognition = new RekognitionClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const tmdb = axios.create({ baseURL: "https://api.themoviedb.org/3", timeout: 8000 });

// Overridable without a redeploy, so a limit can be relaxed or tightened from the Vercel
// dashboard if real use turns out not to match the guess.
const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

export default createHandler({
  limits: {
    perAddress: { limit: num(process.env.HOOZAT_RATE_PER_ADDRESS, DEFAULT_LIMITS.perAddress.limit), windowMs: HOUR },
    global: { limit: num(process.env.HOOZAT_RATE_GLOBAL, DEFAULT_LIMITS.global.limit), windowMs: DAY },
  },
  appKey: () => process.env.HOOZAT_APP_KEY,
  recognise: (bytes) => rekognition.send(new RecognizeCelebritiesCommand({ Image: { Bytes: bytes } })),
  tmdbGet: async (path, params) =>
    (await tmdb.get(path, { params: { api_key: process.env.TMDB_API_KEY, ...params } })).data,
});
