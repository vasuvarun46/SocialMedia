import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleHelp,
  ImagePlus,
  LoaderCircle,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  X,
  XCircle,
} from "lucide-react";

type Platform = "facebook" | "instagram" | "linkedin" | "whatsapp";
type Result = {
  platform: Platform;
  status: "posted" | "declined" | "failed";
  loading: boolean;
  detail: string;
  postId?: string;
};
type Stage = "compose" | "approval" | "results";
type Toast = { id: string; platform: Platform; message: string };

const MAX_IMAGE_MB = 5;
const MAX_VIDEO_MB = 100;

const platforms: {
  id: Platform;
  name: string;
  sub: string;
  mono: string;
  bg: string;
}[] = [
  { id: "facebook",  name: "Facebook",  sub: "Page · Graph API",                            mono: "f",  bg: "#1260CC" },
  { id: "instagram", name: "Instagram", sub: "Business account · needs a public image URL",  mono: "Ig", bg: "#B02A78" },
  { id: "linkedin",  name: "LinkedIn",  sub: "Profile · Posts API",                          mono: "in", bg: "#0A66C2" },
  { id: "whatsapp",  name: "WhatsApp",  sub: "Recipient list · Cloud API",                   mono: "Wa", bg: "#0B7A6B" },
];

export default function App() {
  // Auth state
  const [checkingSession, setCheckingSession] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  // Compose state
  const [file, setFile] = useState<File | null>(null);
  const [mediaUrl, setMediaUrl] = useState("");
  const [caption, setCaption] = useState("");
  const [selected, setSelected] = useState<Platform[]>([]);
  const [fileError, setFileError] = useState("");

  // Workflow state
  const [stage, setStage] = useState<Stage>("compose");
  const [results, setResults] = useState<Result[]>([]);
  const [index, setIndex] = useState(0);
  const [posting, setPosting] = useState(false);

  // Toast notifications
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    fetch("/api/session")
      .then((r) => r.json())
      .then((d) => {
        setAuthRequired(Boolean(d.required));
        setAuthenticated(Boolean(d.authenticated));
        setCheckingSession(false);
      })
      .catch(() => {
        setAuthError("Cannot reach the posting server. Start the server and refresh.");
        setCheckingSession(false);
      });
  }, []);

  // ── Toast management ──────────────────────────────────────

  function addToast(platform: Platform, message: string) {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, platform, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4500);
  }

  function dismissToast(id: string) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  // ── Auth ──────────────────────────────────────────────────

  async function login(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Sign-in failed.");
      setAuthenticated(true);
      setPassword("");
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setAuthLoading(false);
    }
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST" }).catch(() => {});
    setAuthenticated(false);
  }

  // ── File handling ─────────────────────────────────────────

  function pickFile(next?: File) {
    setFileError("");
    if (!next) return;
    const isImage = ["image/jpeg", "image/png"].includes(next.type);
    const isVideo = ["video/mp4", "video/quicktime", "video/webm"].includes(next.type);
    if (!isImage && !isVideo) {
      setFileError("Please choose a JPEG, PNG, MP4, MOV or WebM file.");
      return;
    }
    if (isImage && next.size > MAX_IMAGE_MB * 1024 * 1024) {
      setFileError(`Your image must be ${MAX_IMAGE_MB} MB or smaller.`);
      return;
    }
    if (isVideo && next.size > MAX_VIDEO_MB * 1024 * 1024) {
      setFileError(`Your video must be ${MAX_VIDEO_MB} MB or smaller.`);
      return;
    }
    if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    setFile(next);
    setMediaUrl(URL.createObjectURL(next));
  }

  function removeFile() {
    if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    setFile(null);
    setMediaUrl("");
  }

  // ── Compose flow ──────────────────────────────────────────

  function togglePlatform(id: Platform) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  function begin() {
    if (!file || !caption.trim() || !selected.length) return;
    setResults(
      selected.map((platform) => ({
        platform,
        status: "failed",
        loading: false,
        detail: "Waiting for approval",
      }))
    );
    setIndex(0);
    setStage("approval");
  }

  function advance() {
    if (index + 1 < selected.length) setIndex((i) => i + 1);
    else setStage("results");
  }

  async function postTo(platform: Platform) {
    if (!file) return;
    const form = new FormData();
    form.append("image", file);
    form.append("caption", caption.trim());
    const res = await fetch("/api/post/" + platform, { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success)
      throw new Error(data.error || "The platform could not publish this post.");
    return data;
  }

  async function approve() {
    const platform = selected[index];
    if (!platform) return;
    setPosting(true);
    try {
      const data = await postTo(platform);
      setResults((prev) =>
        prev.map((r) =>
          r.platform === platform
            ? { ...r, status: "posted", detail: "Published successfully", postId: data.postId }
            : r
        )
      );
      const p = platforms.find((x) => x.id === platform)!;
      addToast(platform, `Posted to ${p.name} successfully`);
    } catch (err) {
      setResults((prev) =>
        prev.map((r) =>
          r.platform === platform
            ? { ...r, status: "failed", detail: err instanceof Error ? err.message : "Posting failed" }
            : r
        )
      );
    } finally {
      setPosting(false);
      advance();
    }
  }

  function decline() {
    const platform = selected[index];
    if (!platform) return;
    setResults((prev) =>
      prev.map((r) =>
        r.platform === platform ? { ...r, status: "declined", detail: "Skipped by you" } : r
      )
    );
    advance();
  }

  async function retry(platform: Platform) {
    setResults((prev) =>
      prev.map((r) => (r.platform === platform ? { ...r, loading: true } : r))
    );
    try {
      const data = await postTo(platform);
      setResults((prev) =>
        prev.map((r) =>
          r.platform === platform
            ? { ...r, status: "posted", loading: false, detail: "Published successfully", postId: data.postId }
            : r
        )
      );
      const p = platforms.find((x) => x.id === platform)!;
      addToast(platform, `Posted to ${p.name} successfully`);
    } catch (err) {
      setResults((prev) =>
        prev.map((r) =>
          r.platform === platform
            ? { ...r, loading: false, detail: err instanceof Error ? err.message : "Retry failed" }
            : r
        )
      );
    }
  }

  function reset() {
    if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    setStage("compose");
    setFile(null);
    setMediaUrl("");
    setCaption("");
    setSelected([]);
    setResults([]);
    setFileError("");
  }

  const isVideo = file?.type.startsWith("video/") ?? false;
  const currentPlatform = platforms.find((p) => p.id === selected[index]);
  const posted   = results.filter((r) => r.status === "posted").length;
  const declined = results.filter((r) => r.status === "declined").length;
  const failed   = results.filter((r) => r.status === "failed").length;

  // ── Auth screens ──────────────────────────────────────────

  if (checkingSession) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F6F7F9]">
        <p className="text-sm text-[#5B6475]">Connecting to your posting server…</p>
      </div>
    );
  }

  if (authError && !authRequired) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F6F7F9] px-5">
        <p className="text-sm text-red-600">{authError}</p>
      </div>
    );
  }

  if (authRequired && !authenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F6F7F9] px-5">
        <section className="w-full max-w-md rounded-2xl border border-[#E2E8F0] bg-white p-8 shadow-sm">
          <div className="mb-6 flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#4338CA] text-white">
              <Send size={17} />
            </span>
            <span>
              <b className="block text-[15px] leading-5">postroom</b>
              <small className="text-[11px] uppercase tracking-[.18em] text-[#5B6475]">
                social publisher
              </small>
            </span>
          </div>
          <h1 className="text-2xl font-bold text-[#0F172A]">Sign in to continue</h1>
          <p className="mt-2 text-sm text-[#5B6475]">
            This server can receive public requests for Instagram media. Sign in before publishing.
          </p>
          <form onSubmit={login} className="mt-6 space-y-4">
            <div>
              <label
                className="mb-1.5 block text-sm font-semibold text-[#0F172A]"
                htmlFor="app-password"
              >
                Publisher password
              </label>
              <input
                id="app-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-xl border border-[#E2E8F0] px-4 py-3 text-sm outline-none focus:border-[#4338CA]"
                required
              />
            </div>
            <button
              disabled={authLoading}
              className="w-full rounded-xl bg-[#4338CA] px-5 py-3 text-sm font-semibold text-white hover:bg-[#3730A3] disabled:opacity-60"
            >
              {authLoading ? "Signing in…" : "Sign in"}
            </button>
          </form>
          {authError && <p className="mt-3 text-sm text-red-600">{authError}</p>}
        </section>
      </div>
    );
  }

  // ── Main app ──────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#F6F7F9] text-[#0F172A]">
      {/* Header */}
      <header className="border-b border-[#E2E8F0] bg-white">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between px-6 py-4 sm:px-8">
          <button onClick={reset} className="flex items-center gap-3 text-left">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#4338CA] text-white">
              <Send size={17} />
            </span>
            <span>
              <b className="block text-[15px] leading-5">postroom</b>
              <small className="text-[11px] uppercase tracking-[.18em] text-[#5B6475]">
                social publisher
              </small>
            </span>
          </button>
          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-1.5 text-xs text-[#5B6475] sm:flex">
              <ShieldCheck size={14} className="text-emerald-600" />
              Tokens stay on your server
            </span>
            {authenticated && authRequired && (
              <button
                onClick={logout}
                className="rounded-lg border border-[#E2E8F0] bg-white px-3 py-1.5 text-xs font-medium text-[#5B6475] hover:bg-[#F6F7F9]"
              >
                Sign out
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1200px] px-5 py-8 sm:px-8">
        {/* ── Compose + Approval stage (compose layout stays visible behind modal) ── */}
        {(stage === "compose" || stage === "approval") && (
          <div className="flex flex-wrap gap-6 lg:flex-nowrap">
            {/* Left: compose form */}
            <section
              className="min-w-0 flex-1 rounded-2xl border border-[#E2E8F0] bg-white p-6"
              style={{ flexBasis: "520px" }}
            >
              <div className="mb-5">
                <h1 className="text-xl font-bold">Create post</h1>
                <p className="mt-1 text-sm text-[#5B6475]">
                  Add a photo or video and a caption. You'll approve each platform before anything
                  is sent.
                </p>
              </div>

              {/* Media picker */}
              <div className="mb-5">
                <div className="mb-2 flex items-baseline justify-between">
                  <label className="text-sm font-semibold">
                    Media{" "}
                    <span className="font-normal text-[#5B6475]">
                      · Image (JPEG/PNG up to {MAX_IMAGE_MB} MB) or video (MP4/MOV up to{" "}
                      {MAX_VIDEO_MB} MB)
                    </span>
                  </label>
                  {file && (
                    <button
                      onClick={removeFile}
                      className="text-xs text-[#5B6475] hover:text-[#0F172A]"
                    >
                      Remove
                    </button>
                  )}
                </div>
                <input
                  type="file"
                  accept="image/jpeg,image/png,video/mp4,video/quicktime,video/webm"
                  className="hidden"
                  id="media-picker"
                  onChange={(e) => pickFile(e.target.files?.[0])}
                />
                {file ? (
                  <div className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-white">
                    {isVideo ? (
                      <video
                        src={mediaUrl}
                        className="h-[300px] w-full object-cover"
                        controls
                        playsInline
                        muted
                      />
                    ) : (
                      <button
                        onClick={() => document.getElementById("media-picker")?.click()}
                        className="block w-full"
                      >
                        <img
                          src={mediaUrl}
                          alt="Selected post"
                          className="h-[300px] w-full object-cover"
                        />
                      </button>
                    )}
                    <div className="flex items-center justify-between px-3 py-2">
                      <span className="text-xs text-[#5B6475]">{file.name}</span>
                      <button
                        onClick={() => document.getElementById("media-picker")?.click()}
                        className="text-xs text-[#5B6475] hover:text-[#0F172A]"
                      >
                        Change
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      pickFile(e.dataTransfer.files[0]);
                    }}
                    onClick={() => document.getElementById("media-picker")?.click()}
                    className="flex h-[300px] w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-[#CBD5E1] bg-[#F8FAFC] text-center hover:bg-white"
                  >
                    <span className="mb-3 grid h-12 w-12 place-items-center rounded-xl bg-[#F1F5F9] text-[#5B6475]">
                      <ImagePlus size={22} />
                    </span>
                    <b className="text-sm text-[#334155]">Drop your image or video here</b>
                    <span className="mt-1 text-xs text-[#5B6475]">
                      JPEG, PNG, MP4, MOV · or browse files from your device
                    </span>
                  </button>
                )}
                {fileError && <p className="mt-2 text-sm text-red-600">{fileError}</p>}
              </div>

              {/* Caption */}
              <div>
                <div className="mb-2 flex items-baseline justify-between">
                  <label htmlFor="caption" className="text-sm font-semibold">
                    Caption
                  </label>
                  <span
                    className={`text-xs ${caption.length > 1900 ? "text-amber-600" : "text-[#5B6475]"}`}
                  >
                    {caption.length.toLocaleString()} / 2,000
                  </span>
                </div>
                <textarea
                  id="caption"
                  value={caption}
                  onChange={(e) => setCaption(e.target.value.slice(0, 2000))}
                  rows={5}
                  placeholder="Write something your audience will care about"
                  className="w-full resize-y rounded-xl border border-[#CBD5E1] bg-white px-4 py-3 text-sm leading-6 outline-none focus:border-[#4338CA]"
                />
              </div>
            </section>

            {/* Right: platforms panel */}
            <section
              className="min-w-0 flex-1 rounded-2xl border border-[#E2E8F0] bg-white p-6"
              style={{ flexBasis: "400px" }}
            >
              <div className="mb-4">
                <h2 className="text-xl font-bold">Platforms</h2>
                <p className="mt-1 text-sm text-[#5B6475]">
                  {selected.length === 0
                    ? "Choose where to post. You'll approve each one before it goes live."
                    : `${selected.length} platform${selected.length === 1 ? "" : "s"} selected`}
                </p>
              </div>

              <div className="mb-5 space-y-2.5">
                {platforms.map((p) => {
                  const checked = selected.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      onClick={() => togglePlatform(p.id)}
                      className={`flex w-full items-center gap-3 rounded-xl border p-3.5 text-left transition-colors ${
                        checked
                          ? "border-[#4338CA] bg-[#EEF2FF]"
                          : "border-[#E2E8F0] bg-white hover:bg-[#F6F7F9]"
                      }`}
                    >
                      <span
                        className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-[15px] font-bold text-white"
                        style={{ background: p.bg }}
                      >
                        {p.mono}
                      </span>
                      <span className="min-w-0 flex-1">
                        <b className="block text-sm">{p.name}</b>
                        <small className="text-xs text-[#5B6475]">{p.sub}</small>
                      </span>
                      <span
                        className={`grid h-5 w-5 shrink-0 place-items-center rounded-md border ${
                          checked
                            ? "border-[#4338CA] bg-[#4338CA] text-white"
                            : "border-[#CBD5E1] bg-white"
                        }`}
                      >
                        {checked && <Check size={12} />}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="mb-5 flex gap-3 rounded-xl bg-[#F1F5F9] p-3.5">
                <ShieldCheck size={16} className="mt-0.5 shrink-0 text-[#5B6475]" />
                <p className="text-xs leading-5 text-[#334155]">
                  Posts use official platform APIs after your approval. Credentials never touch
                  this page.
                </p>
              </div>

              <button
                disabled={!file || !caption.trim() || !selected.length || stage === "approval"}
                onClick={begin}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#4338CA] px-5 py-3 text-sm font-semibold text-white hover:bg-[#3730A3] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Review {selected.length || ""}{" "}
                {selected.length === 1 ? "post" : "posts"}
                <ArrowRight size={15} />
              </button>
              <p className="mt-2.5 text-center text-xs text-[#5B6475]">
                {!file
                  ? "Add a photo or video to continue."
                  : !caption.trim()
                  ? "Add a caption to continue."
                  : "You'll approve each platform before anything is sent."}
              </p>
            </section>
          </div>
        )}

        {/* ── Results stage ── */}
        {stage === "results" && (
          <div className="mx-auto max-w-2xl">
            <div className="mb-8 text-center">
              <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-[#EEF2FF] text-[#4338CA]">
                <Sparkles size={22} />
              </div>
              <h1 className="text-3xl font-bold">Post results</h1>
              <p className="mt-2 text-sm text-[#5B6475]">Here's where everything landed.</p>
            </div>

            <div className="mb-5 grid grid-cols-3 gap-3">
              {[
                { label: "Posted",   count: posted,   icon: <CheckCircle2 size={15} />, fg: "text-[#166534]", bg: "bg-[#DCFCE7]" },
                { label: "Declined", count: declined, icon: <XCircle size={15} />,      fg: "text-[#475569]", bg: "bg-[#F1F5F9]" },
                { label: "Failed",   count: failed,   icon: <CircleHelp size={15} />,   fg: "text-[#991B1B]", bg: "bg-[#FEE2E2]" },
              ].map((s) => (
                <div
                  key={s.label}
                  className={`rounded-xl border border-[#E2E8F0] ${s.bg} p-3 text-center sm:p-4`}
                >
                  <div className={`mb-1 flex items-center justify-center gap-1.5 text-xs font-semibold ${s.fg}`}>
                    {s.icon}
                    {s.label}
                  </div>
                  <p className="text-2xl font-bold text-[#0F172A]">{s.count}</p>
                </div>
              ))}
            </div>

            <div className="mb-6 space-y-2.5">
              {results.map((r) => {
                const p = platforms.find((x) => x.id === r.platform)!;
                return (
                  <div
                    key={r.platform}
                    className="flex items-center gap-3 rounded-xl border border-[#E2E8F0] bg-white p-4"
                  >
                    <span
                      className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-[15px] font-bold text-white"
                      style={{ background: p.bg }}
                    >
                      {p.mono}
                    </span>
                    <span className="min-w-0 flex-1">
                      <b className="block text-sm">{p.name}</b>
                      <small className="block truncate text-xs text-[#5B6475]">
                        {r.detail}
                        {r.postId ? ` · ${r.postId}` : ""}
                      </small>
                    </span>
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                        r.status === "posted"
                          ? "bg-[#DCFCE7] text-[#166534]"
                          : r.status === "declined"
                          ? "bg-[#F1F5F9] text-[#475569]"
                          : "bg-[#FEE2E2] text-[#991B1B]"
                      }`}
                    >
                      {r.status === "posted"
                        ? "Posted"
                        : r.status === "declined"
                        ? "Declined"
                        : "Failed"}
                    </span>
                    {r.status === "failed" && (
                      <button
                        disabled={r.loading}
                        onClick={() => retry(r.platform)}
                        className="ml-1 flex items-center gap-1.5 rounded-lg border border-[#E2E8F0] px-2.5 py-2 text-xs font-semibold text-[#0F172A] disabled:opacity-50"
                      >
                        <RotateCcw size={12} className={r.loading ? "animate-spin" : ""} />
                        <span className="hidden sm:inline">
                          {r.loading ? "Retrying…" : "Retry"}
                        </span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="text-center">
              <button
                onClick={reset}
                className="inline-flex items-center gap-2 rounded-xl bg-[#4338CA] px-5 py-3 text-sm font-semibold text-white hover:bg-[#3730A3]"
              >
                <ArrowLeft size={15} />
                Create another post
              </button>
            </div>
          </div>
        )}
      </main>

      {/* ── Approval modal ── */}
      {stage === "approval" && currentPlatform && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-[#0F172A]/55 p-6">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="approve-title"
            className="w-full max-w-[560px] rounded-2xl bg-white p-6 shadow-2xl"
          >
            {/* Progress bar */}
            <div className="mb-5">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-medium text-[#5B6475]">
                  Reviewing {index + 1} of {selected.length}
                </span>
                <button
                  onClick={() => setStage("compose")}
                  className="flex items-center gap-1 text-xs text-[#5B6475] hover:text-[#0F172A]"
                >
                  <ArrowLeft size={12} />
                  Back
                </button>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-[#E2E8F0]">
                <div
                  className="h-full rounded-full bg-[#4338CA] transition-all duration-300"
                  style={{ width: `${((index + 1) / selected.length) * 100}%` }}
                />
              </div>
            </div>

            {/* Platform identity */}
            <div className="mb-5 flex items-center gap-3">
              <span
                className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-[15px] font-bold text-white"
                style={{ background: currentPlatform.bg }}
              >
                {currentPlatform.mono}
              </span>
              <div>
                <h3 id="approve-title" className="text-lg font-bold">
                  Approve posting to {currentPlatform.name}?
                </h3>
                <p className="text-xs text-[#5B6475]">{currentPlatform.sub}</p>
              </div>
            </div>

            {/* Post preview */}
            <div className="mb-5 flex gap-4 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3">
              {file && (
                isVideo ? (
                  <video
                    src={mediaUrl}
                    className="h-[120px] w-[160px] shrink-0 rounded-lg object-cover"
                    muted
                    playsInline
                  />
                ) : (
                  <img
                    src={mediaUrl}
                    alt="Post preview"
                    className="h-[120px] w-[160px] shrink-0 rounded-lg object-cover"
                  />
                )
              )}
              <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-6 text-[#0F172A]">
                {caption}
              </p>
            </div>

            {/* Actions */}
            {posting ? (
              <div className="flex min-h-[48px] items-center gap-3 text-sm text-[#334155]">
                <LoaderCircle className="animate-spin text-[#4338CA]" size={18} />
                Posting to {currentPlatform.name}…
              </div>
            ) : (
              <>
                <div className="flex gap-3">
                  <button
                    onClick={decline}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-[#E2E8F0] bg-white px-4 py-3 text-sm font-semibold text-[#0F172A] hover:bg-[#F6F7F9]"
                  >
                    <X size={15} />
                    Decline
                  </button>
                  <button
                    onClick={approve}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#4338CA] px-4 py-3 text-sm font-semibold text-white hover:bg-[#3730A3]"
                  >
                    <Check size={15} />
                    Approve & post
                  </button>
                </div>
                <p className="mt-2.5 text-center text-xs text-[#5B6475]">
                  Declining skips {currentPlatform.name}. Nothing is sent to it.
                </p>
              </>
            )}
          </section>
        </div>
      )}

      {/* ── Toast notifications ── */}
      <div className="fixed right-5 top-5 z-50 flex flex-col gap-2.5" aria-live="polite">
        {toasts.map((t) => {
          const p = platforms.find((x) => x.id === t.platform)!;
          return (
            <div
              key={t.id}
              className="flex items-start gap-3 rounded-xl border border-[#E2E8F0] bg-white px-4 py-3 shadow-lg"
              style={{ borderLeftWidth: "4px", borderLeftColor: p.bg }}
            >
              <span
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-sm font-bold text-white"
                style={{ background: p.bg }}
              >
                {p.mono}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-[#0F172A]">{p.name}</p>
                <p className="text-xs text-[#5B6475]">{t.message}</p>
              </div>
              <button
                onClick={() => dismissToast(t.id)}
                className="ml-1 shrink-0 text-[#5B6475] hover:text-[#0F172A]"
                aria-label="Dismiss"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>

      <footer className="border-t border-[#E2E8F0]">
        <div className="mx-auto flex max-w-[1200px] flex-col items-center justify-between gap-3 px-5 py-5 text-[11px] text-[#5B6475] sm:flex-row sm:px-8">
          <span>postroom · a thoughtful way to share</span>
          <span className="flex items-center gap-1.5">
            <ShieldCheck size={13} />
            Tokens live on your server. Always.
          </span>
        </div>
      </footer>
    </div>
  );
}
