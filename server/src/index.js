import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const uploadRoot = path.resolve(root, process.env.UPLOAD_DIR || "./uploads");
await fs.mkdir(uploadRoot, { recursive: true });

const app = express();
const port = Number(process.env.PORT || 3001);
const allowed = new Set(["facebook", "instagram", "linkedin", "whatsapp"]);
const maxImageBytes = 5 * 1024 * 1024;
const maxVideoMB = Math.max(1, Number(process.env.MAX_VIDEO_MB || 100));
const maxVideoBytes = maxVideoMB * 1024 * 1024;

const appPassword = process.env.APP_PASSWORD || "";
if (process.env.PUBLIC_BASE_URL?.trim() && !appPassword)
  throw Error("Set APP_PASSWORD before exposing the server with PUBLIC_BASE_URL.");

const sessions = new Map();
// Purge expired sessions every hour to prevent memory accumulation
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of sessions) if (expiry < now) sessions.delete(token);
}, 60 * 60 * 1000).unref();

app.use(express.json());
app.use("/media", express.static(uploadRoot, {
  index: false,
  dotfiles: "deny",
  setHeaders: (r) => r.setHeader("Cache-Control", "public, max-age=1800"),
}));

const allowedMimeTypes = new Set([
  "image/jpeg", "image/png",
  "video/mp4", "video/quicktime", "video/webm",
]);

const storage = multer.diskStorage({
  destination: (_q, _f, cb) => cb(null, uploadRoot),
  filename: (_q, f, cb) => {
    const ext =
      f.mimetype === "image/png"       ? ".png"  :
      f.mimetype === "video/mp4"       ? ".mp4"  :
      f.mimetype === "video/quicktime" ? ".mov"  :
      f.mimetype === "video/webm"      ? ".webm" : ".jpg";
    cb(null, randomUUID() + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: maxVideoBytes, files: 1, fields: 2, fieldSize: 10 * 1024 },
  fileFilter: (_q, f, cb) =>
    allowedMimeTypes.has(f.mimetype)
      ? cb(null, true)
      : cb(new Error("Upload a JPEG, PNG, MP4, MOV or WebM file.")),
});

const meta = () => process.env.META_GRAPH_API_VERSION || "v27.0";

const requirements = {
  facebook:  ["FACEBOOK_PAGE_ID", "FACEBOOK_PAGE_ACCESS_TOKEN"],
  instagram: ["INSTAGRAM_ACCOUNT_ID", "INSTAGRAM_ACCESS_TOKEN", "PUBLIC_BASE_URL"],
  linkedin:  ["LINKEDIN_VERSION", "LINKEDIN_ACCESS_TOKEN", "LINKEDIN_AUTHOR_URN"],
  whatsapp:  ["WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_RECIPIENT", "WHATSAPP_ACCESS_TOKEN"],
};

function missing(p) {
  return requirements[p].find((k) => !process.env[k]?.trim());
}

function safeError(p, status) {
  if (status === 401 || status === 403) return p + " rejected credentials or permissions. Check server configuration.";
  if (status === 429) return p + " rate limit reached. Wait and retry.";
  if (status >= 500)  return p + " is temporarily unavailable. Retry in a moment.";
  return p + " could not publish this post. Check account settings and file requirements.";
}

async function call(url, options, p) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(45000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(p + " API error", { status: response.status, code: body?.error?.code, type: body?.error?.type });
    const e = Error(safeError(p, response.status));
    e.status = response.status >= 500 ? 503 : 502;
    throw e;
  }
  return { response, body };
}

function multipart(file, name = "file") {
  const form = new FormData();
  form.append(name, new Blob([file.buffer], { type: file.mimetype }), file.originalname || "upload");
  return form;
}

// ── Platform adapters ─────────────────────────────────────

async function facebook(file, caption) {
  const authHeader = { Authorization: "Bearer " + process.env.FACEBOOK_PAGE_ACCESS_TOKEN };
  if (file.mimetype.startsWith("video/")) {
    const form = multipart(file, "source");
    form.append("description", caption);
    const { body } = await call(
      "https://graph.facebook.com/" + meta() + "/" + encodeURIComponent(process.env.FACEBOOK_PAGE_ID) + "/videos",
      { method: "POST", body: form, headers: authHeader },
      "Facebook"
    );
    return body.id;
  }
  const form = multipart(file, "source");
  form.append("message", caption);
  const { body } = await call(
    "https://graph.facebook.com/" + meta() + "/" + encodeURIComponent(process.env.FACEBOOK_PAGE_ID) + "/photos",
    { method: "POST", body: form, headers: authHeader },
    "Facebook"
  );
  return body.id;
}

async function instagram(file, caption) {
  const base = process.env.PUBLIC_BASE_URL?.trim();
  if (!base) throw Error("Instagram publishing requires PUBLIC_BASE_URL.");
  const origin = new URL(base);
  if (process.env.NODE_ENV === "production" && origin.protocol !== "https:")
    throw Error("PUBLIC_BASE_URL must use HTTPS in production.");
  const apiRoot = "https://graph.facebook.com/" + meta() + "/" + encodeURIComponent(process.env.INSTAGRAM_ACCOUNT_ID);
  const fileUrl = origin.origin + "/media/" + encodeURIComponent(file.filename);
  const isVideo = file.mimetype.startsWith("video/");
  const url = new URL(apiRoot + "/media");
  if (isVideo) {
    url.searchParams.set("media_type", "REELS");
    url.searchParams.set("video_url", fileUrl);
  } else {
    url.searchParams.set("image_url", fileUrl);
  }
  url.searchParams.set("caption", caption);
  url.searchParams.set("access_token", process.env.INSTAGRAM_ACCESS_TOKEN);
  const { body: c } = await call(url, { method: "POST" }, "Instagram");
  if (!c.id) throw Error("Instagram did not return a media container ID.");
  // Poll for processing completion (90-second wall-clock cap)
  let state = "IN_PROGRESS";
  const wallStart = Date.now();
  for (let attempt = 0; attempt < 30 && state !== "FINISHED" && Date.now() - wallStart < 90000; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const statusUrl = new URL("https://graph.facebook.com/" + meta() + "/" + encodeURIComponent(c.id));
    statusUrl.searchParams.set("fields", "status_code");
    statusUrl.searchParams.set("access_token", process.env.INSTAGRAM_ACCESS_TOKEN);
    const { body: status } = await call(statusUrl, { method: "GET" }, "Instagram");
    state = status.status_code;
    if (state === "ERROR" || state === "EXPIRED")
      throw Error("Instagram could not process the uploaded media.");
  }
  if (state !== "FINISHED") throw Error("Instagram is still processing this media. Retry in a moment.");
  const publish = new URL(apiRoot + "/media_publish");
  publish.searchParams.set("creation_id", c.id);
  publish.searchParams.set("access_token", process.env.INSTAGRAM_ACCESS_TOKEN);
  const { body } = await call(publish, { method: "POST" }, "Instagram");
  return body.id;
}

async function linkedin(file, caption) {
  const headers = {
    Authorization: "Bearer " + process.env.LINKEDIN_ACCESS_TOKEN,
    "LinkedIn-Version": process.env.LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
    "Content-Type": "application/json",
  };
  const author = process.env.LINKEDIN_AUTHOR_URN;

  if (file.mimetype.startsWith("video/")) {
    // Step 1: initialize video upload
    const init = await call(
      "https://api.linkedin.com/rest/videos?action=initializeUpload",
      { method: "POST", headers, body: JSON.stringify({ initializeUploadRequest: { owner: author, fileSizeBytes: file.buffer.length, uploadCaptions: false, uploadThumbnail: false } }) },
      "LinkedIn"
    );
    const instructions = init.body?.value?.uploadInstructions;
    const uploadToken = init.body?.value?.uploadToken;
    const videoUrn = init.body?.value?.video;
    if (!instructions?.length || !videoUrn) throw Error("LinkedIn did not provide a video upload URL.");
    // Step 2: upload each chunk
    const uploadedPartIds = [];
    for (const instr of instructions) {
      const chunk = file.buffer.subarray(instr.firstByte, instr.lastByte + 1);
      const res = await fetch(instr.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: chunk,
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) { const e = Error(safeError("LinkedIn", res.status)); e.status = 502; throw e; }
      uploadedPartIds.push(res.headers.get("etag") || String(uploadedPartIds.length));
    }
    // Step 3: finalize upload
    await call(
      "https://api.linkedin.com/rest/videos?action=finalizeUpload",
      { method: "POST", headers, body: JSON.stringify({ finalizeUploadRequest: { video: videoUrn, uploadToken, uploadedPartIds } }) },
      "LinkedIn"
    );
    // Step 4: create post
    const { response } = await call(
      "https://api.linkedin.com/rest/posts",
      { method: "POST", headers, body: JSON.stringify({ author, commentary: caption, visibility: "PUBLIC", distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] }, content: { media: { title: "Social post video", id: videoUrn } }, lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false }) },
      "LinkedIn"
    );
    return response.headers.get("x-restli-id") || videoUrn;
  }

  // Image: initialize upload
  const init = await call(
    "https://api.linkedin.com/rest/images?action=initializeUpload",
    { method: "POST", headers, body: JSON.stringify({ initializeUploadRequest: { owner: author } }) },
    "LinkedIn"
  );
  const url = init.body?.value?.uploadUrl;
  const image = init.body?.value?.image;
  if (!url || !image) throw Error("LinkedIn did not provide an image upload URL.");
  const uploaded = await fetch(url, { method: "PUT", headers: { "Content-Type": file.mimetype }, body: file.buffer, signal: AbortSignal.timeout(45000) });
  if (!uploaded.ok) { const e = Error(safeError("LinkedIn", uploaded.status)); e.status = 502; throw e; }
  const { response } = await call(
    "https://api.linkedin.com/rest/posts",
    { method: "POST", headers, body: JSON.stringify({ author, commentary: caption, visibility: "PUBLIC", distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] }, content: { media: { title: "Social post image", id: image } }, lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false }) },
    "LinkedIn"
  );
  return response.headers.get("x-restli-id") || image;
}

async function whatsapp(file, caption) {
  const apiRoot = "https://graph.facebook.com/" + meta() + "/" + encodeURIComponent(process.env.WHATSAPP_PHONE_NUMBER_ID);
  const headers = { Authorization: "Bearer " + process.env.WHATSAPP_ACCESS_TOKEN };
  const form = multipart(file);
  form.append("messaging_product", "whatsapp");
  const { body: media } = await call(apiRoot + "/media", { method: "POST", headers, body: form }, "WhatsApp");
  if (!media.id) throw Error("WhatsApp did not return a media ID.");
  const isVideo = file.mimetype.startsWith("video/");
  const mediaType = isVideo ? "video" : "image";
  const { body } = await call(apiRoot + "/messages", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: process.env.WHATSAPP_RECIPIENT,
      type: mediaType,
      [mediaType]: { id: media.id, caption },
    }),
  }, "WhatsApp");
  return body.messages?.[0]?.id;
}

const adapters = { facebook, instagram, linkedin, whatsapp };

// ── Validation ────────────────────────────────────────────

function validSignature(file) {
  const b = file.buffer;
  if (file.mimetype.startsWith("video/")) {
    // MP4 / MOV: 'ftyp' box at bytes 4–7
    const mp4  = b.length >= 8 && b.subarray(4, 8).equals(Buffer.from("ftyp"));
    // WebM: starts with EBML magic 0x1A 0x45 0xDF 0xA3
    const webm = b.length >= 4 && b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3;
    return mp4 || webm;
  }
  const png = b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpg = b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255;
  return file.mimetype === "image/png" ? png : file.mimetype === "image/jpeg" && jpg;
}

// ── Auth middleware & endpoints ───────────────────────────

function sessionFor(q) {
  const token = (q.headers.cookie || "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("publisher_session="))
    ?.slice("publisher_session=".length);
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry || expiry < Date.now()) { sessions.delete(token); return false; }
  return token;
}

function requireSession(q, r, next) {
  if (!appPassword || sessionFor(q)) return next();
  return r.status(401).json({ success: false, error: "Sign in before publishing." });
}

app.get("/api/session", (q, r) =>
  r.json({ required: Boolean(appPassword), authenticated: !appPassword || Boolean(sessionFor(q)) })
);

app.post("/api/login", (q, r) => {
  if (!appPassword) return r.json({ success: true });
  const provided = Buffer.from(String(q.body?.password || ""));
  const expected = Buffer.from(appPassword);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
    return r.status(401).json({ success: false, error: "That password did not match." });
  const token = randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
  r.setHeader("Set-Cookie",
    "publisher_session=" + token + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200" +
    (process.env.NODE_ENV === "production" ? "; Secure" : "")
  );
  return r.json({ success: true });
});

app.post("/api/logout", (q, r) => {
  const token = sessionFor(q);
  if (token) sessions.delete(token);
  r.setHeader("Set-Cookie",
    "publisher_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" +
    (process.env.NODE_ENV === "production" ? "; Secure" : "")
  );
  return r.json({ success: true });
});

app.get("/api/health", (_q, r) =>
  r.json({ ok: true, mockPosting: process.env.MOCK_POSTING === "true" })
);

// ── Post endpoint ─────────────────────────────────────────

app.post("/api/post/:platform", requireSession, upload.single("image"), async (q, r) => {
  const p = q.params.platform.toLowerCase();
  if (!allowed.has(p)) return r.status(400).json({ success: false, error: "Unsupported platform." });
  if (!q.file)         return r.status(400).json({ success: false, error: "A media file is required." });
  try {
    const buffer = await fs.readFile(q.file.path);
    // Images have a tighter size limit than videos
    if (q.file.mimetype.startsWith("image/") && buffer.length > maxImageBytes)
      return r.status(400).json({ success: false, error: "Image must be 5 MB or smaller." });
    if (!validSignature({ ...q.file, buffer }))
      return r.status(400).json({ success: false, error: "The upload is not a valid image or video file." });
    const caption = typeof q.body.caption === "string" ? q.body.caption.trim() : "";
    if (!caption)              return r.status(400).json({ success: false, error: "A caption is required." });
    if (caption.length > 2000) return r.status(400).json({ success: false, error: "Caption must be 2,000 characters or fewer." });
    const file = { ...q.file, buffer };
    if (process.env.MOCK_POSTING === "true") {
      await new Promise((resolve) => setTimeout(resolve, 350));
      if ((process.env.MOCK_FAIL_PLATFORMS || "").split(",").map((x) => x.trim().toLowerCase()).includes(p))
        return r.status(502).json({ success: false, error: "Mock failure for " + p + ". Remove it from MOCK_FAIL_PLATFORMS to retry successfully." });
      return r.json({ success: true, platform: p, postId: "mock_" + p + "_" + randomUUID() });
    }
    const key = missing(p);
    if (key) return r.status(503).json({ success: false, error: "Server configuration is missing " + key + "." });
    const postId = await adapters[p](file, caption);
    return r.json({ success: true, platform: p, postId: postId || null });
  } catch (e) {
    console.error("Posting failed", { platform: p, message: e.message, status: e.status });
    return r.status(e.status || 502).json({ success: false, error: e.message || "The platform could not publish this post." });
  } finally {
    try { await fs.unlink(q.file.path); } catch {}
  }
});

// ── Error handler ─────────────────────────────────────────

app.use((e, _q, r, _n) => {
  if (e instanceof multer.MulterError)
    return r.status(400).json({ success: false, error: e.code === "LIMIT_FILE_SIZE" ? "File must be " + maxVideoMB + " MB or smaller." : "Upload could not be accepted." });
  if (e) return r.status(400).json({ success: false, error: e.message || "Invalid request." });
  return r.status(500).json({ success: false, error: "Unexpected server error." });
});

// ── Upload cleanup ────────────────────────────────────────

const ttl = Math.max(5, Number(process.env.UPLOAD_TTL_MINUTES || 30));
setInterval(async () => {
  try {
    const now = Date.now();
    const entries = await fs.readdir(uploadRoot, { withFileTypes: true });
    await Promise.all(entries.filter((x) => x.isFile()).map(async (x) => {
      const f = path.join(uploadRoot, x.name);
      if (now - (await fs.stat(f)).mtimeMs > ttl * 60000) await fs.unlink(f);
    }));
  } catch (e) {
    console.error("Upload cleanup failed", e.message);
  }
}, 300000).unref();

app.listen(port, process.env.HOST || "127.0.0.1", () =>
  console.log("Social Post Publisher API listening on http://localhost:" + port)
);
