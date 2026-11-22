import {
    type Env, ValidationError, allowedGenders, allowedParticipantGroups,
    readRequiredText, readPhoneNumber, isAllowedOrigin, jsonResponse, verifyTurnstile
} from "./registration-support";
import {
    type AdminEmailParticipant, buildInstituteConfirmationEmail,
    getParticipantCompetitionLinks, sendResendBatch
} from "./email";

import { normalizeSchoolName, assertRegistrationEmailAvailable, registrationEmailConflictMessage } from "./registration-email-policy";

const QUIZ = "bhagavad_gita_quiz";

export function validateInstituteEdit(type: unknown, school: string | null, competitions: string[]): void {
    if (type !== "institute") return;
    if (!school) throw new ValidationError("School / Institute name is required for institute registrations.");
    if (competitions.length !== 1 || competitions[0] !== QUIZ) {
        throw new ValidationError("Institute registrations can participate only in Bhagavad Gita Quiz.");
    }
}

interface InstituteRecord extends AdminEmailParticipant {
    institute_request_key: string;
    institute_request_hash: string;
    institute_email_sent: number;
    institute_email_first_attempt_at: number | null;
}

async function getSubmission(db: D1Database, value: string, byPhone = false): Promise<InstituteRecord | null> {
    return db.prepare(`
        SELECT r.*, links.bhagavad_gita_quiz AS bhagavad_gita_quiz_link,
            NULL AS shloka_recitation_link, NULL AS animated_bg_video_link, NULL AS treasure_hunt_link
        FROM registrations r
        LEFT JOIN whatsapp_group_links links ON links.participant_group = r.participant_group
        WHERE r.${byPhone ? "phone" : "institute_request_key"} = ? AND r.registration_type = 'institute'
    `).bind(value).first<InstituteRecord>();
}

async function sendConfirmation(env: Env, record: InstituteRecord): Promise<boolean> {
    if (record.institute_email_sent) return true;
    if (!env.RESEND_API_KEY?.trim()) return false;
    const now = Math.floor(Date.now() / 1000);
    // Keep ambiguous retries within the email provider's 24-hour idempotency window.
    // Older pending messages can be sent explicitly by a Super Admin.
    if (record.institute_email_first_attempt_at !== null && now - record.institute_email_first_attempt_at > 23 * 3600) return false;
    const claim = await env.gitanushilanam_db.prepare(`
        UPDATE registrations
        SET institute_email_lease_until = ?, institute_email_first_attempt_at = COALESCE(institute_email_first_attempt_at, ?)
        WHERE id = ? AND institute_email_sent = 0 AND institute_email_lease_until <= ?
    `).bind(now + 120, now, record.id, now).run();
    if (!claim.meta.changes) {
        return Boolean(await env.gitanushilanam_db.prepare(
            "SELECT institute_email_sent FROM registrations WHERE id = ?"
        ).bind(record.id).first<number>("institute_email_sent"));
    }
    try {
        await sendResendBatch(env.RESEND_API_KEY, `institute-confirmation-${record.institute_request_key}`,
            [buildInstituteConfirmationEmail(record)]);
        await env.gitanushilanam_db.prepare(`
            UPDATE registrations SET institute_email_sent = 1, institute_email_lease_until = 0 WHERE id = ?
        `).bind(record.id).run();
        return true;
    } catch (error) {
        console.error("Institute confirmation email failed:", error);
        await env.gitanushilanam_db.prepare(
            "UPDATE registrations SET institute_email_lease_until = 0 WHERE id = ? AND institute_email_lease_until = ?"
        ).bind(record.id, now + 120).run();
        return false;
    }
}

export async function handleInstituteRegistration(request: Request, env: Env): Promise<Response> {
    if (!isAllowedOrigin(request)) {
        return jsonResponse(request, { success: false, message: "Request origin is not allowed." }, 403);
    }
    try {
        let body: unknown;
        try { body = await request.json(); }
        catch { throw new ValidationError("Please send valid JSON."); }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw new ValidationError("Registration data must be a JSON object.");
        }
        const data = body as Record<string, unknown>;
        const token = readRequiredText(data.turnstile_token, "Security verification", 2048);
        if (!await verifyTurnstile(token, request, env.TURNSTILE_SECRET_KEY, "registration")) {
            return jsonResponse(request, { success: false, message: "Security verification failed. Please try again." }, 403);
        }
        const key = readRequiredText(data.request_id, "Submission identifier", 36).toLowerCase();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
            throw new ValidationError("Invalid submission identifier. Please refresh and try again.");
        }
        const participant = {
            name: readRequiredText(data.name, "Name", 100),
            email: readRequiredText(data.email, "School email", 254).toLowerCase(),
            phone: readPhoneNumber(data.phone, "Phone number"),
            whatsapp: readPhoneNumber(data.whatsapp, "WhatsApp number"),
            gender: readRequiredText(data.gender, "Gender", 30),
            age: data.age,
            participant_group: readRequiredText(data.participant_group, "Participant group", 30),
            institution_organization: readRequiredText(data.institution_organization, "School / Institute name", 200),
            country: readRequiredText(data.country, "Country", 100),
            state: readRequiredText(data.state, "State", 100),
            city: readRequiredText(data.city, "City", 100),
            heard_from: readRequiredText(data.heard_from, "How you heard about us", 200)
        };
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(participant.email)) throw new ValidationError("Please enter a valid school email address.");
        if (typeof participant.age !== "number" || !Number.isInteger(participant.age) || participant.age < 3 || participant.age > 120) throw new ValidationError("Please enter a valid age.");
        if (!allowedGenders.includes(participant.gender)) throw new ValidationError("Please select a valid gender.");
        if (!allowedParticipantGroups.includes(participant.participant_group)) throw new ValidationError("Please select a valid participant group.");
        if (!Array.isArray(data.competitions) || data.competitions.length !== 1 || data.competitions[0] !== QUIZ) {
            throw new ValidationError("Institute registrations can participate only in Bhagavad Gita Quiz.");
        }
        const schoolKey = normalizeSchoolName(participant.institution_organization);
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({
            ...participant, institution_organization: schoolKey
        })));
        const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
        let record = await getSubmission(env.gitanushilanam_db, key);
        // Recover a saved submission even if a refresh/new tab lost its retry key.
        record ??= await getSubmission(env.gitanushilanam_db, participant.phone, true);
        let replayed = Boolean(record);
        if (!record) {
            const deadline = Date.parse(env.REGISTRATION_DEADLINE);
            if (!Number.isFinite(deadline)) return jsonResponse(request, { success: false, message: "Registration is temporarily unavailable." }, 503);
            if (Date.now() > deadline) return jsonResponse(request, { success: false, code: "registration_closed", message: "No longer accepting registrations." }, 410);
            await assertRegistrationEmailAvailable(env.gitanushilanam_db, participant.email, "institute", schoolKey);
            const links = await env.gitanushilanam_db.prepare(
                "SELECT bhagavad_gita_quiz FROM whatsapp_group_links WHERE participant_group = ?"
            ).bind(participant.participant_group).first<{ bhagavad_gita_quiz: string }>();
            if (!links) return jsonResponse(request, { success: false, message: "Registration is temporarily unavailable. Please try again later." }, 503);
            const insert = await env.gitanushilanam_db.prepare(`
                INSERT INTO registrations (
                    name, email, phone, whatsapp, gender, age, participant_group, institution_organization,
                    country, state, city, heard_from, bhagavad_gita_quiz, shloka_recitation, animated_bg_video,
                    treasure_hunt, registration_type, institute_request_key, institute_request_hash, institute_school_key
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 'institute', ?, ?, ?)
                ON CONFLICT DO NOTHING
            `).bind(participant.name, participant.email, participant.phone, participant.whatsapp, participant.gender,
                participant.age, participant.participant_group, participant.institution_organization, participant.country,
                participant.state, participant.city, participant.heard_from, key, fingerprint, schoolKey).run();
            record = await getSubmission(env.gitanushilanam_db, key);
            record ??= await getSubmission(env.gitanushilanam_db, participant.phone, true);
            replayed = !insert.meta.changes;
            if (!record) return jsonResponse(request, { success: false, message: "A registration already exists with this phone number." }, 409);
        }
        if (record.institute_request_hash !== fingerprint) {
            return jsonResponse(request, { success: false, message: record.institute_request_key === key
                ? "This submission identifier was already used for different student details."
                : "A registration already exists with this phone number and different student details." }, 409);
        }
        // Saving the participant must remain successful even if email delivery fails.
        let emailSent = Boolean(record.institute_email_sent);
        try { emailSent = await sendConfirmation(env, record); }
        catch (error) { console.error("Institute email status update failed:", error); }
        return jsonResponse(request, {
            success: true, message: "Quiz registration successful.", already_registered: replayed,
            email_sent: emailSent, whatsapp_groups: getParticipantCompetitionLinks(record),
            login_details: { email: record.email, phone: record.phone }
        });
    } catch (error) {
        const emailConflict = registrationEmailConflictMessage(error);
        if (emailConflict) return jsonResponse(request, { success: false, message: emailConflict }, 409);
        if (error instanceof ValidationError) return jsonResponse(request, { success: false, message: error.message }, 400);
        console.error("Institute registration error:", error);
        return jsonResponse(request, { success: false, message: "Unable to process the registration. Your details are retained; please try again." }, 500);
    }
}
