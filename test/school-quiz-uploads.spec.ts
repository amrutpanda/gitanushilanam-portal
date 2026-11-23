import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import initialSchema from "../migrations/0001_create_registrations_table.sql?raw";
import adminAccess from "../migrations/0005_create_admin_accesslist.sql?raw";
import adminAuth from "../migrations/0006_admin_auth.sql?raw";
import uploadsSchema from "../migrations/0011_school_quiz_uploads.sql?raw";

const db = env.gitanushilanam_db;
const bucket = env.SCHOOL_QUIZ_UPLOADS;
const testEnv = { ...env, TURNSTILE_SECRET_KEY: "test-secret", RESEND_API_KEY: "test-secret" };
const path = "https://example.com/api/school-quiz/uploads";
const origin = "https://gitanushilanam.net";
const sessionToken = "u".repeat(43);
// Intentionally not a parsed workbook: uploads only check the container signature.
const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

function upload(options: { school?: string; key?: string; filename?: string; bytes?: Uint8Array; origin?: string; file?: boolean } = {}) {
    const body = new FormData();
    body.set("school_name", options.school ?? "Example School");
    body.set("request_id", options.key ?? crypto.randomUUID());
    body.set("turnstile_token", "test-token");
    // These values must not be trusted or stored during the upload-only phase.
    body.set("state", "Maharashtra");
    body.set("city", "Pune");
    if (options.file !== false) body.set("file", new File([options.bytes ?? bytes], options.filename ?? "students.xlsx"));
    return worker.fetch(new Request(path, { method: "POST", headers: { Origin: options.origin ?? origin }, body }), testEnv);
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
    for (const migration of [initialSchema, adminAccess, adminAuth, uploadsSchema]) {
        for (const statement of migration.replace(/--.*$/gmu, "").split(";")) {
            if (statement.trim()) await db.prepare(statement).run();
        }
    }
});

beforeEach(async () => {
    vi.restoreAllMocks();
    await db.prepare("DELETE FROM school_quiz_uploads").run();
    await db.prepare("DELETE FROM admin_sessions").run();
    await db.prepare("DELETE FROM admin_login_history").run();
    await db.prepare("DELETE FROM admin_accesslist").run();
    const objects = await bucket.list();
    if (objects.objects.length) await bucket.delete(objects.objects.map(object => object.key));
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
        expect(String(input)).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
        return Response.json({ success: true, action: "school_quiz_upload", hostname: "gitanushilanam.net" });
    });
});

describe("School quiz file collection", () => {
    it("stores the original bytes and seven metadata columns without creating registrations or parsing locations", async () => {
        const response = await upload({ school: "  Example School  " });
        expect(response.status).toBe(200);
        const receipt = await response.json<Record<string, unknown>>();
        expect(receipt).toMatchObject({ success: true, school_name: "Example School", original_filename: "students.xlsx" });
        expect(receipt).not.toHaveProperty("file_key");
        const row = await db.prepare("SELECT * FROM school_quiz_uploads").first<Record<string, unknown>>();
        expect(Object.keys(row!)).toHaveLength(7);
        expect(row).toMatchObject({ school_name: "Example School", state: null, city: null, file_size: bytes.length });
        expect(row?.uploaded_at).toBe(receipt.uploaded_at);
        const object = await bucket.get(String(row?.file_key));
        expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytes);
        expect(await db.prepare("SELECT COUNT(*) AS count FROM registrations").first<number>("count")).toBe(0);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("retains multiple uploads with the same school and filename", async () => {
        expect((await upload()).status).toBe(200);
        expect((await upload()).status).toBe(200);
        expect(await db.prepare("SELECT COUNT(*) AS count FROM school_quiz_uploads").first<number>("count")).toBe(2);
        expect((await bucket.list()).objects).toHaveLength(2);
    });

    it("recovers an identical retry with the original timestamp and only one file", async () => {
        const key = crypto.randomUUID();
        const first = await (await upload({ key })).json();
        const second = await (await upload({ key })).json();
        expect(second).toEqual(first);
        expect(await db.prepare("SELECT COUNT(*) AS count FROM school_quiz_uploads").first<number>("count")).toBe(1);
        expect((await bucket.list()).objects).toHaveLength(1);
    });

    it("handles concurrent retries without overwriting or duplicating the workbook", async () => {
        const key = crypto.randomUUID();
        const responses = await Promise.all([upload({ key }), upload({ key })]);
        expect(responses.map(response => response.status)).toEqual([200, 200]);
        expect(await db.prepare("SELECT COUNT(*) AS count FROM school_quiz_uploads").first<number>("count")).toBe(1);
        expect((await bucket.list()).objects).toHaveLength(1);
    });

    it("does not overwrite different content even if an attempt key is reused", async () => {
        const key = crypto.randomUUID();
        await upload({ key });
        await upload({ key, bytes: new Uint8Array([...bytes, 9]) });
        await upload({ key, school: "Another School" });
        expect((await bucket.list()).objects).toHaveLength(3);
    });

    it("recovers when the file is saved but the metadata write fails", async () => {
        const key = crypto.randomUUID();
        const failure = vi.spyOn(db, "prepare").mockImplementationOnce(() => { throw new Error("Temporary D1 failure"); });
        expect((await upload({ key })).status).toBe(503);
        failure.mockRestore();
        expect((await bucket.list()).objects).toHaveLength(1);
        const storedTime = (await bucket.head((await bucket.list()).objects[0].key))!.customMetadata!.uploaded_at;
        const result = await (await upload({ key })).json<{ uploaded_at: string }>();
        expect(result.uploaded_at).toBe(storedTime);
        expect((await bucket.list()).objects).toHaveLength(1);
        expect(await db.prepare("SELECT COUNT(*) AS count FROM school_quiz_uploads").first<number>("count")).toBe(1);
    });

    it.each([
        ["missing school", { school: "  " }, 400],
        ["long school", { school: "s".repeat(201) }, 400],
        ["invalid retry key", { key: "bad" }, 400],
        ["missing file", { file: false }, 400],
        ["wrong extension", { filename: "students.xlsm" }, 400],
        ["non-container", { bytes: new Uint8Array([1, 2, 3, 4]) }, 400],
        ["empty file", { bytes: new Uint8Array() }, 400],
        ["oversized file", { bytes: new Uint8Array(5 * 1024 * 1024 + 1) }, 413],
        ["wrong origin", { origin: "https://example.org" }, 403]
    ] as const)("rejects %s without saving anything", async (_label, options, status) => {
        expect((await upload(options)).status).toBe(status);
        expect((await bucket.list()).objects).toHaveLength(0);
        expect(await db.prepare("SELECT COUNT(*) AS count FROM school_quiz_uploads").first<number>("count")).toBe(0);
    });

    it.each([
        { success: false },
        { success: true, hostname: "gitanushilanam.net", action: "registration" },
        { success: true, hostname: "example.org", action: "school_quiz_upload" }
    ])("rejects unsuccessful or mismatched security verification", async result => {
        vi.mocked(fetch).mockResolvedValueOnce(Response.json(result));
        expect((await upload()).status).toBe(403);
        expect((await bucket.list()).objects).toHaveLength(0);
    });

    it("bounds an oversized request body even without Content-Length", async () => {
        const response = await worker.fetch(new Request(path, {
            method: "POST", headers: { Origin: origin, "Content-Type": "multipart/form-data; boundary=test" },
            body: new Uint8Array(5 * 1024 * 1024 + 65537)
        }), testEnv);
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
        await db.batch(Array.from({ length: 28 }, (_, index) => db.prepare(
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
        const key = await db.prepare("SELECT file_key FROM school_quiz_uploads").first<string>("file_key");
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
