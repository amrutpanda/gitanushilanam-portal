// This is a comparison key, not a school account or public identifier.
export function normalizeSchoolName(name: string): string {
    return name.trim().replace(/\s+/gu, " ").toLowerCase();
}

class RegistrationEmailConflict extends Error {}

export async function assertRegistrationEmailAvailable(
    db: D1Database, email: string, type: "individual" | "institute",
    schoolKey: string | null = null, excludingId = -1
): Promise<void> {
    const conflict = await db.prepare(`
        SELECT registration_type FROM registrations
        WHERE email = ? COLLATE NOCASE AND id <> ?
          AND (? = 'individual' OR registration_type <> 'institute' OR institute_school_key IS NOT ?)
        LIMIT 1
    `).bind(email, excludingId, type, schoolKey).first<{ registration_type: string }>();
    if (!conflict) return;
    if (type === "individual") {
        throw new RegistrationEmailConflict("This email is already registered. Please use a different email address.");
    }
    throw new RegistrationEmailConflict(conflict.registration_type === "individual"
        ? "This email is already used for an individual registration. Please use a different school email."
        : "This email is already used by another school. Please check the school name or use a different email.");
}

export function registrationEmailConflictMessage(error: unknown): string | null {
    if (error instanceof RegistrationEmailConflict) return error.message;
    // The database guard also covers concurrent submissions and admin edits.
    if (error instanceof Error && error.message.includes("registration_email_conflict")) {
        return "This email is already registered to an individual or a different school. Please check the school name or use a different email.";
    }
    return null;
}
