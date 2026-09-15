import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import initialSchema from "../migrations/0001_create_registrations_table.sql?raw";
import uniqueRegistration from "../migrations/0002_unique_registration.sql?raw";

const db = env.gitanushilanam_db;
const validRegistration = {
    name: "  अमृत O’Connor  ",
    email: "  AMRUT@example.com  ",
    phone: "+91 98765 43210",
    whatsapp: "+91 98765 43210",
    age: 20,
    country: "India",
    state: "Maharashtra",
    city: "Pune",
    heard_from: "Friend",
    competitions: ["bhagavad_gita_quiz", "treasure_hunt"]
};

function submit(data: unknown) {
    return SELF.fetch("https://example.com/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
    });
}

beforeAll(async () => {
    // Execute the actual migrations against the isolated test database.
    for (const migration of [initialSchema, uniqueRegistration]) {
        for (const sql of migration.split(";")) {
            if (sql.trim()) {
                await db.prepare(sql).run();
            }
        }
    }
});

beforeEach(async () => {
    await db.prepare("DELETE FROM registrations").run();
});

describe("Registration API", () => {
    it("saves normalized contact details and selected competitions", async () => {
        const response = await submit(validRegistration);
        expect(response.status).toBe(200);
        const result = await response.json<{ id: number; success: boolean }>();
        expect(result.success).toBe(true);
        const row = await db.prepare("SELECT * FROM registrations WHERE id = ?")
            .bind(result.id).first();
        expect(row).toMatchObject({
            name: "अमृत O’Connor",
            email: "amrut@example.com",
            phone: "+919876543210",
            whatsapp: "+919876543210",
            bhagavad_gita_quiz: 1,
            shloka_recitation: 0,
            animated_bg_video: 0,
            treasure_hunt: 1
        });
    });

    it.each([
        ["numeric name", { name: 123 }],
        ["blank name", { name: "   " }],
        ["long name", { name: "a".repeat(101) }],
        ["invalid email", { email: "not-an-email" }],
        ["numeric phone", { phone: 9876543210 }],
        ["missing country code", { phone: "9876543210" }],
        ["invalid phone", { phone: "+91123" }],
        ["embedded phone", { phone: "+91 98765 43210 call me" }],
        ["phone extension", { phone: "+919876543210 ext. 123" }],
        ["invalid WhatsApp", { whatsapp: "+91123" }],
        ["wrong country type", { country: {} }],
        ["missing city", { city: undefined }],
        ["long source", { heard_from: "x".repeat(201) }],
        ["string age", { age: "20" }],
        ["fractional age", { age: 3.5 }],
        ["age below range", { age: 2 }],
        ["age above range", { age: 121 }],
        ["non-array competitions", { competitions: "treasure_hunt" }],
        ["empty competitions", { competitions: [] }],
        ["non-string competition", { competitions: [123] }],
        ["unknown competition", { competitions: ["unknown"] }]
    ])("rejects %s without saving a row", async (_label, changes) => {
        const response = await submit({ ...validRegistration, ...changes });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ success: false });
        expect(await db.prepare("SELECT COUNT(*) AS count FROM registrations").first("count"))
            .toBe(0);
    });

    it.each([null, [], "text", 42])("rejects a non-object JSON body: %j", async (body) => {
        expect((await submit(body)).status).toBe(400);
    });

    it("returns 400 for malformed JSON", async () => {
        const response = await SELF.fetch("https://example.com/api/register", {
            method: "POST",
            body: "{broken"
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ message: "Please send valid JSON." });
    });

    it("saves only one row for simultaneous normalized duplicates", async () => {
        const responses = await Promise.all([
            submit(validRegistration),
            submit({ ...validRegistration, email: "amrut@example.com", phone: "+919876543210" })
        ]);
        expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
        expect(await db.prepare("SELECT COUNT(*) AS count FROM registrations").first("count"))
            .toBe(1);
    });

    it("allows the same phone with a different email", async () => {
        expect((await submit(validRegistration)).status).toBe(200);
        expect((await submit({ ...validRegistration, email: "second@example.com" })).status).toBe(200);
    });

    it("returns 500 for an unrelated database failure", async () => {
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const brokenDatabase = {
                prepare() { throw new Error("Database unavailable"); }
            } as unknown as D1Database;
            const response = await worker.fetch(new Request("https://example.com/api/register", {
                method: "POST",
                body: JSON.stringify(validRegistration)
            }), { gitanushilanam_db: brokenDatabase });
            expect(response.status).toBe(500);
            expect(await response.json()).toMatchObject({ message: "Unable to process the registration." });
        } finally {
            log.mockRestore();
        }
    });

    it("handles CORS preflight", async () => {
        const response = await SELF.fetch("https://example.com/api/register", { method: "OPTIONS" });
        expect(response.status).toBe(204);
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });

    it("serves the health check and returns 404 for unknown routes", async () => {
        expect((await SELF.fetch("https://example.com/api/test")).status).toBe(200);
        expect((await SELF.fetch("https://example.com/unknown")).status).toBe(404);
    });
});
