import { type Env, readRequiredText, jsonResponse, verifyTurnstile } from "./registration-support";
import { MENTOR_SELECT, type Mentor, mentorEmail, mentorPhone, readMentorJson, sha256, mentorGroup } from "./mentor-support";

const SESSION_SECONDS = 8 * 60 * 60;
interface MentorSession { session_hash: string; email: string; phone: string; expires_at: number }

export async function limitMentorAttempts(request: Request, env: Env, action: string, identity = ""): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const ip = request.headers.get("CF-Connecting-IP") || "local";
    const keys = [await sha256(`${action}:ip:${ip}`)];
    if (identity) keys.push(await sha256(`${action}:identity:${identity}`));
    const batch = keys.map(key => env.MENTORS_DB.prepare(`
        INSERT INTO mentor_login_attempts (attempt_key, attempts, expires_at) VALUES (?, 1, ?)
        ON CONFLICT(attempt_key) DO UPDATE SET
            attempts = CASE WHEN expires_at <= ? THEN 1 ELSE attempts + 1 END,
            expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
        RETURNING attempts
    `).bind(key, now + 900, now, now));
    const results = await env.MENTORS_DB.batch<{ attempts: number }>([
        ...batch, env.MENTORS_DB.prepare("DELETE FROM mentor_login_attempts WHERE expires_at <= ?").bind(now)
    ]);
    return keys.every((_, index) => (results[index].results[0]?.attempts ?? Infinity) <= (index === 0 ? 50 : 15));
}
export async function getMentorSession(request: Request, env: Env): Promise<MentorSession | null> {
    const token = request.headers.get("Authorization")?.match(/^Bearer ([a-f0-9]{64})$/u)?.[1];
    if (!token) return null;
    return env.MENTORS_DB.prepare("SELECT * FROM mentor_sessions WHERE session_hash = ? AND expires_at > ?")
        .bind(await sha256(token), Math.floor(Date.now() / 1000)).first<MentorSession>();
}
export function sessionMentors(env: Env, session: MentorSession): Promise<D1Result<Mentor>> {
    return env.MENTORS_DB.prepare(`${MENTOR_SELECT} WHERE m.email = ? AND m.phone = ? ORDER BY s.registration_id`)
        .bind(session.email, session.phone).all<Mentor>();
}
export async function mentorLogin(request: Request, env: Env): Promise<Response> {
    const data = await readMentorJson(request);
    const email = mentorEmail(data.email), phone = mentorPhone(data.phone);
    if (!await limitMentorAttempts(request, env, "login", `${email}:${phone}`)) {
        return jsonResponse(request, { success: false, message: "Too many login attempts. Please try again in 15 minutes." }, 429);
    }
    if (!await verifyTurnstile(readRequiredText(data.turnstile_token, "Security verification", 2048), request, env.TURNSTILE_SECRET_KEY, "mentor_login")) {
        return jsonResponse(request, { success: false, message: "Please complete security verification again." }, 403);
    }
    const mentors = await env.MENTORS_DB.prepare(`${MENTOR_SELECT} WHERE m.email = ? AND m.phone = ? ORDER BY s.registration_id`)
        .bind(email, phone).all<Mentor>();
    if (!mentors.results.length) return jsonResponse(request, { success: false, message: "No mentor registration matches this email and phone number." }, 401);
    const token = (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");
    const now = Math.floor(Date.now() / 1000), expiresAt = now + SESSION_SECONDS;
    await env.MENTORS_DB.batch([
        env.MENTORS_DB.prepare("DELETE FROM mentor_sessions WHERE expires_at <= ?").bind(now),
        env.MENTORS_DB.prepare("INSERT INTO mentor_sessions (session_hash, email, phone, expires_at) VALUES (?, ?, ?, ?)")
            .bind(await sha256(token), email, phone, expiresAt)
    ]);
    return jsonResponse(request, { success: true, session_token: token, expires_at: expiresAt, mentors: mentors.results, whatsapp_group: mentorGroup(env) });
}
export async function mentorSessionResponse(request: Request, env: Env, logout = false): Promise<Response> {
    const session = await getMentorSession(request, env);
    if (logout) {
        if (session) await env.MENTORS_DB.prepare("DELETE FROM mentor_sessions WHERE session_hash = ?").bind(session.session_hash).run();
        return jsonResponse(request, { success: true });
    }
    if (!session) return jsonResponse(request, { success: false, message: "Please sign in using Mentor Login." }, 401);
    return jsonResponse(request, { success: true, mentors: (await sessionMentors(env, session)).results,
        expires_at: session.expires_at, whatsapp_group: mentorGroup(env) });
}
