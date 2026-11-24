import { type Env, ValidationError, jsonResponse, readRequiredText, verifyTurnstile } from "./registration-support";
import { MENTOR_SELECT, INDIAN_STATES, type Mentor, mentorEmail, mentorPhone, mentorGroup, uuid, sha256, readMentorJson } from "./mentor-support";
import { limitMentorAttempts } from "./mentor-auth";
import { sendMentorConfirmation } from "./mentor-email";

export async function registerMentor(request: Request, env: Env): Promise<Response> {
    const data = await readMentorJson(request);
    const requestId = uuid(data.request_id);
    const name = readRequiredText(data.name, "Mentor name", 100);
    const school = readRequiredText(data.school_name, "School name", 200);
    const email = mentorEmail(data.email), phone = mentorPhone(data.phone);
    const designation = readRequiredText(data.designation, "Mentor designation", 100);
    const state = readRequiredText(data.state, "State", 100);
    const district = readRequiredText(data.district, "District", 100);
    const place = readRequiredText(data.place, "Place", 100);
    if (!INDIAN_STATES.includes(state)) throw new ValidationError("Choose an Indian state or Union Territory.");
    const strength = data.total_strength, willing = data.willing_count;
    if (typeof strength !== "number" || !Number.isInteger(strength) || strength < 1 || strength > 10000000 ||
        typeof willing !== "number" || !Number.isInteger(willing) || willing < 0 || willing > strength) {
        throw new ValidationError("Enter whole-number counts. Willing participants must be between zero and the school’s total strength.");
    }
    const existingId = data.school_registration_id;
    if (existingId != null && (!Number.isInteger(existingId) || Number(existingId) < 10000 || Number(existingId) > 19999)) {
        throw new ValidationError("Enter the existing school registration ID between 10000 and 19999, or leave it blank for a new school.");
    }
    if (!await limitMentorAttempts(request, env, "register")) {
        return jsonResponse(request, { success: false, message: "Too many registration attempts. Please try again in 15 minutes." }, 429);
    }
    if (!await verifyTurnstile(readRequiredText(data.turnstile_token, "Security verification", 2048), request, env.TURNSTILE_SECRET_KEY, "mentor_register")) {
        return jsonResponse(request, { success: false, message: "Please complete security verification again." }, 403);
    }
    const group = mentorGroup(env); // Check configuration before saving anything.
    const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
    // Name alone never links schools. Full school name and location identify an exact repeated submission.
    const schoolKey = await sha256(JSON.stringify([school, state, district, place].map(normalize)));
    const fingerprint = await sha256(JSON.stringify([name, schoolKey, email, phone, designation, strength, willing]));
    const db = env.MENTORS_DB;
    if (existingId != null) {
        const selected = await db.prepare("SELECT identity_key FROM mentor_schools WHERE registration_id = ?").bind(existingId)
            .first<{ identity_key: string }>();
        if (!selected || selected.identity_key !== schoolKey) throw new ValidationError("The school name and location must match the existing school registration ID.");
    }
    const previous = await db.prepare("SELECT request_hash FROM mentors WHERE request_id = ?").bind(requestId).first<{ request_hash: string }>();
    if (previous && previous.request_hash !== fingerprint) {
        return jsonResponse(request, { success: false, message: "This registration attempt already saved different details. Please use Mentor Login." }, 409);
    }
    const mentorId = crypto.randomUUID();
    // Allocation and mentor creation are one transaction. No MAX()+1 value is computed outside the INSERT.
    try {
        await db.batch([
            db.prepare(`INSERT INTO mentor_schools (registration_id, identity_key, name, state, district, place)
                SELECT COALESCE((SELECT MAX(registration_id) FROM mentor_schools), 9999) + 1, ?, ?, ?, ?, ?
                WHERE NOT EXISTS (SELECT 1 FROM mentor_schools WHERE identity_key = ?)
                  AND COALESCE((SELECT MAX(registration_id) FROM mentor_schools), 9999) < 19999`)
                .bind(schoolKey, school, state, district, place, schoolKey),
            db.prepare(`INSERT INTO mentors (id, school_id, name, email, phone, designation, total_strength, willing_count, request_id, request_hash)
                SELECT ?, registration_id, ?, ?, ?, ?, ?, ?, ?, ? FROM mentor_schools WHERE identity_key = ?
                ON CONFLICT(school_id, email, phone) DO NOTHING`)
                .bind(mentorId, name, email, phone, designation, strength, willing, requestId, fingerprint, schoolKey)
        ]);
    } catch (error) {
        if (String(error).includes("mentors.request_id")) {
            return jsonResponse(request, { success: false, message: "This registration attempt is already saved. Please use Mentor Login." }, 409);
        }
        throw error;
    }
    const mentor = await db.prepare(`${MENTOR_SELECT} WHERE s.identity_key = ? AND m.email = ? AND m.phone = ?`)
        .bind(schoolKey, email, phone).first<Mentor>();
    if (!mentor) return jsonResponse(request, { success: false, message: "School registration capacity has been reached. Please contact the organizers." }, 503);
    const savedHash = await db.prepare("SELECT request_hash FROM mentors WHERE id = ?").bind(mentor.id).first<string>("request_hash");
    if (savedHash !== fingerprint) return jsonResponse(request, { success: false, message: "A mentor registration already exists for this school, email and phone. Please use Mentor Login; saved details have not been changed." }, 409);
    let emailSent = Boolean(mentor.email_sent_at);
    // Email service/storage errors must not turn a committed registration into a failed registration.
    if (!emailSent) {
        try { emailSent = await sendMentorConfirmation(env, mentor, `mentor-initial-${mentor.id}`); }
        catch { console.error("Mentor registration saved; confirmation remains pending."); }
    }
    return jsonResponse(request, { success: true, already_registered: mentor.id !== mentorId, school_registration_id: mentor.school_id,
        school_name: mentor.school_name, email_sent: emailSent, whatsapp_group: group, login_details: { email, phone } });
}
