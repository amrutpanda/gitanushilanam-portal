import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import initialSchema from "../migrations/0001_create_registrations_table.sql?raw";
import participantDetails from "../migrations/0003_add_gender_and_institution.sql?raw";
import adminAccess from "../migrations/0005_create_admin_accesslist.sql?raw";
import adminAuth from "../migrations/0006_admin_auth.sql?raw";
import participantGroup from "../migrations/0007_add_participant_group.sql?raw";
import auditLog from "../migrations/0008_super_admin_audit.sql?raw";

import uniqueContacts from "../migrations/0004_make_email_phone_unique.sql?raw";
import instituteRegistration from "../migrations/0010_institute_registration.sql?raw";

const db = env.gitanushilanam_db;
const sessionToken = "s".repeat(43);
const participantId = 77;
const participantEmail = "participant@example.com";

async function applyMigration(sql: string) {
    const executableSql = sql.replace(/--.*$/gmu, "");

    // Keep the SELECT CASE ... END; inside each trigger together with its END.
    for (const statement of executableSql.split(/;(?!\s*END\b)/iu)) {
        if (statement.trim()) {
            await db.prepare(statement).run();
        }
    }
}

async function hashSessionToken(token: string): Promise<string> {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(token)
    );

    return Buffer.from(digest).toString("base64url");
}

async function seed(role: "super_admin" | "admin") {
    await db.prepare(`
        INSERT INTO registrations (
            id,
            name,
            email,
            phone,
            whatsapp,
            age,
            participant_group,
            gender,
            institution_organization,
            country,
            state,
            city,
            heard_from,
            bhagavad_gita_quiz,
            shloka_recitation,
            animated_bg_video,
            treasure_hunt
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
        participantId,
        "Test Participant",
        participantEmail,
        "+919876543210",
        "+919876543210",
        18,
        "senior",
        "other",
        "Test Institution",
        "India",
        "Odisha",
        "Puri",
        "Friend",
        1,
        1,
        0,
        0
    ).run();

    await db.prepare(`
        INSERT INTO admin_accesslist (id, email, name, role, active)
        VALUES (1, ?, ?, ?, 1)
    `).bind("owner@example.com", "Owner", role).run();

    await db.prepare(`
        INSERT INTO admin_sessions (admin_id, session_hash, expires_at)
        VALUES (1, ?, ?)
    `).bind(
        await hashSessionToken(sessionToken),
        Math.floor(Date.now() / 1000) + 3600
    ).run();
}

function deleteParticipant(confirmationEmail: string, authenticated = true) {
    const headers = new Headers({
        "Content-Type": "application/json",
        "Origin": "https://gitanushilanam.net"
    });

    if (authenticated) {
        headers.set("Authorization", `Bearer ${sessionToken}`);
    }

    return SELF.fetch(
        `https://example.com/admin/api/registrations/${participantId}`,
        {
            method: "DELETE",
            headers,
            body: JSON.stringify({ confirmation_email: confirmationEmail })
        }
    );
}

beforeAll(async () => {
    for (const migration of [
        initialSchema,
        participantDetails,
        adminAccess,
        adminAuth,
        participantGroup,
        auditLog,
        uniqueContacts,
        instituteRegistration
    ]) {
        await applyMigration(migration);
    }
});

beforeEach(async () => {
    await db.prepare("DELETE FROM admin_audit_log").run();
    await db.prepare("DELETE FROM admin_sessions").run();
    await db.prepare("DELETE FROM admin_accesslist").run();
    await db.prepare("DELETE FROM registrations").run();
});

describe("Super Admin registration deletion", () => {
    it("rejects unauthenticated and ordinary admin deletion", async () => {
        await seed("admin");

        expect((await deleteParticipant(participantEmail, false)).status).toBe(401);
        expect((await deleteParticipant(participantEmail)).status).toBe(403);
        expect(
            await db.prepare("SELECT COUNT(*) FROM registrations").first<number>("COUNT(*)")
        ).toBe(1);
    });

    it("requires the participant's exact email confirmation", async () => {
        await seed("super_admin");

        const response = await deleteParticipant("someone-else@example.com");

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
            success: false,
            message: "The confirmation email does not match this participant."
        });
        expect(
            await db.prepare("SELECT COUNT(*) FROM registrations").first<number>("COUNT(*)")
        ).toBe(1);
    });

    it("deletes the participant and records the previous data in the audit log", async () => {
        await seed("super_admin");

        const response = await deleteParticipant(participantEmail.toUpperCase());

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            success: true,
            deleted_registration: {
                id: participantId,
                name: "Test Participant",
                email: participantEmail
            }
        });
        expect(
            await db.prepare("SELECT COUNT(*) FROM registrations").first<number>("COUNT(*)")
        ).toBe(0);

        const audit = await db.prepare(`
            SELECT action, entity_type, entity_id, old_values, new_values
            FROM admin_audit_log
            LIMIT 1
        `).first<Record<string, string>>();

        expect(audit).toMatchObject({
            action: "registration_delete",
            entity_type: "registration",
            entity_id: String(participantId)
        });
        expect(JSON.parse(audit?.old_values ?? "{}")).toMatchObject({
            name: "Test Participant",
            email: participantEmail
        });
        expect(JSON.parse(audit?.new_values ?? "{}")).toEqual({ deleted: true });
    });
});

describe("Admin state participant totals", () => {
    it("separates countries with the same state, normalizes spacing and case, and includes missing locations", async () => {
        await seed("admin");
        for (const [index, [country, state]] of [[" india ", " odisha "], ["India", "Karnataka"], ["India", "   "], ["Other country", "Odisha"], ["   ", "Odisha"]].entries()) {
            await db.prepare(`
                INSERT INTO registrations (name, email, phone, whatsapp, age, country, state, city)
                VALUES ('Test', ?, ?, ?, 18, ?, ?, 'Test')
            `).bind(`state${index}@example.com`, `phone${index}`, `phone${index}`, country, state).run();
        }
        const response = await SELF.fetch("https://example.com/admin/api/summary", {
            headers: { Authorization: `Bearer ${sessionToken}` }
        });
        expect(response.status).toBe(200);
        const result = await response.json() as {
            summary: { total: number };
            participants_by_state: Array<{ country: string; state: string; count: number }>;
        };
        expect(result.participants_by_state.map(row => ({ ...row, country: row.country.toLowerCase(), state: row.state.toLowerCase() }))).toEqual([
            { country: "country not specified", state: "odisha", count: 1 },
            { country: "india", state: "odisha", count: 2 },
            { country: "india", state: "karnataka", count: 1 },
            { country: "india", state: "not specified", count: 1 },
            { country: "other country", state: "odisha", count: 1 }
        ]);
        expect(result.participants_by_state.reduce((sum, row) => sum + row.count, 0)).toBe(result.summary.total);
        const unauthorized = await SELF.fetch("https://example.com/admin/api/summary");
        expect(unauthorized.status).toBe(401);
        await db.prepare("DELETE FROM registrations").run();
        const empty = await SELF.fetch("https://example.com/admin/api/summary", {
            headers: { Authorization: `Bearer ${sessionToken}` }
        });
        expect(await empty.json()).toMatchObject({ participants_by_state: [] });
    });
});

describe("Super Admin institute editing", () => {
    async function edit(changes: Record<string, unknown> = {}) {
        return SELF.fetch(`https://example.com/admin/api/registrations/${participantId}`, {
            method: "PATCH", headers: { Authorization: `Bearer ${sessionToken}`, Origin: "https://gitanushilanam.net", "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Updated Student", email: participantEmail, phone: "+919876543210", whatsapp: "+919876543210", age: 18,
                gender: "other", institution_organization: "Test Institution", participant_group: "senior", country: "India", state: "Odisha", city: "Puri",
                heard_from: "School", competitions: ["bhagavad_gita_quiz"], ...changes })
        });
    }
    async function second(type: string, school = "Test Institution") {
        await db.prepare(`INSERT INTO registrations (name, email, phone, whatsapp, age, country, state, city, registration_type, institution_organization, institute_school_key)
            VALUES ('Other', ?, '+919876543211', '+919876543211', 15, 'India', 'Odisha', 'Puri', ?, ?, ?)`)
            .bind("shared@example.com", type, school, type === "institute" ? school.toLowerCase() : null).run();
    }
    it("allows shared institute emails while preserving phone uniqueness and Quiz-only participation", async () => {
        await seed("super_admin");
        await db.prepare("UPDATE registrations SET registration_type = 'institute', institute_school_key = 'test institution', shloka_recitation = 0").run();
        await second("institute");
        expect((await edit({ email: "shared@example.com" })).status).toBe(200);
        expect((await edit({ phone: "+919876543211" })).status).toBe(409);
        expect((await edit({ competitions: ["treasure_hunt"] })).status).toBe(400);
        expect((await edit({ institution_organization: "" })).status).toBe(400);
        expect(await db.prepare("SELECT registration_type, email, treasure_hunt FROM registrations WHERE id = ?").bind(participantId).first())
            .toMatchObject({ registration_type: "institute", email: "shared@example.com", treasure_hunt: 0 });
    });
    it("still rejects duplicate individual emails and prevents clients changing registration type", async () => {
        await seed("super_admin"); await second("individual");
        expect((await edit({ email: "shared@example.com", registration_type: "institute" })).status).toBe(409);
        expect(await db.prepare("SELECT registration_type FROM registrations WHERE id = ?").bind(participantId).first("registration_type")).toBe("individual");
    });
    it.each(["individual", "other school"])("rejects moving an institute record to an email owned by %s", async owner => {
        await seed("super_admin");
        await db.prepare("UPDATE registrations SET registration_type = 'institute', institute_school_key = 'test institution', shloka_recitation = 0").run();
        await second(owner === "individual" ? "individual" : "institute", "Other School");
        expect((await edit({ email: "shared@example.com" })).status).toBe(409);
        expect(await db.prepare("SELECT email FROM registrations WHERE id = ?").bind(participantId).first("email")).toBe(participantEmail);
        expect(await db.prepare("SELECT COUNT(*) FROM admin_audit_log").first("COUNT(*)")).toBe(0);
    });
    it("rejects moving an individual record to a school email", async () => {
        await seed("super_admin"); await second("institute");
        expect((await edit({ email: "SHARED@example.com" })).status).toBe(409);
    });
    it("allows normalized school spelling but rejects renaming one student to a different school under a shared email", async () => {
        await seed("super_admin");
        await db.prepare("UPDATE registrations SET registration_type = 'institute', institute_school_key = 'test institution', shloka_recitation = 0").run();
        await second("institute");
        expect((await edit({ email: "shared@example.com", institution_organization: " TEST   Institution " })).status).toBe(200);
        expect((await edit({ email: "shared@example.com", institution_organization: "Different School" })).status).toBe(409);
        await expect(db.prepare("UPDATE registrations SET institute_school_key = 'different school' WHERE id = ?").bind(participantId).run())
            .rejects.toThrow("registration_email_conflict");
        expect(await db.prepare("SELECT institute_school_key FROM registrations WHERE id = ?").bind(participantId).first("institute_school_key")).toBe("test institution");
    });
    it("keeps ordinary admins read-only", async () => {
        await seed("admin"); expect((await edit()).status).toBe(403);
    });
});
