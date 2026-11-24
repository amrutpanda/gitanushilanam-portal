import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { handleMentorRoutes } from "../src/mentor-routes";
import ownership from "../migrations-school-uploads/0002_mentor_ownership.sql?raw";
import mentorsSchema from "../migrations-mentors/0001_mentors.sql?raw";
import initialSchema from "../migrations/0001_create_registrations_table.sql?raw";
import adminAccess from "../migrations/0005_create_admin_accesslist.sql?raw";
import adminAuth from "../migrations/0006_admin_auth.sql?raw";
import uploadsSchema from "../migrations-school-uploads/0001_school_quiz_uploads.sql?raw";

const db = env.gitanushilanam_db;
const uploadsDb = env.SCHOOL_QUIZ_UPLOADS;
const testEnv = { ...env, TURNSTILE_SECRET_KEY: "test-secret", RESEND_API_KEY: "test-secret" };
const path = "https://example.com/api/school-quiz/uploads";
const origin = "https://gitanushilanam.net";
const sessionToken = "u".repeat(43);
// Intentionally not a parsed workbook: uploads only check the container signature.
const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

const ownerId = "12345678-1234-4234-8234-123456789012";
const authorizedAdmin = async () => ({ admin_id: 42, email: "review@example.com" });
async function upload(options: { school?: string; key?: string; filename?: string; bytes?: Uint8Array; origin?: string; file?: boolean } = {}) {
    const body = new FormData();
    body.set("school_name", options.school ?? "Example School");
    body.set("request_id", options.key ?? crypto.randomUUID());
    body.set("turnstile_token", "test-token");
    // These values must not be trusted or stored during the upload-only phase.
    body.set("state", "Maharashtra");
    body.set("city", "Pune");
    if (options.file !== false) body.set("file", new File([options.bytes ?? bytes], options.filename ?? "students.xlsx"));
    if (options.school) await env.MENTORS_DB.prepare("UPDATE mentor_schools SET name = ? WHERE registration_id = 10000").bind(options.school.trim()).run();
    return handleMentorRoutes(new Request(`https://example.com/api/mentor-admin/uploads?mentor_id=${ownerId}`, { method: "POST", headers: { Origin: options.origin ?? origin }, body }), testEnv, authorizedAdmin);
}

async function authorize(role = "super_admin", active = 1, expired = false) {
    await db.prepare("INSERT INTO admin_accesslist (id, email, name, role, active) VALUES (1, 'review@example.com', 'Reviewer', ?, ?)").bind(role, active).run();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionToken)));
    const hash = btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    await db.prepare("INSERT INTO admin_sessions (admin_id, session_hash, expires_at) VALUES (1, ?, ?)")
        .bind(hash, Math.floor(Date.now() / 1000) + (expired ? -60 : 3600)).run();
}

function review(suffix = "", authenticated = true) {
    return worker.fetch(new Request(path + suffix, {
        headers: { Origin: origin, ...(authenticated ? { Authorization: `Bearer ${sessionToken}` } : {}) }
    }), testEnv);
}

beforeAll(async () => {
    for (const migration of [initialSchema, adminAccess, adminAuth]) {
        for (const statement of migration.replace(/--.*$/gmu, "").split(";")) {
            if (statement.trim()) await db.prepare(statement).run();
        }
    }
});

beforeAll(async () => {
    for (const statement of (uploadsSchema + ownership).replace(/--.*$/gmu, "").split(";")) {
        if (statement.trim()) await uploadsDb.prepare(statement).run();
    }
});

beforeAll(async () => {
    for (const statement of mentorsSchema.replace(/--.*$/gmu, "").split(";")) {
        if (statement.trim()) await env.MENTORS_DB.prepare(statement).run();
    }
    await env.MENTORS_DB.prepare("INSERT INTO mentor_schools (registration_id, identity_key, name, state, district, place) VALUES (10000, 'school', 'Example School', 'Odisha', 'Khordha', 'Bhubaneswar')").run();
    await env.MENTORS_DB.prepare("INSERT INTO mentors (id, school_id, name, email, phone, designation, total_strength, willing_count, request_id, request_hash) VALUES (?, 10000, 'Mentor', 'school@example.com', '+919876543210', 'Teacher', 100, 20, 'request', 'hash')").bind(ownerId).run();
});

beforeEach(async () => {
    vi.restoreAllMocks();
    await env.MENTORS_DB.prepare("UPDATE mentor_schools SET name = 'Example School' WHERE registration_id = 10000").run();
    await uploadsDb.prepare("DELETE FROM school_quiz_uploads").run();
    await db.prepare("DELETE FROM admin_sessions").run();
    await db.prepare("DELETE FROM admin_login_history").run();
    await db.prepare("DELETE FROM admin_accesslist").run();
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
        expect(String(input)).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
        return Response.json({ success: true, action: "school_quiz_upload", hostname: "gitanushilanam.net" });
    });
});

describe("School quiz file collection", () => {
    it("stores original bytes with trusted mentor ownership without creating student registrations", async () => {
        const response = await upload({ school: "  Example School  " });
        expect(response.status).toBe(200);
        const receipt = await response.json<Record<string, unknown>>();
        expect(receipt).toMatchObject({ success: true, school_name: "Example School", original_filename: "students.xlsx" });
        expect(receipt).not.toHaveProperty("file_key");
        const row = await uploadsDb.prepare("SELECT * FROM school_quiz_uploads").first<Record<string, unknown>>();
        expect(Object.keys(row!)).toHaveLength(13);
        expect(row).toMatchObject({ school_name: "Example School", state: "Odisha", city: "Bhubaneswar", mentor_id: ownerId, uploaded_by_role: "super_admin", uploaded_by_id: "42", file_size: bytes.length });
        expect(row?.uploaded_at).toBe(receipt.uploaded_at);
        const content = await uploadsDb.prepare("SELECT content FROM school_quiz_upload_chunks WHERE file_key = ?").bind(row?.file_key).first<string>("content");
        expect(Uint8Array.from(atob(content!), ch => ch.charCodeAt(0))).toEqual(bytes);
        expect(await db.prepare("SELECT COUNT(*) AS count FROM registrations").first<number>("count")).toBe(0);
        expect(fetch).not.toHaveBeenCalled();
    });

    it("retains multiple uploads with the same school and filename", async () => {
        expect((await upload()).status).toBe(200);
        expect((await upload()).status).toBe(200);
        expect(await uploadsDb.prepare("SELECT COUNT(*) AS count FROM school_quiz_uploads").first<number>("count")).toBe(2);
        expect(await uploadsDb.prepare("SELECT COUNT(DISTINCT file_key) AS count FROM school_quiz_upload_chunks").first<number>("count")).toBe(2);
    });

    it("recovers an identical retry with the original timestamp and only one file", async () => {
        const key = crypto.randomUUID();
        const first = await (await upload({ key })).json();
        const second = await (await upload({ key })).json();
        expect(second).toEqual(first);
        expect(await uploadsDb.prepare("SELECT COUNT(*) AS count FROM school_quiz_uploads").first<number>("count")).toBe(1);
        expect(await uploadsDb.prepare("SELECT COUNT(DISTINCT file_key) AS count FROM school_quiz_upload_chunks").first<number>("count")).toBe(1);
    });

    it("handles concurrent retries without overwriting or duplicating the workbook", async () => {
        const key = crypto.randomUUID();
        const responses = await Promise.all([upload({ key }), upload({ key })]);
        expect(responses.map(response => response.status)).toEqual([200, 200]);
        expect(await uploadsDb.prepare("SELECT COUNT(*) AS count FROM school_quiz_uploads").first<number>("count")).toBe(1);
        expect(await uploadsDb.prepare("SELECT COUNT(DISTINCT file_key) AS count FROM school_quiz_upload_chunks").first<number>("count")).toBe(1);
    });

    it("does not overwrite different content even if an attempt key is reused", async () => {
        const key = crypto.randomUUID();
        await upload({ key });
        await upload({ key, bytes: new Uint8Array([...bytes, 9]) });
        await upload({ key, school: "Another School" });
        expect(await uploadsDb.prepare("SELECT COUNT(DISTINCT file_key) AS count FROM school_quiz_upload_chunks").first<number>("count")).toBe(3);
    });

    it("rolls back metadata and chunks on a failed write, then permits retry", async () => {
        const key = crypto.randomUUID();
        await uploadsDb.prepare("CREATE TRIGGER fail_chunk BEFORE INSERT ON school_quiz_upload_chunks BEGIN SELECT RAISE(ABORT, 'simulated failure'); END").run();
        try { expect((await upload({ key })).status).toBe(503); }
        finally { await uploadsDb.prepare("DROP TRIGGER fail_chunk").run(); }
        expect(await uploadsDb.prepare("SELECT COUNT(*) AS count FROM school_quiz_uploads").first<number>("count")).toBe(0);
        expect(await uploadsDb.prepare("SELECT COUNT(*) AS count FROM school_quiz_upload_chunks").first<number>("count")).toBe(0);
        expect((await upload({ key })).status).toBe(200);
    });

    it("accepts exactly 2 MB and downloads identical bytes across all storage chunks", async () => {
        await authorize();
        const large = new Uint8Array(2_000_000);
        for (let offset = 0; offset < large.length; offset++) large[offset] = offset % 256;
        large.set(bytes);
        expect((await upload({ bytes: large })).status).toBe(200);
        const key = await uploadsDb.prepare("SELECT file_key FROM school_quiz_uploads").first<string>("file_key");
        expect(await uploadsDb.prepare("SELECT COUNT(*) AS count FROM school_quiz_upload_chunks").first<number>("count")).toBe(4);
        const response = await review(`/download?key=${encodeURIComponent(key!)}`);
        expect(response.status).toBe(200);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(large);
        expect(await (await review()).json()).toMatchObject({ storage_used_bytes: 2_000_000, storage_limit_bytes: 100_000_000 });
    });

    it("caps concurrent uploads at 100 MB, accepts exact capacity, and allows saved retries when full", async () => {
        await uploadsDb.batch(Array.from({ length: 50 }, (_, index) => uploadsDb.prepare(
            "INSERT INTO school_quiz_uploads (school_name, original_filename, file_key, file_size) VALUES ('Seed', 'seed.xlsx', ?, ?)"
        ).bind(`seed-${index}`, index === 49 ? 2_000_000 - bytes.length : 2_000_000)));
        const keys = [crypto.randomUUID(), crypto.randomUUID()];
        const responses = await Promise.all(keys.map(key => upload({ key })));
        expect(responses.map(r => r.status).sort()).toEqual([200, 507]);
        expect(await uploadsDb.prepare("SELECT SUM(file_size) AS size FROM school_quiz_uploads").first<number>("size")).toBe(100_000_000);
        expect(await uploadsDb.prepare("SELECT COUNT(*) AS count FROM school_quiz_upload_chunks").first<number>("count")).toBe(1);
        const successfulKey = keys[responses.findIndex(response => response.status === 200)];
        expect((await upload({ key: successfulKey })).status).toBe(200);
        expect((await upload()).status).toBe(507);
        expect(await uploadsDb.prepare("SELECT SUM(file_size) AS size FROM school_quiz_uploads").first<number>("size")).toBe(100_000_000);
    });

    it.each([
        ["invalid retry key", { key: "bad" }, 400],
        ["missing file", { file: false }, 400],
        ["wrong extension", { filename: "students.xlsm" }, 400],
        ["non-container", { bytes: new Uint8Array([1, 2, 3, 4]) }, 400],
        ["empty file", { bytes: new Uint8Array() }, 400],
        ["oversized file", { bytes: new Uint8Array(2_000_001) }, 413],
        ["wrong origin", { origin: "https://example.org" }, 403]
    ] as const)("rejects %s without saving anything", async (_label, options, status) => {
        expect((await upload(options)).status).toBe(status);
        expect(await uploadsDb.prepare("SELECT COUNT(DISTINCT file_key) AS count FROM school_quiz_upload_chunks").first<number>("count")).toBe(0);
        expect(await uploadsDb.prepare("SELECT COUNT(*) AS count FROM school_quiz_uploads").first<number>("count")).toBe(0);
    });

    it("retires the anonymous upload endpoint", async () => {
        expect((await worker.fetch(new Request(path, { method: "POST", headers: { Origin: origin } }), testEnv)).status).toBe(401);
        expect(await uploadsDb.prepare("SELECT COUNT(*) AS count FROM school_quiz_uploads").first<number>("count")).toBe(0);
    });

    it("bounds an oversized request body even without Content-Length", async () => {
        const response = await handleMentorRoutes(new Request(`https://example.com/api/mentor-admin/uploads?mentor_id=${ownerId}`, {
            method: "POST", headers: { Origin: origin, "Content-Type": "multipart/form-data; boundary=test" },
            body: new Uint8Array(2_000_000 + 65537)
        }), testEnv, authorizedAdmin);
        expect(response.status).toBe(413);
    });
});

describe("Standalone upload review authorization", () => {
    it("requires authorization for counts and file downloads", async () => {
        expect((await review("", false)).status).toBe(401);
        expect((await review("/download?key=anything", false)).status).toBe(401);
    });

    it.each(["admin", "judge"])("denies the %s role", async role => {
        await authorize(role);
        expect((await review()).status).toBe(403);
        expect((await review("/download?key=anything")).status).toBe(403);
    });

    it.each([[0, false], [1, true]] as const)("denies inactive or expired sessions", async (active, expired) => {
        await authorize("super_admin", active, expired);
        expect((await review()).status).toBe(401);
    });

    it("counts files, filters repeated schools case-insensitively and returns an empty state", async () => {
        await authorize();
        await upload(); await upload(); await upload({ school: "Other College" });
        const response = await review("?school=example");
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        const result = await response.json<{ total_uploads: number; matching_uploads: number; uploads: unknown[] }>();
        expect(result.total_uploads).toBe(3);
        expect(result.matching_uploads).toBe(2);
        expect(result.uploads).toHaveLength(2);
        expect(await (await review("?school=%25")).json()).toMatchObject({ matching_uploads: 0, uploads: [] });
    });

    it("paginates results with deterministic ordering", async () => {
        await authorize();
        await uploadsDb.batch(Array.from({ length: 28 }, (_, index) => uploadsDb.prepare(
            "INSERT INTO school_quiz_uploads (school_name, original_filename, file_key, file_size) VALUES ('Example School', 'students.xlsx', ?, 8)"
        ).bind(`page-test-${String(index).padStart(2, "0")}`)));
        const first = await (await review()).json<{ uploads: { file_key: string }[] }>();
        const second = await (await review("?page=2")).json<{ uploads: { file_key: string }[]; total_pages: number }>();
        expect(first.uploads).toHaveLength(25);
        expect(second.uploads).toHaveLength(3);
        expect(second.total_pages).toBe(2);
        expect(new Set([...first.uploads, ...second.uploads].map(row => row.file_key)).size).toBe(28);
    });

    it("downloads exact bytes with a safe attachment filename and no caching", async () => {
        await authorize(); await upload({ filename: "छात्र सूची.xlsx" });
        const key = await uploadsDb.prepare("SELECT file_key FROM school_quiz_uploads").first<string>("file_key");
        const response = await review(`/download?key=${encodeURIComponent(key!)}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Disposition")).toContain("filename*=UTF-8''");
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
        expect((await review("/download?key=../../anything")).status).toBe(400);
        expect((await review(`/download?key=school-quiz/${crypto.randomUUID()}/${"a".repeat(64)}.xlsx`)).status).toBe(404);
    });
});
