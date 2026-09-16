import axios from "axios";
import { RekognitionClient, RecognizeCelebritiesCommand } from "@aws-sdk/client-rekognition";
import { createHandler } from "../../lib/hoozat.js";

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

export default createHandler({
  appKey: () => process.env.HOOZAT_APP_KEY,
  recognise: (bytes) => rekognition.send(new RecognizeCelebritiesCommand({ Image: { Bytes: bytes } })),
  tmdbGet: async (path, params) =>
    (await tmdb.get(path, { params: { api_key: process.env.TMDB_API_KEY, ...params } })).data,
});
