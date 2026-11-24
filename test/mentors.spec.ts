import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import mentorsSchema from "../migrations-mentors/0001_mentors.sql?raw";
import uploadsSchema from "../migrations-school-uploads/0001_school_quiz_uploads.sql?raw";
import ownershipSchema from "../migrations-school-uploads/0002_mentor_ownership.sql?raw";
import initialSchema from "../migrations/0001_create_registrations_table.sql?raw";
import adminAccess from "../migrations/0005_create_admin_accesslist.sql?raw";
import adminAuth from "../migrations/0006_admin_auth.sql?raw";

const testEnv = { ...env, TURNSTILE_SECRET_KEY: "test", RESEND_API_KEY: "test" };
const db = env.MENTORS_DB, files = env.SCHOOL_QUIZ_UPLOADS;
const origin = "https://gitanushilanam.net";
const sample = { name: "Mentor One", school_name: "Example School", email: "school@example.com", phone: "9876543210",
    designation: "Teacher", total_strength: 500, willing_count: 50, state: "Odisha", district: "Khordha", place: "Bhubaneswar" };
const bytes = new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4]);
const emails: { key: string; text: string; html: string; to: string[] }[] = [];
let failEmail = false;
function api(path: string, method = "GET", body?: unknown, token?: string, requestOrigin = origin) {
    return worker.fetch(new Request(`https://example.com${path}`, { method,
        headers: { Origin: requestOrigin, ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) }), testEnv);
}
function register(overrides: Record<string, unknown> = {}) {
    return api("/api/mentors/register", "POST", { ...sample, request_id: crypto.randomUUID(), turnstile_token: "register", ...overrides });
}
async function login(email = sample.email, phone = sample.phone) {
    return api("/api/mentors/login", "POST", { email, phone, turnstile_token: "login" });
}
async function account(overrides: Record<string, unknown> = {}) {
    expect((await register(overrides)).status).toBe(200);
    const response = await login(String(overrides.email ?? sample.email), String(overrides.phone ?? sample.phone));
    expect(response.status).toBe(200);
    return response.json<{ session_token: string; mentors: { id: string; school_id: number; name: string }[] }>();
}
function upload(mentorId: string, token: string, admin = false, requestId = crypto.randomUUID()) {
    const body = new FormData();
    body.set("request_id", requestId);
    body.set("file", new File([bytes], "students.xlsx"));
    body.set("school_name", "Forged School"); body.set("mentor_id", "forged"); body.set("state", "Kerala");
    return worker.fetch(new Request(`https://example.com/api/${admin ? "mentor-admin" : "mentors"}/uploads?mentor_id=${mentorId}`, {
        method: "POST", headers: { Origin: origin, Authorization: `Bearer ${token}` }, body
    }), testEnv);
}
async function admin(role = "super_admin") {
    const token = "a".repeat(43);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
    const hash = btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    await env.gitanushilanam_db.prepare("INSERT INTO admin_accesslist (id,email,name,role,active) VALUES (1,'admin@example.com','Admin',?,1)").bind(role).run();
    await env.gitanushilanam_db.prepare("INSERT INTO admin_sessions (admin_id,session_hash,expires_at) VALUES (1,?,?)")
        .bind(hash, Math.floor(Date.now() / 1000) + 3600).run();
    return token;
}
beforeAll(async () => {
    for (const [database, migrations] of [[db, [mentorsSchema]], [files, [uploadsSchema, ownershipSchema]],
        [env.gitanushilanam_db, [initialSchema, adminAccess, adminAuth]]] as const) {
        for (const migration of migrations) for (const statement of migration.replace(/--.*$/gmu, "").split(";")) {
            if (statement.trim()) await database.prepare(statement).run();
        }
    }
});
beforeEach(async () => {
    vi.restoreAllMocks(); emails.length = 0; failEmail = false;
    for (const table of ["mentor_confirmation_jobs", "mentor_sessions", "mentor_login_attempts", "mentors", "mentor_schools"]) await db.prepare(`DELETE FROM ${table}`).run();
    await files.prepare("DELETE FROM school_quiz_uploads").run();
    for (const table of ["admin_sessions", "admin_login_history", "admin_accesslist"]) await env.gitanushilanam_db.prepare(`DELETE FROM ${table}`).run();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        if (String(input).includes("turnstile/v0/siteverify")) {
            const payload = JSON.parse(String(init?.body));
            return Response.json({ success: payload.response !== "bad", hostname: "gitanushilanam.net", action: payload.response === "login" ? "mentor_login" : "mentor_register" });
        }
        if (String(input) === "https://api.resend.com/emails/batch") {
            const payload = JSON.parse(String(init?.body))[0];
            emails.push({ key: new Headers(init?.headers).get("Idempotency-Key")!, ...payload });
            if (failEmail) throw new Error("network problem");
            return Response.json({ data: [{ id: "sent-1" }] });
        }
        throw new Error("Unexpected fetch");
    });
});

describe("Mentor registration", () => {
    it("saves all fields in a separate database and returns the school ID and WhatsApp link", async () => {
        const response = await register({ name: "<script>alert(1)</script>" });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ success: true, school_registration_id: 10000, email_sent: true,
            whatsapp_group: "https://chat.whatsapp.com/Hwdwzs0kjc9H4YVK83Lfk2", login_details: { email: sample.email, phone: "+919876543210" } });
        expect(await db.prepare("SELECT designation,total_strength,willing_count FROM mentors").first()).toEqual({ designation: "Teacher", total_strength: 500, willing_count: 50 });
        expect(await env.gitanushilanam_db.prepare("SELECT COUNT(*) AS n FROM registrations").first<number>("n")).toBe(0);
        expect(emails).toHaveLength(1); expect(emails[0].text).toContain("School registration ID: 10000");
        expect(emails[0].html).not.toContain("<script>"); expect(emails[0].to).toEqual([sample.email]);
    });
    it("deduplicates a successful or interrupted registration including concurrent retries", async () => {
        const key = crypto.randomUUID();
        const results = await Promise.all([register({ request_id: key }), register({ request_id: key })]);
        expect(results.map(r => r.status)).toEqual([200, 200]);
        expect((await register()).status).toBe(200);
        expect(await db.prepare("SELECT COUNT(*) AS n FROM mentors").first<number>("n")).toBe(1);
        expect(await db.prepare("SELECT COUNT(*) AS n FROM mentor_schools").first<number>("n")).toBe(1);
        expect(emails).toHaveLength(1);
    });
    it("assigns unique IDs concurrently and distinguishes identical names in different locations", async () => {
        const results = await Promise.all([register(), register({ district: "Cuttack" })]);
        const ids = await Promise.all(results.map(async r => (await r.json<{ school_registration_id: number }>()).school_registration_id));
        expect(ids.sort()).toEqual([10000, 10001]);
    });
    it("allows shared emails and repeated phones, with one school ID for multiple mentors", async () => {
        const first = await register();
        const id = (await first.json<{ school_registration_id: number }>()).school_registration_id;
        expect((await register({ name: "Mentor Two", phone: "9123456789", school_registration_id: id })).status).toBe(200);
        expect((await register({ name: "Mentor Three", email: "other@example.com", school_registration_id: id })).status).toBe(200);
        expect(await db.prepare("SELECT COUNT(*) AS n FROM mentors").first<number>("n")).toBe(3);
        expect(await db.prepare("SELECT COUNT(*) AS n FROM mentor_schools").first<number>("n")).toBe(1);
    });
    it("rejects an existing school ID paired with a different location", async () => {
        await register(); expect((await register({ school_registration_id: 10000, place: "Other town" })).status).toBe(400);
    });
    it("does not overwrite saved details or create orphan schools when a retry key changes payload", async () => {
        const key = crypto.randomUUID(); await register({ request_id: key });
        expect((await register({ request_id: key, school_name: "Changed" })).status).toBe(409);
        expect((await register({ name: "Changed mentor" })).status).toBe(409);
        expect(await db.prepare("SELECT name FROM mentors").first<string>("name")).toBe(sample.name);
        expect(await db.prepare("SELECT COUNT(*) AS n FROM mentor_schools").first<number>("n")).toBe(1);
    });
    it.each([{ willing_count: 501 }, { willing_count: -1 }, { total_strength: 0 }, { total_strength: 1.5 },
        { email: "invalid" }, { phone: "123" }, { state: "Not India" }, { designation: " " }, { school_registration_id: 9999 }])("rejects invalid form values: %j", async change => {
        expect((await register(change)).status).toBe(400);
        expect(await db.prepare("SELECT COUNT(*) AS n FROM mentors").first<number>("n")).toBe(0);
    });
    it("does not save a registration if Turnstile fails", async () => {
        expect((await register({ turnstile_token: "bad" })).status).toBe(403);
        expect(await db.prepare("SELECT COUNT(*) AS n FROM mentors").first<number>("n")).toBe(0);
    });
    it("keeps successful registration when email fails and reuses the same email job on retry", async () => {
        failEmail = true; const key = crypto.randomUUID();
        expect(await (await register({ request_id: key })).json()).toMatchObject({ success: true, email_sent: false });
        failEmail = false;
        expect(await (await register({ request_id: key })).json()).toMatchObject({ success: true, email_sent: true });
        expect(emails[0].key).toBe(emails[1].key);
    });
    it("does not allocate an out-of-range ID when capacity is reached; existing schools can add mentors", async () => {
        await register();
        await db.prepare("INSERT INTO mentor_schools (registration_id,identity_key,name,state,district,place) VALUES (19999,'last','Last','Odisha','Khordha','Place')").run();
        expect((await register({ school_name: "New School" })).status).toBe(503);
        expect((await register({ phone: "9123456789", school_registration_id: 10000 })).status).toBe(200);
        expect(await db.prepare("SELECT MAX(registration_id) AS n FROM mentor_schools").first<number>("n")).toBe(19999);
    });
});

describe("Mentor login and file ownership", () => {
    it("logs in with normalised email and phone, restores sessions, and handles multiple schools", async () => {
        await register(); await register({ school_name: "Second School" });
        const response = await login(" SCHOOL@EXAMPLE.COM ", "+91 98765 43210");
        const result = await response.json<{ session_token: string; mentors: unknown[] }>();
        expect(result.mentors).toHaveLength(2);
        expect(await db.prepare("SELECT session_hash FROM mentor_sessions").first<string>("session_hash")).not.toBe(result.session_token);
        expect((await api("/api/mentors/session", "GET", undefined, result.session_token)).status).toBe(200);
        expect((await api("/api/mentors/logout", "POST", undefined, result.session_token)).status).toBe(200);
        expect((await api("/api/mentors/session", "GET", undefined, result.session_token)).status).toBe(401);
    });
    it("rejects incorrect credentials, expired sessions and foreign-origin writes", async () => {
        expect((await login()).status).toBe(401);
        const a = await account();
        await db.prepare("UPDATE mentor_sessions SET expires_at=0").run();
        expect((await api("/api/mentors/session", "GET", undefined, a.session_token)).status).toBe(401);
        expect((await api("/api/mentors/login", "POST", {}, undefined, "https://evil.example")).status).toBe(403);
    });
    it("limits repeated login attempts", async () => {
        for (let i = 0; i < 15; i++) expect((await login()).status).toBe(401);
        expect((await login()).status).toBe(429);
    });
    it("rejects registration-action Turnstile tokens on login", async () => {
        await register();
        expect((await api("/api/mentors/login", "POST", { email: sample.email, phone: sample.phone, turnstile_token: "register" })).status).toBe(403);
    });
    it("scopes files to the logged-in mentor and ignores forged form ownership", async () => {
        const a = await account(), b = await account({ email: "other@example.com", name: "Other Mentor" });
        const aid = a.mentors[0].id, bid = b.mentors[0].id;
        expect((await upload(aid, a.session_token)).status).toBe(200);
        expect((await upload(aid, b.session_token)).status).toBe(403);
        expect((await api(`/api/mentors/uploads?mentor_id=${aid}`, "GET", undefined, b.session_token)).status).toBe(403);
        const key = await files.prepare("SELECT file_key FROM school_quiz_uploads").first<string>("file_key");
        const download = await api(`/api/mentors/uploads/download?mentor_id=${aid}&key=${encodeURIComponent(key!)}`, "GET", undefined, a.session_token);
        expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
        expect((await api(`/api/mentors/uploads/download?mentor_id=${bid}&key=${encodeURIComponent(key!)}`, "GET", undefined, b.session_token)).status).toBe(404);
        expect(await files.prepare("SELECT school_name,mentor_id,state,uploaded_by_role FROM school_quiz_uploads").first()).toEqual({ school_name: sample.school_name, mentor_id: aid, state: "Odisha", uploaded_by_role: "mentor" });
        expect(await (await api(`/api/mentors/uploads?mentor_id=${bid}`, "GET", undefined, b.session_token)).json()).toMatchObject({ total_uploads: 0, uploads: [] });
        expect((await api("/api/mentor-admin/mentors", "GET", undefined, a.session_token)).status).toBe(401);
    });
    it("isolates identical retry IDs used by different mentors", async () => {
        const a = await account(), b = await account({ email: "other@example.com" });
        const key = crypto.randomUUID();
        await upload(a.mentors[0].id, a.session_token, false, key);
        await upload(b.mentors[0].id, b.session_token, false, key);
        expect(await files.prepare("SELECT COUNT(*) AS n FROM school_quiz_uploads").first<number>("n")).toBe(2);
    });
});

describe("Mentor Super Admin review", () => {
    it("lists and searches mentors and allows audited uploads on their behalf", async () => {
        const a = await account(), token = await admin();
        const data = await (await api("/api/mentor-admin/mentors?search=10000", "GET", undefined, token)).json();
        expect(data).toMatchObject({ total_schools: 1, total_mentors: 1, matching_mentors: 1 });
        expect((await upload(a.mentors[0].id, token, true)).status).toBe(200);
        expect(await files.prepare("SELECT uploaded_by_role,uploaded_by_id FROM school_quiz_uploads").first()).toEqual({ uploaded_by_role: "super_admin", uploaded_by_id: "1" });
        expect(await (await api(`/api/mentors/uploads?mentor_id=${a.mentors[0].id}`, "GET", undefined, a.session_token)).json()).toMatchObject({ total_uploads: 1 });
    });
    it.each(["admin", "judge"])("denies review and uploading to the %s role", async role => {
        const a = await account(), token = await admin(role);
        expect((await api("/api/mentor-admin/mentors", "GET", undefined, token)).status).toBe(403);
        expect((await upload(a.mentors[0].id, token, true)).status).toBe(403);
    });
    it("can resend confirmation without duplicating a retry", async () => {
        const a = await account(), token = await admin();
        const payload = { mentor_id: a.mentors[0].id, request_id: crypto.randomUUID() };
        expect((await api("/api/mentor-admin/confirmation", "POST", payload, token)).status).toBe(200);
        expect((await api("/api/mentor-admin/confirmation", "POST", payload, token)).status).toBe(200);
        expect(emails).toHaveLength(2);
    });
    it("retains unassigned legacy uploads for Super Admin only", async () => {
        const a = await account(), token = await admin();
        const key = `school-quiz/${crypto.randomUUID()}/${"a".repeat(64)}.xlsx`;
        await files.prepare("INSERT INTO school_quiz_uploads (school_name,original_filename,file_key,file_size) VALUES (?,?,?,8)").bind(sample.school_name,"old.xlsx",key).run();
        await files.prepare("INSERT INTO school_quiz_upload_chunks (file_key,part,content) VALUES (?,0,?)").bind(key,btoa(String.fromCharCode(...bytes))).run();
        expect(await (await api("/api/mentor-admin/uploads", "GET", undefined, token)).json()).toMatchObject({ total_uploads: 1 });
        expect((await api(`/api/mentor-admin/uploads/download?key=${encodeURIComponent(key)}`, "GET", undefined, token)).status).toBe(200);
        expect((await api(`/api/mentors/uploads/download?mentor_id=${a.mentors[0].id}&key=${encodeURIComponent(key)}`, "GET", undefined, a.session_token)).status).toBe(404);
        expect((await api("/api/school-quiz/uploads", "POST")).status).toBe(401);
    });
});
