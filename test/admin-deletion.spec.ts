import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import initialSchema from "../migrations/0001_create_registrations_table.sql?raw";
import participantDetails from "../migrations/0003_add_gender_and_institution.sql?raw";
import adminAccess from "../migrations/0005_create_admin_accesslist.sql?raw";
import adminAuth from "../migrations/0006_admin_auth.sql?raw";
import participantGroup from "../migrations/0007_add_participant_group.sql?raw";
import auditLog from "../migrations/0008_super_admin_audit.sql?raw";

const db = env.gitanushilanam_db;
const sessionToken = "s".repeat(43);
const participantId = 77;
const participantEmail = "participant@example.com";

async function applyMigration(sql: string) {
    const executableSql = sql.replace(/--.*$/gmu, "");

    for (const statement of executableSql.split(";")) {
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
        auditLog
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
