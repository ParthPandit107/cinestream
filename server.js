const http = require("http");
const https = require("https");
const url = require("url");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const TMDB_API_KEY = process.env.TMDB_API_KEY || "49699d061436b6db5a0bc503f5aab402";
const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || "https://cinestream-backend.onrender.com";
const MONGODB_URI = process.env.MONGODB_URI || "";

let mongoClient = null;
let commentsCollection = null;
const memoryCommentsStore = new Map();

if (MONGODB_URI) {
  try {
    const { MongoClient } = require("mongodb");
    mongoClient = new MongoClient(MONGODB_URI);
    mongoClient.connect().then(() => {
      console.log("[CINESTREAM] Connected to MongoDB Atlas successfully!");
      const db = mongoClient.db(process.env.MONGODB_DB_NAME || "cinestream");
      commentsCollection = db.collection("comments");
    }).catch(err => {
      console.error("[CINESTREAM] MongoDB Connection Error:", err.message);
    });
  } catch (e) {
    console.warn("[CINESTREAM] mongodb driver not present. Using persistent fallback comments store.");
  }
}

// Keep-Alive Self Ping every 14 minutes
setInterval(() => {
  try {
    const pingUrl = `${RENDER_EXTERNAL_URL}/api/keepalive`;
    console.log(`[CINESTREAM KEEP-ALIVE] Self-ping to ${pingUrl}...`);
    const lib = pingUrl.startsWith("https") ? https : http;
    lib.get(pingUrl, (res) => {
      console.log(`[CINESTREAM KEEP-ALIVE] Status: ${res.statusCode}`);
    }).on("error", () => {});
  } catch (e) {}
}, 840000);

const cacheStore = new Map();
function getCache(key) {
  const item = cacheStore.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    cacheStore.delete(key);
    return null;
  }
  return item.data;
}
function setCache(key, data, ttlSeconds = 3600) {
  cacheStore.set(key, { data, expiry: Date.now() + ttlSeconds * 1000 });
}

function fetchTMDB(endpoint, params = {}, retries = 3) {
  return new Promise((resolve, reject) => {
    const attempt = (remaining) => {
      const queryParams = new URLSearchParams({
        api_key: TMDB_API_KEY,
        language: "en-US",
        ...params,
      }).toString();

      const fullUrl = `${TMDB_BASE_URL}${endpoint}?${queryParams}`;

      const req = https.get(fullUrl, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            if (res.statusCode >= 400) reject(new Error(parsed.status_message || "TMDB Error"));
            else resolve(parsed);
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on("error", (err) => {
        if (remaining > 1) {
          setTimeout(() => attempt(remaining - 1), 1000);
        } else {
          reject(err);
        }
      });
    };

    attempt(retries);
  });
}

/* Strict Anime Detector (Filters Japanese Anime out of CineStream, keeps Western Animation) */
function isAnimeRaw(item) {
  if (!item) return false;
  const title = (item.title || item.name || item.original_title || item.original_name || "").toLowerCase();
  const lang = (item.original_language || "").toLowerCase();

  const genreIds = item.genre_ids || (item.genres ? item.genres.map(g => typeof g === "object" ? g.id : g) : []);
  const genreNames = item.genres ? item.genres.map(g => typeof g === "object" ? (g.name || "") : String(g)) : [];
  const isAnimation = genreIds.includes(16) || genreNames.some(g => g.toLowerCase() === "animation");

  const isJapaneseCountry = (item.origin_country && item.origin_country.includes("JP")) ||
                            (item.production_countries && item.production_countries.some(c => c.iso_3166_1 === "JP"));

  // Rule 1: Japanese Animation (Lang 'ja' or Country 'JP' + Animation genre)
  if (isAnimation && (lang === "ja" || isJapaneseCountry)) return true;

  // Rule 2: Title or Romanized Japanese Anime signature keywords
  const animeKeywords = [
    "demon slayer", "kimetsu no yaiba", "attack on titan", "shingeki no kyojin",
    "jujutsu kaisen", "naruto", "one piece", "dragon ball", "my hero academia",
    "boku no hero", "bleach", "chainsaw man", "tokyo ghoul", "hunter x hunter",
    "fullmetal alchemist", "death note", "neon genesis evangelion", "sword art online",
    "fate/stay", "fate/zero", "boruto", "black clover", "haikyuu", "mob psycho",
    "overlord", "re:zero", "vinland saga", "spy x family", "solo leveling",
    "one punch man", "fairy tail", "gintama", "code geass", "steins;gate",
    "inuyasha", "pokemon", "digimon", "yu-gi-oh", "sailor moon"
  ];

  if (animeKeywords.some(kw => title.includes(kw))) return true;

  return false;
}

function normalizeMovie(m) {
  if (!m) return null;
  const anime = isAnimeRaw(m);
  return {
    id: m.id,
    type: "movie",
    isAnime: anime,
    title: m.title || m.original_title || "Untitled Movie",
    overview: m.overview || "No synopsis available.",
    posterPath: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null,
    backdropPath: m.backdrop_path ? `https://image.tmdb.org/t/p/original${m.backdrop_path}` : (m.poster_path ? `https://image.tmdb.org/t/p/original${m.poster_path}` : null),
    rating: m.vote_average ? m.vote_average.toFixed(1) : "N/A",
    voteCount: m.vote_count || 0,
    releaseDate: m.release_date || "N/A",
    year: m.release_date ? m.release_date.substring(0, 4) : "N/A",
    runtime: m.runtime ? `${m.runtime} min` : null,
    genres: (m.genres || []).map((g) => g.name || g),
    genreIds: m.genre_ids || [],
    tagline: m.tagline || "",
    cast: (m.credits?.cast || []).slice(0, 10).map((c) => ({
      id: c.id,
      name: c.name,
      character: c.character,
      profilePath: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null,
    })),
    videos: (m.videos?.results || [])
      .filter((v) => v.site === "YouTube" && (v.type === "Trailer" || v.type === "Teaser"))
      .map((v) => ({ key: v.key, name: v.name, type: v.type })),
  };
}

function normalizeTV(t) {
  if (!t) return null;
  const anime = isAnimeRaw(t);
  return {
    id: t.id,
    type: "tv",
    isAnime: anime,
    title: t.name || t.original_name || "Untitled TV Show",
    overview: t.overview || "No synopsis available.",
    posterPath: t.poster_path ? `https://image.tmdb.org/t/p/w500${t.poster_path}` : null,
    backdropPath: t.backdrop_path ? `https://image.tmdb.org/t/p/original${t.backdrop_path}` : (t.poster_path ? `https://image.tmdb.org/t/p/original${t.poster_path}` : null),
    rating: t.vote_average ? t.vote_average.toFixed(1) : "N/A",
    voteCount: t.vote_count || 0,
    firstAirDate: t.first_air_date || "N/A",
    year: t.first_air_date ? t.first_air_date.substring(0, 4) : "N/A",
    numberOfSeasons: t.number_of_seasons || 1,
    numberOfEpisodes: t.number_of_episodes || 0,
    genres: (t.genres || []).map((g) => g.name || g),
    genreIds: t.genre_ids || [],
    seasons: (t.seasons || []).map((s) => ({
      seasonNumber: s.season_number,
      name: s.name,
      episodeCount: s.episode_count,
      airDate: s.air_date,
      posterPath: s.poster_path ? `https://image.tmdb.org/t/p/w185${s.poster_path}` : null,
    })),
    cast: (t.credits?.cast || []).slice(0, 10).map((c) => ({
      id: c.id,
      name: c.name,
      character: c.character,
      profilePath: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null,
    })),
    videos: (t.videos?.results || [])
      .filter((v) => v.site === "YouTube" && (v.type === "Trailer" || v.type === "Teaser"))
      .map((v) => ({ key: v.key, name: v.name, type: v.type })),
  };
}

async function getComments(targetKey) {
  if (commentsCollection) {
    try {
      const list = await commentsCollection
        .find({ targetKey: String(targetKey) })
        .sort({ timestamp: -1 })
        .limit(200)
        .toArray();
      return list.map((item) => ({
        id: item._id.toString(),
        targetKey: item.targetKey,
        username: item.username || "Anonymous",
        text: item.text,
        parentId: item.parentId || null,
        likes: item.likes || 0,
        dislikes: item.dislikes || 0,
        isSpoiler: !!item.isSpoiler,
        timestamp: item.timestamp,
      }));
    } catch (e) {
      console.error("MongoDB getComments error:", e);
    }
  }
  return memoryCommentsStore.get(String(targetKey)) || [];
}

async function saveComment(targetKey, commentData) {
  const comment = {
    targetKey: String(targetKey),
    username: (commentData.username || "Anonymous").trim(),
    text: (commentData.text || "").trim(),
    parentId: commentData.parentId || null,
    likes: 0,
    dislikes: 0,
    isSpoiler: !!commentData.isSpoiler,
    timestamp: Date.now(),
  };

  if (!comment.text) return null;

  if (commentsCollection) {
    try {
      const res = await commentsCollection.insertOne(comment);
      return { id: res.insertedId.toString(), ...comment };
    } catch (e) {
      console.error("MongoDB saveComment error:", e);
    }
  }

  const list = memoryCommentsStore.get(String(targetKey)) || [];
  comment.id = Math.random().toString(36).substring(2, 9);
  list.unshift(comment);
  memoryCommentsStore.set(String(targetKey), list.slice(0, 200));
  return comment;
}

async function voteComment(commentId, voteType) {
  if (commentsCollection) {
    try {
      const { ObjectId } = require("mongodb");
      const field = voteType === "like" ? { likes: 1 } : { dislikes: 1 };
      let objId;
      try { objId = new ObjectId(commentId); } catch(e) { objId = commentId; }
      await commentsCollection.updateOne({ _id: objId }, { $inc: field });
      return true;
    } catch (e) {
      console.error("MongoDB voteComment error:", e);
    }
  }

  for (const [key, list] of memoryCommentsStore.entries()) {
    const target = list.find((c) => c.id === commentId);
    if (target) {
      if (voteType === "like") target.likes = (target.likes || 0) + 1;
      else target.dislikes = (target.dislikes || 0) + 1;
      return true;
    }
  }
  return false;
}

function sendCompressedResponse(req, res, statusCode, headers, bodyData) {
  const acceptEncoding = req.headers["accept-encoding"] || "";
  const buffer = Buffer.isBuffer(bodyData) ? bodyData : Buffer.from(bodyData);

  headers["Access-Control-Allow-Origin"] = "*";
  headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
  headers["Access-Control-Allow-Headers"] = "Content-Type, Accept, Accept-Encoding";
  headers["Vary"] = "Accept-Encoding";

  if (acceptEncoding.includes("gzip")) {
    headers["Content-Encoding"] = "gzip";
    zlib.gzip(buffer, (err, compressed) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Compression error");
        return;
      }
      headers["Content-Length"] = compressed.length;
      res.writeHead(statusCode, headers);
      res.end(compressed);
    });
  } else if (acceptEncoding.includes("deflate")) {
    headers["Content-Encoding"] = "deflate";
    zlib.deflate(buffer, (err, compressed) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Compression error");
        return;
      }
      headers["Content-Length"] = compressed.length;
      res.writeHead(statusCode, headers);
      res.end(compressed);
    });
  } else {
    headers["Content-Length"] = buffer.length;
    res.writeHead(statusCode, headers);
    res.end(buffer);
  }
}

function parseRequestBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        resolve({});
      }
    });
  });
}

function getAppHTML() {
  const filePath = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf8");
  }
  const rootFilePath = path.join(__dirname, "index.html");
  if (fs.existsSync(rootFilePath)) {
    return fs.readFileSync(rootFilePath, "utf8");
  }
  return "<h1>CINESTREAM ACTIVE</h1>";
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Accept-Encoding");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (pathname === "/api/keepalive" || pathname === "/api/ping") {
      const payload = JSON.stringify({ success: true, status: "alive", timestamp: Date.now() });
      sendCompressedResponse(req, res, 200, { "Content-Type": "application/json" }, payload);
      return;
    }

    // Movies API Routes
    if (pathname === "/api/movies/trending") {
      const cacheKey = "movies:trending";
      const cached = getCache(cacheKey);
      if (cached) {
        sendCompressedResponse(req, res, 200, { "Content-Type": "application/json" }, JSON.stringify({ success: true, data: cached }));
        return;
      }
      const data = await fetchTMDB("/trending/movie/day");
      const list = (data.results || []).filter(item => !isAnimeRaw(item)).map(normalizeMovie).filter(Boolean);
      setCache(cacheKey, list, 3600);
      sendCompressedResponse(req, res, 200, { "Content-Type": "application/json" }, JSON.stringify({ success: true, data: list }));
      return;
    }

    if (pathname === "/api/movies/top-rated") {
      const cacheKey = "movies:top-rated";
      const cached = getCache(cacheKey);
      if (cached) {
        sendCompressedResponse(req, res, 200, { "Content-Type": "application/json" }, JSON.stringify({ success: true, data: cached }));
        return;
      }
      const data = await fetchTMDB("/movie/top_rated");
      const list = (data.results || []).filter(item => !isAnimeRaw(item)).map(normalizeMovie).filter(Boolean);
      setCache(cacheKey, list, 3600);
      sendCompressedResponse(req, res, 200, { "Content-Type": "application/json" }, JSON.stringify({ success: true, data: list }));
      return;
    }

    if (pathname === "/api/movies/search") {
      const q = parsedUrl.query.q || "";
      const page = parsedUrl.query.page || 1;
      const genre = parsedUrl.query.genre || "";
      const year = parsedUrl.query.year || "";

      let endpoint = "/search/movie";
      let params = { query: q, page };
      if (!q.trim()) {
        endpoint = "/discover/movie";
        params = { page, sort_by: "popularity.desc" };
        if (genre && genre !== "All") params.with_genres = genre;
        if (year && year !== "All") params.primary_release_year = year;
      }

      const cacheKey = `movies:search:${q}:${page}:${genre}:${year}`;
      const cached = getCache(cacheKey);
      if (cached) {
        sendCompressedResponse(req, res, 200, { "Content-Type": "application/json" }, JSON.stringify({ success: true, data: cached }));
        return;
      }

      const data = await fetchTMDB(endpoint, params);
      const list = (data.results || []).filter(item => !isAnimeRaw(item)).map(normalizeMovie).filter(Boolean);
      setCache(cacheKey, list, 1800);
      sendCompressedResponse(req, res, 200, { "Content-Type": "application/json" }, JSON.stringify({ success: true, data: list }));
      return;
    }

    if (pathname.startsWith("/api/movies/")) {
      const parts = pathname.split("/").filter(Boolean);
      const movieId = parts[2];
      const cacheKey = `movie:detail:${movieId}`;
      const cached = getCache(cacheKey);
      if (cached) {
        sendCompressedResponse(req, res, 200, { "Content-Type": "application/json" }, JSON.stringify({ success: true, data: cached }));
        return;
      }
      const data = await fetchTMDB(`/movie/${movieId}`, { append_to_response: "credits,videos" });
      const movie = normalizeMovie(data);
      if (movie) setCache(cacheKey, movie, 3600);
      sendCompressedResponse(req, res, 200, { "Content-Type": "application/json" }, JSON.stringify({ success: true, data: movie }));
      return;
    }

    // TV Shows API Routes
    if (pathname === "/api/tv/trending") {
      const cacheKey = "tv:trending";
      const cached = getCache(cacheKey);
      if (cached) {
        sendCompressedResponse(req, res, 200, { "Content-Type": "application/json" }, JSON.stringify({ success: true, data: cached }));
        return;
      }
      const data = await fetchTMDB("/trending/tv/day");
      const list = (data.results || []).filter(item => !isAnimeRaw(item)).map(normalizeTV).filter(Boolean);
      setCache(cacheKey, list, 3600);
      sendCompressedResponse(req, res, 200, { "Content-Type": "application/json" }, JSON.stringify({ success: true, data: list }));
      return;
    }

    if (pathname === "/api/tv/top-rated") {
      const cacheKey = "tv:top-rated";
      const cached = getCache(cacheKey);
      if (cached) {
        sendCompressedResponse(req, res, 200, { "Content-Type": "application/json" }, JSON.stringify({ success: true, data: cached }));
        return;
      }
      const data = await fetchTMDB("/tv/top_rated");
      const list = (data.results || []).filter(item => !isAnimeRaw(item)).map(normalizeTV).filter(Boolean);
      setCache(cacheKey, list, 3600);
      sendCompressedResponse(req, res, 200, { "Content-Type": "application/json" }, JSON.stringify({ success: true, data: list }));
      return;
    }

    if (pathname === "/api/tv/search") {
      const q = parsedUrl.query.q || "";
      const page = parsedUrl.query.page || 1;
      const genre = parsedUrl.query.genre || "";
      const year = parsedUrl.query.year || "";

      let endpoint = "/search/tv";
      let params = { query: q, page };
      if (!q.trim()) {
        endpoint = "/discover/tv";
        params = { page, sort_by: "popularity.desc" };
        if (genre && genre !== "All") params.with_genres = genre;
        if (year && year !== "All") params.first_air_date_year = year;
      }

      const cacheKey = `tv:search:${q}:${page}:${genre}:${year}`;
      const cached = getCache(cacheKey);
      if (cached) {
        sendCompressedResponse(req, res, 200, { "Content-Type": "application/json" }, JSON.stringify({ success: true, data: cached }));
        return;
      }

      const data = await fetchTMDB(endpoint, params);
      const list = (data.results || []).filter(item => !isAnimeRaw(item)).map(normalizeTV).filter(Boolean);
      setCache(cacheKey, list, 1800);
      sendCompressedResponse(req, res, 200, { "Content-Type": "application/json" }, JSON.stringify({ success: true, data: list }));
      return;
    }

    if (pathname.includes("/season/")) {
      const parts = pathname.split("/").filter(Boolean);
      const tvId = parts[2];
      const seasonNum = parts[4];
      const cacheKey = `tv:season:${tvId}:${seasonNum}`;
      const cached = getCache(cacheKey);
      if (cached) {
        sendCompressedResponse(req, res, 200, { "Content-Type": "application/json" }, JSON.stringify({ success: true, data: cached }));
        return;
      }
      const data = await fetchTMDB(`/tv/${tvId}/season/${seasonNum}`);
      const episodes = (data.episodes || []).map((e) => ({
        episodeNumber: e.episode_number,
        name: e.name || `Episode ${e.episode_number}`,
        overview: e.overview,
        airDate: e.air_date,
        stillPath: e.still_path ? `https://image.tmdb.org/t/p/w300${e.still_path}` : null,
        voteAverage: e.vote_average ? e.vote_average.toFixed(1) : "N/A",
      }));
      setCache(cacheKey, episodes, 3600);
      sendCompressedResponse(req, res, 200, { "Content-Type": "application/json" }, JSON.stringify({ success: true, data: episodes }));
      return;
    }

    if (pathname.startsWith("/api/tv/")) {
      const parts = pathname.split("/").filter(Boolean);
      const tvId = parts[2];
      const cacheKey = `tv:detail:${tvId}`;
      const cached = getCache(cacheKey);
      if (cached) {
        sendCompressedResponse(req, res, 200, { "Content-Type": "application/json" }, JSON.stringify({ success: true, data: cached }));
        return;
      }
      const data = await fetchTMDB(`/tv/${tvId}`, { append_to_response: "credits,videos" });
      const tv = normalizeTV(data);
      if (tv) setCache(cacheKey, tv, 3600);
      sendCompressedResponse(req, res, 200, { "Content-Type": "application/json" }, JSON.stringify({ success: true, data: tv }));
      return;
    }

    // Comments & Voting Routes
    if (pathname.includes("/vote")) {
      const parts = pathname.split("/").filter(Boolean);
      const commentId = parts[2];
      const body = await parseRequestBody(req);
      const success = await voteComment(commentId, body.type);
      sendCompressedResponse(req, res, 200, { "Content-Type": "application/json" }, JSON.stringify({ success }));
      return;
    }

    if (pathname.includes("/comments")) {
      const targetKey = parsedUrl.query.targetKey || "global";
      if (req.method === "GET") {
        const list = await getComments(targetKey);
        sendCompressedResponse(req, res, 200, { "Content-Type": "application/json" }, JSON.stringify({ success: true, data: list }));
        return;
      }
      if (req.method === "POST") {
        const body = await parseRequestBody(req);
        const saved = await saveComment(targetKey, body);
        if (!saved) {
          sendCompressedResponse(req, res, 400, { "Content-Type": "application/json" }, JSON.stringify({ success: false, error: "Empty comment" }));
          return;
        }
        sendCompressedResponse(req, res, 200, { "Content-Type": "application/json" }, JSON.stringify({ success: true, data: saved }));
        return;
      }
    }

    // Non-API Routes serve the frontend HTML single-page app!
    const htmlContent = getAppHTML();
    sendCompressedResponse(req, res, 200, { "Content-Type": "text/html" }, htmlContent);
  } catch (error) {
    console.error("CineStream Server Error:", error);
    sendCompressedResponse(req, res, 500, { "Content-Type": "application/json" }, JSON.stringify({ success: false, error: error.message || "Internal Error" }));
  }
});

server.listen(PORT, () => {
  cacheStore.clear();
  console.log(`================================================`);
  console.log(`  CINESTREAM TMDB PROXY SERVER LIVE ON PORT ${PORT}!`);
  console.log(`  STRICT ANIME FILTER & 14-MIN KEEP-ALIVE ACTIVE!`);
  console.log(`================================================`);
});
