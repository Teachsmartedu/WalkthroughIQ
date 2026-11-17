import { Hono } from "hono";
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { desc, eq, sql } from "drizzle-orm";
import { getStore } from "@netlify/blobs";
import { db } from "../../db/index.ts";
import { observations, rosterEntries } from "../../db/schema.ts";

type AuthUser = { id: string; email: string; name: string | null };
type Env = { Variables: { user: AuthUser } };

const photoStore = getStore({ name: "observation-photos", consistency: "strong" });

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Authentication: every /api route requires a signed-in Netlify Identity user.
// The browser library keeps the `nf_jwt` cookie in sync with the session, so
// same-origin fetches and <img> requests carry it automatically. We validate the
// token against this site's Identity endpoint, which rejects expired, forged or
// deleted-user tokens.
// ---------------------------------------------------------------------------
const tokenCache = new Map<string, { user: AuthUser; expires: number }>();

async function verifyToken(token: string, origin: string): Promise<AuthUser | null> {
  const cached = tokenCache.get(token);
  if (cached && cached.expires > Date.now()) return cached.user;

  const res = await fetch(`${origin}/.netlify/identity/user`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    tokenCache.delete(token);
    return null;
  }
  const body = (await res.json()) as { id: string; email: string; user_metadata?: { full_name?: string } };
  const user: AuthUser = { id: body.id, email: body.email, name: body.user_metadata?.full_name ?? null };

  if (tokenCache.size > 500) tokenCache.clear();
  tokenCache.set(token, { user, expires: Date.now() + 60_000 });
  return user;
}

async function requireUser(c: Context<Env>, next: Next) {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : getCookie(c, "nf_jwt");
  if (!token) return c.json({ error: "Not signed in" }, 401);

  const origin = new URL(c.req.url).origin;
  let user: AuthUser | null = null;
  try {
    user = await verifyToken(token, origin);
  } catch (err) {
    console.error("Identity verification failed", err);
  }
  if (!user) return c.json({ error: "Session expired. Please sign in again." }, 401);

  c.set("user", user);
  await next();
}

app.use("/api/*", requireUser);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type Photo = { caption?: string; dataUrl?: string; url?: string };
type Observation = { id: string; photos?: Photo[]; [key: string]: unknown };

const DATA_URL_RE = /^data:([\w.+/-]+);base64,(.+)$/;

// Moves inline base64 photos into Netlify Blobs and replaces them with a URL,
// keeping database rows small.
async function extractPhotos(obs: Observation): Promise<Observation> {
  if (!Array.isArray(obs.photos)) return { ...obs, photos: [] };
  const photos: Photo[] = [];
  for (const [i, photo] of obs.photos.entries()) {
    const match = typeof photo?.dataUrl === "string" ? photo.dataUrl.match(DATA_URL_RE) : null;
    if (!match) {
      photos.push(photo);
      continue;
    }
    const [, contentType, base64] = match;
    const key = `${obs.id}/${i}-${crypto.randomUUID()}`;
    const bytes = Buffer.from(base64, "base64");
    await photoStore.set(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
      metadata: { contentType },
    });
    photos.push({ caption: photo.caption, url: `/api/photos/${key}` });
  }
  return { ...obs, photos };
}

function isValidObservation(obs: unknown): obs is Observation {
  return !!obs && typeof obs === "object" && typeof (obs as Observation).id === "string" && (obs as Observation).id.length > 0;
}

function isOwner(createdBy: string | null, user: AuthUser): boolean {
  return !!createdBy && createdBy.toLowerCase() === user.email.toLowerCase();
}

function cleanName(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

async function loadAll() {
  const [obsRows, rosterRows] = await Promise.all([
    db.select().from(observations).orderBy(desc(observations.createdAt)),
    db.select().from(rosterEntries).orderBy(rosterEntries.createdAt),
  ]);
  return {
    observations: obsRows.map((r) => ({ ...(r.data as object), submittedBy: r.createdBy })),
    teachers: rosterRows.filter((r) => r.kind === "teacher").map((r) => r.name),
    observers: rosterRows.filter((r) => r.kind === "observer").map((r) => r.name),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get("/api/me", (c) => c.json(c.get("user")));

app.get("/api/data", async (c) => {
  const data = await loadAll();
  const empty = data.observations.length === 0 && data.teachers.length === 0 && data.observers.length === 0;
  return c.json({ ...data, empty });
});

app.post("/api/observations", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!isValidObservation(body)) return c.json({ error: "Invalid observation" }, 400);

  const user = c.get("user");
  const [existing] = await db.select({ createdBy: observations.createdBy }).from(observations).where(eq(observations.id, body.id));
  if (existing && !isOwner(existing.createdBy, user)) {
    return c.json({ error: "Only the person who created this observation can change it." }, 403);
  }

  const stored = await extractPhotos({ ...body, submittedBy: user.email });
  await db
    .insert(observations)
    .values({ id: stored.id, data: stored, createdBy: user.email })
    .onConflictDoUpdate({
      target: observations.id,
      set: { data: stored, updatedAt: new Date() },
      setWhere: sql`lower(${observations.createdBy}) = lower(${user.email})`,
    });

  return c.json(stored, 201);
});

// Only the signed-in user who created an observation may delete it.
app.delete("/api/observations/:id", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const [existing] = await db.select().from(observations).where(eq(observations.id, id));
  if (!existing) return c.json({ ok: true, id });
  if (!isOwner(existing.createdBy, user)) {
    return c.json({ error: "Only the person who created this observation can delete it." }, 403);
  }

  await db.delete(observations).where(eq(observations.id, id));

  const photos = ((existing.data as Observation)?.photos ?? []) as Photo[];
  await Promise.all(
    photos
      .map((p) => (typeof p?.url === "string" && p.url.startsWith("/api/photos/") ? p.url.slice("/api/photos/".length) : null))
      .filter((key): key is string => !!key)
      .map((key) => photoStore.delete(decodeURIComponent(key)).catch((err) => console.error("Photo cleanup failed", err)))
  );

  return c.json({ ok: true, id });
});

app.post("/api/roster", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { kind?: string; name?: string };
  const kind = body.kind === "teacher" || body.kind === "observer" ? body.kind : null;
  const name = cleanName(body.name);
  if (!kind || !name) return c.json({ error: "Provide a kind (teacher/observer) and a name" }, 400);

  await db
    .insert(rosterEntries)
    .values({ kind, name, createdBy: c.get("user").email })
    .onConflictDoNothing();
  return c.json(await loadAll(), 201);
});

// Replaces all shared data. Used for the first-time import and for "Reset Sample Data".
app.post("/api/reset", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    observations?: unknown[];
    teachers?: unknown[];
    observers?: unknown[];
    onlyIfEmpty?: boolean;
  };

  if (body.onlyIfEmpty) {
    const current = await loadAll();
    if (current.observations.length || current.teachers.length || current.observers.length) {
      return c.json({ ...current, empty: false });
    }
  }

  const email = c.get("user").email;
  const obsList = (Array.isArray(body.observations) ? body.observations : []).filter(isValidObservation);
  const teachers = [...new Set((Array.isArray(body.teachers) ? body.teachers : []).map(cleanName).filter(Boolean))];
  const observers = [...new Set((Array.isArray(body.observers) ? body.observers : []).map(cleanName).filter(Boolean))];

  const prepared: Observation[] = [];
  for (const obs of obsList) prepared.push(await extractPhotos(obs));

  await db.delete(observations);
  await db.delete(rosterEntries);

  // Preserve the incoming order (newest first) by giving older items earlier timestamps.
  const now = Date.now();
  if (prepared.length) {
    await db.insert(observations).values(
      prepared.map((obs, i) => ({
        id: obs.id,
        data: obs,
        createdBy: email,
        createdAt: new Date(now - i * 1000),
        updatedAt: new Date(now),
      }))
    ).onConflictDoNothing();
  }
  const roster = [
    ...teachers.map((name, i) => ({ kind: "teacher", name, createdBy: email, createdAt: new Date(now + i) })),
    ...observers.map((name, i) => ({ kind: "observer", name, createdBy: email, createdAt: new Date(now + i) })),
  ];
  if (roster.length) await db.insert(rosterEntries).values(roster).onConflictDoNothing();

  return c.json({ ...(await loadAll()), empty: false });
});

app.get("/api/photos/*", async (c) => {
  const key = decodeURIComponent(c.req.path.slice("/api/photos/".length));
  const result = await photoStore.getWithMetadata(key, { type: "arrayBuffer" });
  if (!result) return c.notFound();
  const contentType = (result.metadata?.contentType as string) || "application/octet-stream";
  return new Response(result.data, {
    headers: { "Content-Type": contentType, "Cache-Control": "private, max-age=86400" },
  });
});

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

export const config = { path: "/api/*" };

export default app;
