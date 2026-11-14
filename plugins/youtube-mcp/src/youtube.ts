import { open, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, sep } from "node:path";
import { AUTH_HINT, CONFIG_DIR, SCOPES, UPLOAD_DIRS } from "./config.js";
import { getAccessToken, getStoredScopes } from "./token-store.js";
import {
  checkDate, checkDescription, checkId, checkPublishAt, checkTags, checkTitle, checkToken,
} from "./validate.js";

const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3";
const ANALYTICS_API = "https://youtubeanalytics.googleapis.com/v2/reports";

export const MAX_IDS = 25;
const CHUNK = 8 * 1024 * 1024; // must be a multiple of 256 KiB for resumable uploads

// ---------- quota accounting ----------
// The Data API grants 10,000 units/day by default (resets at midnight Pacific). Costs are the documented
// per-method values; a failed call still costs at least 1, so cost is counted before the status check.
let spent = 0;
export const quotaSpent = () => spent;

// ---------- HTTP ----------
type Params = Record<string, string | number | boolean | undefined>;
interface CallOpts {
  method?: string;
  params?: Params;
  body?: unknown;
  cost: number;
  base?: string;
}

function apiError(status: number, where: string, body: string): Error {
  let reason = "";
  let message = body.slice(0, 500);
  try {
    const e = (JSON.parse(body) as { error?: { message?: string; errors?: { reason?: string }[]; status?: string } }).error;
    reason = e?.errors?.[0]?.reason ?? e?.status ?? "";
    message = e?.message ?? message;
  } catch {
    /* not JSON */
  }
  if (status === 401) return new Error(`Not authenticated: Google rejected the token. Run: ${AUTH_HINT}`);
  if (/insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(reason + body)) {
    return new Error(`Insufficient permissions: the saved login lacks a required scope. Run: ${AUTH_HINT}`);
  }
  if (status === 403 && /quotaExceeded|dailyLimitExceeded|rateLimitExceeded/.test(reason)) {
    return new Error(
      "YouTube API quota exhausted (default 10,000 units/day, resets at midnight Pacific; an upload costs 1,600). " +
        "Try again tomorrow, or request a quota increase in the Google Cloud console.",
    );
  }
  if (reason === "uploadLimitExceeded") return new Error("YouTube upload limit reached for this channel today. Try again later.");
  if (reason === "forbidden" && /channel|upload/i.test(message)) {
    return new Error(`YouTube refused the request: ${message} (the channel may need verification, or the account has no channel).`);
  }
  if (/accessNotConfigured|SERVICE_DISABLED/.test(reason + body)) {
    return new Error(`The required API is not enabled for this Google Cloud project: ${message}`);
  }
  return new Error(`YouTube API ${status} ${where}${reason ? ` (${reason})` : ""}: ${message}`);
}

async function call<T>(path: string, o: CallOpts): Promise<T> {
  const url = new URL(`${o.base ?? API}${path}`);
  for (const [k, v] of Object.entries(o.params ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method: o.method ?? "GET",
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      ...(o.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  spent += o.cost;
  const text = await res.text();
  if (!res.ok) throw apiError(res.status, path, text);
  return (text ? JSON.parse(text) : {}) as T; // deletes return an empty 204
}

// ---------- local files ----------
const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/x-m4v", ".mov": "video/quicktime", ".mkv": "video/x-matroska",
  ".webm": "video/webm", ".avi": "video/x-msvideo", ".mpg": "video/mpeg", ".mpeg": "video/mpeg",
  ".wmv": "video/x-ms-wmv", ".flv": "video/x-flv", ".3gp": "video/3gpp",
};
const IMAGE_TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };
const CAPTION_TYPES: Record<string, string> = {
  ".srt": "application/octet-stream", ".vtt": "application/octet-stream", ".sbv": "application/octet-stream",
  ".ttml": "application/octet-stream", ".dfxp": "application/octet-stream", ".scc": "application/octet-stream",
};

interface LocalFile { path: string; size: number; mime: string }

/**
 * Uploads read arbitrary local paths chosen by the model, so a prompt-injected page or comment could
 * point at ~/.ssh or token.json. Guards: real path (symlinks resolved), regular file, extension
 * allowlist per kind, size cap, never inside the config dir, and optionally an allowlisted folder set.
 */
async function checkLocalFile(p: string, types: Record<string, string>, maxBytes: number, kind: string): Promise<LocalFile> {
  let real: string;
  try {
    real = await realpath(p);
  } catch {
    throw new Error(`${kind} file not found: ${p}`);
  }
  const ext = extname(real).toLowerCase();
  const mime = types[ext];
  if (!mime) throw new Error(`${kind} file type ${ext || "(none)"} is not allowed. Allowed: ${Object.keys(types).join(", ")}`);
  const configReal = await realpath(CONFIG_DIR).catch(() => CONFIG_DIR);
  if (real === configReal || real.startsWith(configReal + sep)) throw new Error("Refusing to read from the plugin config folder.");
  if (UPLOAD_DIRS.length) {
    const roots = await Promise.all(UPLOAD_DIRS.map((d) => realpath(d).catch(() => d)));
    if (!roots.some((r) => real === r || real.startsWith(r + sep))) {
      throw new Error(`${kind} file is outside YOUTUBE_UPLOAD_DIRS (${UPLOAD_DIRS.join(", ")}).`);
    }
  }
  const s = await stat(real);
  if (!s.isFile()) throw new Error(`${kind} path is not a regular file: ${p}`);
  if (s.size === 0) throw new Error(`${kind} file is empty: ${p}`);
  if (s.size > maxBytes) throw new Error(`${kind} file is ${s.size} bytes; the limit is ${maxBytes}.`);
  return { path: real, size: s.size, mime };
}

// ---------- resumable upload ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Starts a resumable session and returns the session URL (which itself authorises the PUTs). */
async function startResumable(path: string, method: "POST" | "PUT", params: Params, metadata: unknown, file: LocalFile, cost: number): Promise<string> {
  const url = new URL(`${UPLOAD_API}${path}`);
  url.searchParams.set("uploadType", "resumable");
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(file.size),
      "X-Upload-Content-Type": file.mime,
    },
    body: JSON.stringify(metadata),
  });
  spent += cost;
  if (!res.ok) throw apiError(res.status, path, await res.text());
  const location = res.headers.get("location");
  if (!location) throw new Error("YouTube did not return an upload session URL.");
  return location;
}

const rangeEnd = (res: Response) => {
  const m = res.headers.get("range")?.match(/bytes=0-(\d+)/);
  return m ? Number(m[1]) + 1 : 0; // next byte to send
};

/** Sends the file in 8 MiB chunks; on a network/5xx failure asks YouTube how much it has and resumes. */
async function putChunks<T>(location: string, file: LocalFile): Promise<T> {
  const fh = await open(file.path, "r");
  try {
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, file.size));
    let offset = 0;
    let failures = 0;
    for (;;) {
      const len = Math.min(CHUNK, file.size - offset);
      const { bytesRead } = await fh.read(buf, 0, len, offset);
      if (bytesRead !== len) throw new Error("The file changed while uploading.");
      let res: Response | undefined;
      try {
        res = await fetch(location, {
          method: "PUT",
          headers: { "Content-Length": String(len), "Content-Range": `bytes ${offset}-${offset + len - 1}/${file.size}`, "Content-Type": file.mime },
          body: new Uint8Array(buf.buffer, buf.byteOffset, len),
        });
      } catch {
        res = undefined;
      }
      if (res && (res.status === 200 || res.status === 201)) return (await res.json()) as T;
      if (res?.status === 308) {
        offset = rangeEnd(res);
        failures = 0;
        continue;
      }
      if (res && res.status < 500 && res.status !== 408 && res.status !== 429) throw apiError(res.status, "upload", await res.text());
      if (++failures > 5) throw new Error(`Upload failed after retries${res ? ` (HTTP ${res.status})` : " (network error)"}. Offset reached: ${offset} of ${file.size} bytes.`);
      await sleep(2 ** failures * 1000);
      // Ask where the session stands before resending.
      try {
        const probe = await fetch(location, { method: "PUT", headers: { "Content-Length": "0", "Content-Range": `bytes */${file.size}` } });
        if (probe.status === 200 || probe.status === 201) return (await probe.json()) as T;
        if (probe.status === 308) offset = rangeEnd(probe);
      } catch {
        /* retry the loop */
      }
    }
  } finally {
    await fh.close();
  }
}

// ---------- shapes ----------
interface Video {
  id: string;
  snippet?: {
    title?: string; description?: string; tags?: string[]; categoryId?: string; publishedAt?: string;
    defaultLanguage?: string; defaultAudioLanguage?: string; channelTitle?: string; liveBroadcastContent?: string;
  };
  status?: {
    uploadStatus?: string; failureReason?: string; rejectionReason?: string; privacyStatus?: string; publishAt?: string;
    license?: string; embeddable?: boolean; publicStatsViewable?: boolean; madeForKids?: boolean;
    selfDeclaredMadeForKids?: boolean; containsSyntheticMedia?: boolean;
  };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  contentDetails?: { duration?: string; definition?: string; caption?: string };
}

export const formatVideo = (v: Video) => ({
  id: v.id,
  url: `https://youtu.be/${v.id}`,
  title: v.snippet?.title,
  description: v.snippet?.description,
  tags: v.snippet?.tags ?? [],
  category_id: v.snippet?.categoryId,
  default_language: v.snippet?.defaultLanguage,
  published_at: v.snippet?.publishedAt,
  privacy: v.status?.privacyStatus,
  publish_at: v.status?.publishAt,
  contains_synthetic_media: v.status?.containsSyntheticMedia,
  made_for_kids: v.status?.madeForKids,
  license: v.status?.license,
  embeddable: v.status?.embeddable,
  upload_status: v.status?.uploadStatus,
  failure_reason: v.status?.failureReason,
  rejection_reason: v.status?.rejectionReason,
  duration: v.contentDetails?.duration,
  has_captions: v.contentDetails?.caption,
  views: v.statistics?.viewCount,
  likes: v.statistics?.likeCount,
  comments: v.statistics?.commentCount,
});

const VIDEO_PARTS = "snippet,status,statistics,contentDetails";

async function fetchVideos(ids: string[], parts = VIDEO_PARTS): Promise<Video[]> {
  const res = await call<{ items?: Video[] }>("/videos", { params: { part: parts, id: ids.join(","), maxResults: 50 }, cost: 1 });
  return res.items ?? [];
}

async function fetchVideo(id: string, parts = VIDEO_PARTS): Promise<Video> {
  const v = (await fetchVideos([checkId("video_id", id)], parts))[0];
  if (!v) throw new Error(`No video ${id} found on this channel (it may be private to another account or deleted).`);
  return v;
}

// ---------- account ----------
export async function authStatus() {
  const res = await call<{
    items?: { id: string; snippet?: { title?: string; customUrl?: string }; statistics?: { subscriberCount?: string; videoCount?: string; viewCount?: string }; contentDetails?: { relatedPlaylists?: { uploads?: string } } }[];
  }>("/channels", { params: { part: "snippet,statistics,contentDetails", mine: true }, cost: 1 });
  const c = res.items?.[0];
  if (!c) throw new Error("This Google account has no YouTube channel. Create one at youtube.com first.");
  const granted = await getStoredScopes();
  return {
    channel_id: c.id,
    title: c.snippet?.title,
    handle: c.snippet?.customUrl,
    subscribers: c.statistics?.subscriberCount,
    video_count: c.statistics?.videoCount,
    uploads_playlist_id: c.contentDetails?.relatedPlaylists?.uploads,
    scopes_granted: granted,
    scopes_missing: SCOPES.filter((s) => !granted.includes(s)),
    upload_dirs: UPLOAD_DIRS.length ? UPLOAD_DIRS : "any folder",
  };
}

export async function listCategories(regionCode: string) {
  const res = await call<{ items?: { id: string; snippet: { title: string; assignable: boolean } }[] }>("/videoCategories", {
    params: { part: "snippet", regionCode }, cost: 1,
  });
  return (res.items ?? []).filter((c) => c.snippet.assignable).map((c) => ({ id: c.id, title: c.snippet.title }));
}

// ---------- videos ----------
export interface UploadInput {
  filePath: string;
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacy: "private" | "unlisted" | "public";
  publishAt?: string;
  containsSyntheticMedia: boolean;
  madeForKids?: boolean;
  defaultLanguage?: string;
  thumbnailPath?: string;
  notifySubscribers: boolean;
  embeddable?: boolean;
  license?: "youtube" | "creativeCommon";
}

export async function uploadVideo(a: UploadInput) {
  const file = await checkLocalFile(a.filePath, VIDEO_TYPES, 256 * 1024 ** 3, "video");
  const publishAt = a.publishAt ? checkPublishAt(a.publishAt) : undefined;
  if (publishAt && a.privacy !== "private") throw new Error("publish_at requires privacy 'private' (YouTube makes it public at that time).");
  const metadata = {
    snippet: {
      title: checkTitle(a.title),
      description: checkDescription(a.description),
      tags: checkTags(a.tags),
      categoryId: a.categoryId,
      ...(a.defaultLanguage ? { defaultLanguage: a.defaultLanguage } : {}),
    },
    status: {
      privacyStatus: a.privacy,
      ...(publishAt ? { publishAt } : {}),
      containsSyntheticMedia: a.containsSyntheticMedia,
      ...(a.madeForKids !== undefined ? { selfDeclaredMadeForKids: a.madeForKids } : {}),
      ...(a.embeddable !== undefined ? { embeddable: a.embeddable } : {}),
      ...(a.license ? { license: a.license } : {}),
    },
  };
  const thumb = a.thumbnailPath ? await checkLocalFile(a.thumbnailPath, IMAGE_TYPES, 2 * 1024 ** 2, "thumbnail") : undefined;
  const session = await startResumable("/videos", "POST", { part: "snippet,status", notifySubscribers: a.notifySubscribers }, metadata, file, 1600);
  const video = await putChunks<Video>(session, file);
  const warnings: string[] = [];
  if (video.status?.privacyStatus && video.status.privacyStatus !== a.privacy) {
    warnings.push(
      `Requested '${a.privacy}' but YouTube set '${video.status.privacyStatus}'. Uploads from API projects that have not passed YouTube's API compliance audit are locked to private; set visibility in YouTube Studio or get the project audited.`,
    );
  }
  if (thumb) {
    try {
      await sendThumbnail(video.id, thumb);
    } catch (e) {
      warnings.push(`Video uploaded but the thumbnail failed: ${e instanceof Error ? e.message : String(e)}. Retry with set_thumbnail.`);
    }
  }
  if (video.status?.containsSyntheticMedia === false && a.containsSyntheticMedia) {
    warnings.push("The AI-content label did not stick; check it in YouTube Studio (Details > Altered content).");
  }
  return { ...formatVideo(video), warnings };
}

export interface UpdateInput {
  videoId: string;
  title?: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  defaultLanguage?: string;
  privacy?: "private" | "unlisted" | "public";
  publishAt?: string;
  containsSyntheticMedia?: boolean;
  madeForKids?: boolean;
  embeddable?: boolean;
  publicStatsViewable?: boolean;
  license?: "youtube" | "creativeCommon";
}

/** videos.update wipes any mutable field you omit, so read the video first and send the merged result. */
export async function updateVideo(a: UpdateInput) {
  const cur = await fetchVideo(a.videoId, "snippet,status");
  const s = cur.snippet ?? {};
  const st = cur.status ?? {};
  const privacy = a.privacy ?? st.privacyStatus;
  let publishAt = a.publishAt ? checkPublishAt(a.publishAt) : a.privacy && a.privacy !== "private" ? undefined : st.publishAt;
  if (publishAt && privacy !== "private") {
    if (a.publishAt) throw new Error("publish_at requires privacy 'private'.");
    publishAt = undefined;
  }
  const snippet = {
    title: a.title !== undefined ? checkTitle(a.title) : s.title,
    description: a.description !== undefined ? checkDescription(a.description) : s.description,
    tags: a.tags !== undefined ? checkTags(a.tags) : s.tags,
    categoryId: a.categoryId ?? s.categoryId,
    defaultLanguage: a.defaultLanguage ?? s.defaultLanguage,
    defaultAudioLanguage: s.defaultAudioLanguage,
  };
  const status = {
    privacyStatus: privacy,
    ...(publishAt ? { publishAt } : {}),
    license: a.license ?? st.license,
    embeddable: a.embeddable ?? st.embeddable,
    publicStatsViewable: a.publicStatsViewable ?? st.publicStatsViewable,
    selfDeclaredMadeForKids: a.madeForKids ?? st.selfDeclaredMadeForKids,
    containsSyntheticMedia: a.containsSyntheticMedia ?? st.containsSyntheticMedia,
  };
  const out = await call<Video>("/videos", { method: "PUT", params: { part: "snippet,status" }, body: { id: cur.id, snippet, status }, cost: 50 });
  return formatVideo(out);
}

export async function getVideo(videoId: string) {
  return formatVideo(await fetchVideo(videoId));
}

let uploadsPlaylist: string | undefined;
export async function listMyVideos(maxResults: number, pageToken?: string) {
  if (!uploadsPlaylist) {
    const ch = await call<{ items?: { contentDetails?: { relatedPlaylists?: { uploads?: string } } }[] }>("/channels", {
      params: { part: "contentDetails", mine: true }, cost: 1,
    });
    uploadsPlaylist = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylist) throw new Error("This Google account has no YouTube channel.");
  }
  const page = await call<{ items?: { contentDetails?: { videoId?: string } }[]; nextPageToken?: string }>("/playlistItems", {
    params: { part: "contentDetails", playlistId: uploadsPlaylist, maxResults: Math.min(maxResults, 50), pageToken }, cost: 1,
  });
  const ids = (page.items ?? []).map((i) => i.contentDetails?.videoId).filter((x): x is string => !!x);
  const videos = ids.length ? await fetchVideos(ids) : [];
  const byId = new Map(videos.map((v) => [v.id, v]));
  return { videos: ids.map((id) => byId.get(id)).filter((v): v is Video => !!v).map(formatVideo), next_page_token: page.nextPageToken };
}

export async function deleteVideo(videoId: string) {
  const v = await fetchVideo(videoId, "snippet");
  await call("/videos", { method: "DELETE", params: { id: v.id }, cost: 50 });
  return { deleted: v.id, title: v.snippet?.title, note: "Permanent: YouTube has no trash for videos." };
}

async function sendThumbnail(videoId: string, file: LocalFile) {
  const url = new URL(`${UPLOAD_API}/thumbnails/set`);
  url.searchParams.set("videoId", videoId);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${await getAccessToken()}`, "Content-Type": file.mime },
    body: await readFile(file.path),
  });
  spent += 50;
  if (!res.ok) throw apiError(res.status, "/thumbnails/set", await res.text());
}

export async function setThumbnail(videoId: string, imagePath: string) {
  const file = await checkLocalFile(imagePath, IMAGE_TYPES, 2 * 1024 ** 2, "thumbnail");
  await sendThumbnail(checkId("video_id", videoId), file);
  return { video_id: videoId, thumbnail: basename(file.path), note: "Custom thumbnails need a phone-verified channel." };
}

// ---------- playlists ----------
interface Playlist {
  id: string;
  snippet?: { title?: string; description?: string; publishedAt?: string };
  status?: { privacyStatus?: string };
  contentDetails?: { itemCount?: number };
}
const formatPlaylist = (p: Playlist) => ({
  id: p.id,
  url: `https://www.youtube.com/playlist?list=${p.id}`,
  title: p.snippet?.title,
  description: p.snippet?.description,
  privacy: p.status?.privacyStatus,
  item_count: p.contentDetails?.itemCount,
  published_at: p.snippet?.publishedAt,
});

export async function listPlaylists(maxResults: number, pageToken?: string) {
  const res = await call<{ items?: Playlist[]; nextPageToken?: string }>("/playlists", {
    params: { part: "snippet,status,contentDetails", mine: true, maxResults: Math.min(maxResults, 50), pageToken }, cost: 1,
  });
  return { playlists: (res.items ?? []).map(formatPlaylist), next_page_token: res.nextPageToken };
}

export async function createPlaylist(title: string, description: string, privacy: string) {
  const res = await call<Playlist>("/playlists", {
    method: "POST", params: { part: "snippet,status" }, cost: 50,
    body: { snippet: { title: checkTitle(title), description: checkDescription(description) }, status: { privacyStatus: privacy } },
  });
  return formatPlaylist(res);
}

export async function updatePlaylist(id: string, p: { title?: string; description?: string; privacy?: string }) {
  checkId("playlist_id", id);
  const cur = (await call<{ items?: Playlist[] }>("/playlists", { params: { part: "snippet,status", id }, cost: 1 })).items?.[0];
  if (!cur) throw new Error(`No playlist ${id} found on this channel.`);
  const res = await call<Playlist>("/playlists", {
    method: "PUT", params: { part: "snippet,status" }, cost: 50,
    body: {
      id,
      snippet: {
        title: p.title !== undefined ? checkTitle(p.title) : cur.snippet?.title,
        description: p.description !== undefined ? checkDescription(p.description) : cur.snippet?.description,
      },
      status: { privacyStatus: p.privacy ?? cur.status?.privacyStatus },
    },
  });
  return formatPlaylist(res);
}

export async function deletePlaylist(id: string) {
  checkId("playlist_id", id);
  const cur = (await call<{ items?: Playlist[] }>("/playlists", { params: { part: "snippet", id }, cost: 1 })).items?.[0];
  if (!cur) throw new Error(`No playlist ${id} found on this channel.`);
  await call("/playlists", { method: "DELETE", params: { id }, cost: 50 });
  return { deleted: id, title: cur.snippet?.title, note: "The videos themselves are not deleted." };
}

export async function listPlaylistItems(playlistId: string, maxResults: number, pageToken?: string) {
  const res = await call<{
    items?: { id: string; snippet?: { title?: string; position?: number; resourceId?: { videoId?: string } } }[];
    nextPageToken?: string;
  }>("/playlistItems", {
    params: { part: "snippet", playlistId: checkId("playlist_id", playlistId), maxResults: Math.min(maxResults, 50), pageToken }, cost: 1,
  });
  return {
    items: (res.items ?? []).map((i) => ({ item_id: i.id, video_id: i.snippet?.resourceId?.videoId, title: i.snippet?.title, position: i.snippet?.position })),
    next_page_token: res.nextPageToken,
  };
}

export async function addToPlaylist(playlistId: string, videoId: string, position?: number) {
  const res = await call<{ id: string; snippet?: { position?: number } }>("/playlistItems", {
    method: "POST", params: { part: "snippet" }, cost: 50,
    body: {
      snippet: {
        playlistId: checkId("playlist_id", playlistId),
        resourceId: { kind: "youtube#video", videoId: checkId("video_id", videoId) },
        ...(position !== undefined ? { position } : {}),
      },
    },
  });
  return { item_id: res.id, playlist_id: playlistId, video_id: videoId, position: res.snippet?.position };
}

export async function removeFromPlaylist(itemId: string) {
  await call("/playlistItems", { method: "DELETE", params: { id: checkId("item_id", itemId) }, cost: 50 });
  return { removed_item: itemId, note: "Only the playlist entry was removed; the video is untouched." };
}

// ---------- captions ----------
interface Caption {
  id: string;
  snippet?: { videoId?: string; language?: string; name?: string; trackKind?: string; isDraft?: boolean; status?: string; lastUpdated?: string };
}
const formatCaption = (c: Caption) => ({
  id: c.id, video_id: c.snippet?.videoId, language: c.snippet?.language, name: c.snippet?.name,
  kind: c.snippet?.trackKind, is_draft: c.snippet?.isDraft, status: c.snippet?.status, last_updated: c.snippet?.lastUpdated,
});

export async function listCaptions(videoId: string) {
  const res = await call<{ items?: Caption[] }>("/captions", { params: { part: "snippet", videoId: checkId("video_id", videoId) }, cost: 50 });
  return (res.items ?? []).map(formatCaption);
}

export async function uploadCaption(videoId: string, language: string, name: string, isDraft: boolean, filePath: string) {
  const file = await checkLocalFile(filePath, CAPTION_TYPES, 10 * 1024 ** 2, "caption");
  const session = await startResumable(
    "/captions", "POST", { part: "snippet" },
    { snippet: { videoId: checkId("video_id", videoId), language, name, isDraft } }, file, 400,
  );
  return formatCaption(await putChunks<Caption>(session, file));
}

export async function updateCaption(captionId: string, isDraft?: boolean, filePath?: string) {
  checkId("caption_id", captionId);
  if (!filePath) {
    if (isDraft === undefined) throw new Error("Nothing to update: pass is_draft and/or file_path.");
    const res = await call<Caption>("/captions", { method: "PUT", params: { part: "snippet" }, body: { id: captionId, snippet: { isDraft } }, cost: 450 });
    return formatCaption(res);
  }
  const file = await checkLocalFile(filePath, CAPTION_TYPES, 10 * 1024 ** 2, "caption");
  const session = await startResumable("/captions", "PUT", { part: "snippet" }, { id: captionId, ...(isDraft !== undefined ? { snippet: { isDraft } } : {}) }, file, 450);
  return formatCaption(await putChunks<Caption>(session, file));
}

export async function deleteCaption(captionId: string) {
  await call("/captions", { method: "DELETE", params: { id: checkId("caption_id", captionId) }, cost: 50 });
  return { deleted: captionId };
}

// ---------- comments ----------
interface Comment {
  id: string;
  snippet?: { authorDisplayName?: string; textOriginal?: string; likeCount?: number; publishedAt?: string; parentId?: string; moderationStatus?: string };
}
interface Thread { id: string; snippet?: { videoId?: string; topLevelComment?: Comment; totalReplyCount?: number }; replies?: { comments?: Comment[] } }
const formatComment = (c: Comment) => ({
  id: c.id, author: c.snippet?.authorDisplayName, text: c.snippet?.textOriginal, likes: c.snippet?.likeCount,
  published_at: c.snippet?.publishedAt, moderation_status: c.snippet?.moderationStatus,
});

export async function listComments(o: { videoId?: string; allForChannel: boolean; order: string; searchTerms?: string; maxResults: number; pageToken?: string; moderationStatus?: string }) {
  if (!o.videoId && !o.allForChannel) throw new Error("Pass video_id, or all_for_channel: true.");
  const ch = o.allForChannel ? (await authStatus()).channel_id : undefined;
  const res = await call<{ items?: Thread[]; nextPageToken?: string }>("/commentThreads", {
    params: {
      part: "snippet,replies",
      ...(o.videoId ? { videoId: checkId("video_id", o.videoId) } : { allThreadsRelatedToChannelId: ch }),
      order: o.order, searchTerms: o.searchTerms, maxResults: Math.min(o.maxResults, 100), pageToken: o.pageToken,
      moderationStatus: o.moderationStatus, textFormat: "plainText",
    },
    cost: 1,
  });
  return {
    threads: (res.items ?? []).map((t) => ({
      thread_id: t.id,
      video_id: t.snippet?.videoId,
      comment: t.snippet?.topLevelComment ? formatComment(t.snippet.topLevelComment) : undefined,
      total_replies: t.snippet?.totalReplyCount,
      replies: (t.replies?.comments ?? []).map(formatComment),
    })),
    next_page_token: res.nextPageToken,
  };
}

export async function postComment(videoId: string, text: string) {
  const res = await call<Thread>("/commentThreads", {
    method: "POST", params: { part: "snippet" }, cost: 50,
    body: { snippet: { videoId: checkId("video_id", videoId), topLevelComment: { snippet: { textOriginal: text } } } },
  });
  return { thread_id: res.id, comment_id: res.snippet?.topLevelComment?.id };
}

export async function replyToComment(parentId: string, text: string) {
  const res = await call<Comment>("/comments", {
    method: "POST", params: { part: "snippet" }, cost: 50,
    body: { snippet: { parentId: checkId("parent_comment_id", parentId), textOriginal: text } },
  });
  return formatComment(res);
}

export async function setCommentModeration(ids: string[], status: "heldForReview" | "published" | "rejected") {
  await call("/comments/setModerationStatus", {
    method: "POST", params: { id: ids.map((i) => checkId("comment id", i)).join(","), moderationStatus: status }, cost: 50,
  });
  return { updated: ids, moderation_status: status };
}

export async function deleteComment(id: string) {
  await call("/comments", { method: "DELETE", params: { id: checkId("comment_id", id) }, cost: 50 });
  return { deleted: id };
}

// ---------- analytics ----------
export async function analyticsQuery(a: {
  startDate: string; endDate: string; metrics: string; dimensions?: string; filters?: string; sort?: string; maxResults?: number;
}) {
  const res = await call<{ columnHeaders: { name: string }[]; rows?: (string | number)[][] }>("", {
    base: ANALYTICS_API, cost: 0, // the Analytics API has its own, separate quota
    params: {
      ids: "channel==MINE",
      startDate: checkDate("start_date", a.startDate),
      endDate: checkDate("end_date", a.endDate),
      metrics: checkToken("metrics", a.metrics, /^[A-Za-z0-9,]+$/),
      dimensions: a.dimensions ? checkToken("dimensions", a.dimensions, /^[A-Za-z0-9,]+$/) : undefined,
      filters: a.filters ? checkToken("filters", a.filters, /^[A-Za-z0-9_,;=\-]+$/) : undefined,
      sort: a.sort ? checkToken("sort", a.sort, /^[A-Za-z0-9,\-]+$/) : undefined,
      maxResults: a.maxResults,
    },
  });
  const names = res.columnHeaders.map((c) => c.name);
  return { columns: names, rows: (res.rows ?? []).map((r) => Object.fromEntries(r.map((v, i) => [names[i], v]))) };
}
