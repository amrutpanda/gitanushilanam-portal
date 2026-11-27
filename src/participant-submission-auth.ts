import { type Env, readRequiredText, readPhoneNumber, ValidationError, jsonResponse, verifyTurnstile } from './registration-support';
import { readSubmissionJson, submissionHash, participantColumns, type SubmissionParticipant } from './submission-support';

const SESSION_SECONDS = 8 * 60 * 60;
function bearer(request: Request): string | null { return request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/u)?.[1] || null; }
export async function submissionParticipant(request: Request, env: Env): Promise<SubmissionParticipant | null> {
    const token = bearer(request); if (!token) return null;
    return env.gitanushilanam_db.prepare(`SELECT ${participantColumns}
        FROM participant_submission_sessions s JOIN registrations r ON r.id = s.registration_id
        WHERE s.session_hash = ? AND s.expires_at > ? AND r.email = s.email COLLATE NOCASE AND r.phone = s.phone`)
        .bind(await submissionHash(token), Math.floor(Date.now() / 1000)).first<SubmissionParticipant>();
}
async function limitLogin(request: Request, env: Env, identity: string): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000), ip = request.headers.get('CF-Connecting-IP') || 'local';
    const keys = await Promise.all([submissionHash(`ip:${ip}`), submissionHash(`identity:${identity}`)]);
    const statements = keys.map(key => env.gitanushilanam_db.prepare(`
        INSERT INTO participant_submission_attempts (attempt_key, attempts, expires_at) VALUES (?, 1, ?)
        ON CONFLICT(attempt_key) DO UPDATE SET attempts = CASE WHEN expires_at <= ? THEN 1 ELSE attempts + 1 END,
        expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END RETURNING attempts`).bind(key, now + 900, now, now));
    const result = await env.gitanushilanam_db.batch<{ attempts: number }>([...statements,
        env.gitanushilanam_db.prepare('DELETE FROM participant_submission_attempts WHERE expires_at <= ?').bind(now)]);
    return result[0].results[0].attempts <= 50 && result[1].results[0].attempts <= 15;
}
export async function participantSubmissionLogin(request: Request, env: Env): Promise<Response> {
    const data = await readSubmissionJson(request);
    const email = readRequiredText(data.email, 'Registered email', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new ValidationError('Enter a valid email address.');
    const phone = readPhoneNumber(data.phone, 'Registered phone');
    if (!await limitLogin(request, env, `${email}:${phone}`)) return jsonResponse(request, { success: false, message: 'Too many login attempts. Please try again in 15 minutes.' }, 429);
    if (!await verifyTurnstile(readRequiredText(data.turnstile_token, 'Security verification', 2048), request, env.TURNSTILE_SECRET_KEY, 'participant_submission_login')) {
        return jsonResponse(request, { success: false, message: 'Please complete security verification again.' }, 403);
    }
    const participant = await env.gitanushilanam_db.prepare('SELECT id, email, phone FROM registrations WHERE email = ? COLLATE NOCASE AND phone = ?')
        .bind(email, phone).first<{ id: number; email: string; phone: string }>();
    if (!participant) return jsonResponse(request, { success: false, message: 'No registration matches this email and phone number.' }, 401);
    const token = (crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', ''), now = Math.floor(Date.now() / 1000);
    await env.gitanushilanam_db.batch([
        env.gitanushilanam_db.prepare('DELETE FROM participant_submission_sessions WHERE expires_at <= ?').bind(now),
        env.gitanushilanam_db.prepare('INSERT INTO participant_submission_sessions (session_hash, registration_id, email, phone, expires_at) VALUES (?, ?, ?, ?, ?)')
            .bind(await submissionHash(token), participant.id, participant.email, participant.phone, now + SESSION_SECONDS)
    ]);
    return jsonResponse(request, { success: true, session_token: token, expires_at: now + SESSION_SECONDS });
}
export async function participantSubmissionLogout(request: Request, env: Env): Promise<Response> {
    const token = bearer(request);
    if (token) await env.gitanushilanam_db.prepare('DELETE FROM participant_submission_sessions WHERE session_hash = ?').bind(await submissionHash(token)).run();
    return jsonResponse(request, { success: true });
}
