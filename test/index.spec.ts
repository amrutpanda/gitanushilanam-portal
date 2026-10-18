import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import initialSchema from "../migrations/0001_create_registrations_table.sql?raw";
import uniqueRegistration from "../migrations/0002_unique_registration.sql?raw";
import participantDetails from "../migrations/0003_add_gender_and_institution.sql?raw";
import uniqueContacts from "../migrations/0004_make_email_phone_unique.sql?raw";
import participantGroup from "../migrations/0007_add_participant_group.sql?raw";
import whatsappLinks from "../migrations/0009_whatsapp_invite_links.sql?raw";

const db = env.gitanushilanam_db;
const testEnv = {
    gitanushilanam_db: db,
    TURNSTILE_SECRET_KEY: "turnstile-secret",
    RESEND_API_KEY: "resend-secret",
    REGISTRATION_DEADLINE: "2099-11-01T23:59:59+05:30"
};
const validRegistration = {
    name: "  अमृत O’Connor  ",
    email: "  AMRUT@example.com  ",
    phone: "+91 98765 43210",
    whatsapp: "+91 98765 43210",
    age: 20,
    gender: "other",
    institution_organization: "Gita Institute",
    country: "India",
    state: "Maharashtra",
    city: "Pune",
    heard_from: "Friend",
    participant_group: "youth_adult",
    competitions: ["bhagavad_gita_quiz", "treasure_hunt"],
    turnstile_token: "valid-turnstile-token"
};

async function applyMigration(sql: string) {
    const executableSql = sql.replace(/--.*$/gmu, "");

    for (const statement of executableSql.split(";")) {
        if (statement.trim()) {
            await db.prepare(statement).run();
        }
    }
}

function submit(data: unknown, overrides: Partial<typeof testEnv> = {}) {
    return worker.fetch(new Request("https://example.com/api/register", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Origin": "https://gitanushilanam.net"
        },
        body: JSON.stringify(data)
    }), { ...testEnv, ...overrides });
}

beforeAll(async () => {
    for (const migration of [
        initialSchema,
        uniqueRegistration,
        participantDetails,
        uniqueContacts,
        participantGroup,
        whatsappLinks
    ]) {
        await applyMigration(migration);
    }

    for (const group of ["sub_junior", "junior", "senior", "youth_adult"]) {
        await db.prepare(`
            INSERT INTO whatsapp_group_links (
                participant_group,
                bhagavad_gita_quiz,
                shloka_recitation,
                animated_bg_video,
                treasure_hunt
            ) VALUES (?, ?, ?, ?, ?)
        `).bind(
            group,
            `https://chat.whatsapp.com/${group}Quiz`,
            "https://chat.whatsapp.com/ShlokaGroup",
            "https://chat.whatsapp.com/VideoGroup",
            "https://chat.whatsapp.com/TreasureGroup"
        ).run();
    }
});

beforeEach(async () => {
    vi.restoreAllMocks();
    await db.prepare("DELETE FROM registrations").run();

    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
        const url = typeof input === "string" ? input : input.url;

        if (url === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
            return Response.json({
                success: true,
                hostname: "gitanushilanam.net",
                action: "registration"
            });
        }

        if (url === "https://api.resend.com/emails/batch") {
            return Response.json({ data: [{ id: "email-1" }] });
        }

        throw new Error(`Unexpected outbound request: ${url}`);
    });
});

describe("Registration API", () => {
    it("saves normalized details and returns selected group links after emailing", async () => {
        const response = await submit(validRegistration);
        expect(response.status).toBe(200);
        const result = await response.json<{
            success: boolean;
            email_sent: boolean;
            whatsapp_groups: Array<{ key: string; label: string; url: string }>;
        }>();

        expect(result).toMatchObject({
            success: true,
            email_sent: true,
            whatsapp_groups: [
                {
                    key: "bhagavad_gita_quiz",
                    label: "Bhagavad Gita Quiz",
                    url: "https://chat.whatsapp.com/youth_adultQuiz"
                },
                {
                    key: "treasure_hunt",
                    label: "Treasure Hunt",
                    url: "https://chat.whatsapp.com/TreasureGroup"
                }
            ]
        });

        const row = await db.prepare("SELECT * FROM registrations WHERE email = ?")
            .bind("amrut@example.com").first();
        expect(row).toMatchObject({
            name: "अमृत O’Connor",
            email: "amrut@example.com",
            phone: "+919876543210",
            whatsapp: "+919876543210",
            participant_group: "youth_adult",
            bhagavad_gita_quiz: 1,
            shloka_recitation: 0,
            animated_bg_video: 0,
            treasure_hunt: 1
        });

        const resendCall = vi.mocked(fetch).mock.calls.find(([input]) =>
            (typeof input === "string" ? input : input.url) === "https://api.resend.com/emails/batch"
        );
        expect(resendCall).toBeDefined();
        const resendRequest = resendCall?.[1];
        expect(new Headers(resendRequest?.headers).get("Idempotency-Key"))
            .toMatch(/^registration-confirmation-\d+-[0-9a-f-]{36}$/u);
        expect(String(resendRequest?.body)).toContain("Registration confirmed");
        expect(String(resendRequest?.body)).toContain("youth_adultQuiz");
    });

    it("sends a new confirmation after a participant is deleted and registers again", async () => {
        expect((await submit(validRegistration)).status).toBe(200);
        const firstRegistrationId = await db.prepare(
            "SELECT id FROM registrations WHERE email = ?"
        ).bind("amrut@example.com").first<number>("id");

        await db.prepare("DELETE FROM registrations WHERE id = ?")
            .bind(firstRegistrationId).run();

        expect((await submit(validRegistration)).status).toBe(200);
        const secondRegistrationId = await db.prepare(
            "SELECT id FROM registrations WHERE email = ?"
        ).bind("amrut@example.com").first<number>("id");

        expect(secondRegistrationId).toBe(firstRegistrationId);

        const idempotencyKeys = vi.mocked(fetch).mock.calls
            .filter(([input]) =>
                (typeof input === "string" ? input : input.url)
                    === "https://api.resend.com/emails/batch"
            )
            .map(([, init]) => new Headers(init?.headers).get("Idempotency-Key"));

        expect(idempotencyKeys).toHaveLength(2);
        expect(new Set(idempotencyKeys).size).toBe(2);
    });

    it("keeps a successful registration when confirmation email delivery fails", async () => {
        vi.mocked(fetch).mockImplementation(async input => {
            const url = typeof input === "string" ? input : input.url;

            if (url.includes("turnstile")) {
                return Response.json({
                    success: true,
                    hostname: "gitanushilanam.net",
                    action: "registration"
                });
            }

            return Response.json({ message: "Temporary email failure" }, { status: 503 });
        });
        const log = vi.spyOn(console, "error").mockImplementation(() => {});

        const response = await submit(validRegistration);
        const result = await response.json<{ success: boolean; email_sent: boolean }>();

        expect(response.status).toBe(200);
        expect(result).toMatchObject({ success: true, email_sent: false });
        expect(await db.prepare("SELECT COUNT(*) FROM registrations").first<number>("COUNT(*)"))
            .toBe(1);
        log.mockRestore();
    });

    it("closes registration after the configured deadline without exposing the date", async () => {
        const response = await submit(validRegistration, {
            REGISTRATION_DEADLINE: "2000-11-01T23:59:59+05:30"
        });

        expect(response.status).toBe(410);
        expect(await response.json()).toEqual({
            success: false,
            code: "registration_closed",
            message: "No longer accepting registrations."
        });
        expect(vi.mocked(fetch)).not.toHaveBeenCalled();
        expect(await db.prepare("SELECT COUNT(*) FROM registrations").first<number>("COUNT(*)"))
            .toBe(0);
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
        ["wrong gender", { gender: "unknown" }],
        ["wrong participant group", { participant_group: "unknown" }],
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

    it.each([null, [], "text", 42])("rejects a non-object JSON body: %j", async body => {
        expect((await submit(body)).status).toBe(400);
    });

    it("returns 400 for malformed JSON", async () => {
        const response = await worker.fetch(new Request("https://example.com/api/register", {
            method: "POST",
            body: "{broken"
        }), testEnv);
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

    it("rejects the same phone with a different email", async () => {
        expect((await submit(validRegistration)).status).toBe(200);
        expect((await submit({ ...validRegistration, email: "second@example.com" })).status)
            .toBe(409);
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
            }), { ...testEnv, gitanushilanam_db: brokenDatabase });
            expect(response.status).toBe(500);
            expect(await response.json()).toMatchObject({
                message: "Unable to process the registration."
            });
        } finally {
            log.mockRestore();
        }
    });

    it("handles CORS preflight for the registration site", async () => {
        const response = await SELF.fetch("https://example.com/api/register", {
            method: "OPTIONS",
            headers: { "Origin": "https://gitanushilanam.net" }
        });
        expect(response.status).toBe(204);
        expect(response.headers.get("Access-Control-Allow-Origin"))
            .toBe("https://gitanushilanam.net");
        expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    });

    it("serves the health check and returns 404 for unknown routes", async () => {
        expect((await SELF.fetch("https://example.com/api/test")).status).toBe(200);
        expect((await SELF.fetch("https://example.com/unknown")).status).toBe(404);
    });
});
