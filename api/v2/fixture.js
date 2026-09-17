import axios from "axios";
import { createFixtureHandler } from "../../lib/fixture.js";

const tmdb = axios.create({ baseURL: "https://api.themoviedb.org/3", timeout: 8000 });

export default createFixtureHandler({
  // Absent by default, which turns this route off entirely. See lib/fixture.js.
  token: () => process.env.HOOZAT_FIXTURE_TOKEN,
  tmdbGet: async (path, params) =>
    (await tmdb.get(path, { params: { api_key: process.env.TMDB_API_KEY, ...params } })).data,
});
