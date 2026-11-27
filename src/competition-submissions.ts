import { type Env, ValidationError, jsonResponse, isAllowedOrigin } from './registration-support';
import { submissionParticipant, participantSubmissionLogin, participantSubmissionLogout } from './participant-submission-auth';
import { submissionCompetitions, competitionNames, readCompetition, closesAt, canSubmit, driveFileLink, readSubmissionJson,
    submissionHash, requestId, submissionColumns, type SubmissionParticipant, type SubmissionRecord, type SubmissionCompetition } from './submission-support';
import { listCompetitionSubmissions, submissionHistory } from './submission-admin';

type AdminAuthorizer = (request: Request, env: Env) => Promise<unknown | Response>;
function current(env: Env, participant: number, competition: SubmissionCompetition): Promise<SubmissionRecord | null> {
    return env.gitanushilanam_db.prepare(`SELECT ${submissionColumns} FROM competition_submissions WHERE registration_id = ? AND competition = ?`)
        .bind(participant, competition).first<SubmissionRecord>();
}
async function overview(request: Request, env: Env, participant: SubmissionParticipant): Promise<Response> {
    const result = await env.gitanushilanam_db.prepare(`SELECT ${submissionColumns} FROM competition_submissions WHERE registration_id = ?`).bind(participant.id).all<SubmissionRecord>();
    return jsonResponse(request, { success: true, participant: { id: participant.id, name: participant.name, email: participant.email, phone: participant.phone, participant_group: participant.participant_group },
        server_time: new Date().toISOString(), competitions: Object.entries(competitionNames).filter(([key]) => participant[key as keyof typeof competitionNames] === 1)
            .map(([key, name]) => {
                const supported = key === 'shloka_recitation' || key === 'animated_bg_video', eligible = supported && canSubmit(participant, key);
                return { key, name, accepts_links: eligible, page: eligible ? submissionCompetitions[key].page : null,
                    deadline: supported ? submissionCompetitions[key].deadline : null,
                    closed: supported ? Date.now() >= closesAt(key) : false,
                    submission: eligible ? result.results.find(row => row.competition === key) || null : null };
            }) });
}
async function save(request: Request, env: Env, participant: SubmissionParticipant, competition: SubmissionCompetition): Promise<Response> {
    if (!canSubmit(participant, competition)) return jsonResponse(request, { success: false, message: 'You are not registered for this competition.' }, 403);
    const data = await readSubmissionJson(request), key = requestId(data.request_id), revision = data.expected_revision;
    if (data.action !== 'save' && data.action !== 'remove') throw new ValidationError('Choose save or remove.');
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) throw new ValidationError('Please reload your saved submission and retry.');
    const link = data.action === 'save' ? driveFileLink(data.link) : null;
    const fingerprint = await submissionHash(JSON.stringify([participant.id, competition, revision, data.action, link]));
    const db = env.gitanushilanam_db;
    async function receipt(): Promise<Response | null> {
        const prior = await db.prepare('SELECT registration_id, request_hash, revision FROM competition_submission_history WHERE request_id = ?')
            .bind(key).first<{ registration_id: number; request_hash: string; revision: number }>();
        if (!prior) return null;
        if (prior.registration_id !== participant.id || prior.request_hash !== fingerprint) return jsonResponse(request, { success: false, message: 'This save attempt was used for different details. Reload your submission before trying again.' }, 409);
        return jsonResponse(request, { success: true, already_saved: true, applied_revision: prior.revision, submission: await current(env, participant.id, competition) });
    }
    const previous = await receipt(); if (previous) return previous;
    const deadline = closesAt(competition);
    if (Date.now() >= deadline) return jsonResponse(request, { success: false, code: 'submission_closed', message: 'The submission deadline has passed. Saved links remain available to view.' }, 410);
    const timestamp = new Date().toISOString();
    // The revision, eligibility and clock checks are part of the write. A stale tab
    // or delayed request cannot overwrite a newer entry or extend the deadline.
    let record: SubmissionRecord | null;
    try {
        record = await db.prepare(`INSERT INTO competition_submissions
            (registration_id, competition, link, revision, first_submitted_at, updated_at, request_id, request_hash)
            SELECT ?, ?, ?, 1, ?, ?, ?, ? WHERE
                ? = COALESCE((SELECT revision FROM competition_submissions WHERE registration_id = ? AND competition = ?), 0)
                AND (? = 'save' OR EXISTS (SELECT 1 FROM competition_submissions WHERE registration_id = ? AND competition = ? AND link IS NOT NULL))
                AND unixepoch('now') < ?
                AND EXISTS (SELECT 1 FROM registrations WHERE id = ? AND registration_type = 'individual' AND ${competition} = 1 AND email = ? COLLATE NOCASE AND phone = ?)
            ON CONFLICT(registration_id, competition) DO UPDATE SET
                link = excluded.link, revision = competition_submissions.revision + 1, updated_at = excluded.updated_at,
                request_id = excluded.request_id, request_hash = excluded.request_hash
            RETURNING ${submissionColumns}`)
            .bind(participant.id, competition, link, timestamp, timestamp, key, fingerprint, revision, participant.id, competition,
                data.action, participant.id, competition, deadline / 1000, participant.id, participant.email, participant.phone).first<SubmissionRecord>();
    } catch (error) {
        const retry = await receipt(); if (retry) return retry;
        throw error;
    }
    if (!record) {
        const retry = await receipt(); if (retry) return retry;
        if (Date.now() >= deadline) return jsonResponse(request, { success: false, code: 'submission_closed', message: 'The submission deadline has passed.' }, 410);
        return jsonResponse(request, { success: false, code: 'submission_conflict', message: 'Your saved submission or registration changed. Reload it before saving again.' }, 409);
    }
    return jsonResponse(request, { success: true, already_saved: false, applied_revision: record.revision, submission: record });
}
export async function handleCompetitionSubmissions(request: Request, env: Env, authorizeAdmin: AdminAuthorizer): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    try {
        if (request.method !== 'GET' && !isAllowedOrigin(request)) return jsonResponse(request, { success: false, message: 'Request origin is not allowed.' }, 403);
        if (path === '/api/participant-submissions/login' && request.method === 'POST') return await participantSubmissionLogin(request, env);
        if (path === '/api/participant-submissions/logout' && request.method === 'POST') return await participantSubmissionLogout(request, env);
        if (path.startsWith('/admin/api/submissions')) {
            const admin = await authorizeAdmin(request, env); if (admin instanceof Response) return admin;
            if (request.method !== 'GET') return jsonResponse(request, { success: false, message: 'Submission review is read-only.' }, 405);
            if (path === '/admin/api/submissions') return await listCompetitionSubmissions(request, env, url);
            const match = path.match(/^\/admin\/api\/submissions\/(\d+)\/([^/]+)\/history$/u);
            if (match) return await submissionHistory(request, env, url, match[1], match[2]);
        } else {
            const participant = await submissionParticipant(request, env);
            if (!participant) return jsonResponse(request, { success: false, message: 'Please log in with your registered email and phone number.' }, 401);
            if (path === '/api/participant-submissions' && request.method === 'GET') return await overview(request, env, participant);
            const match = path.match(/^\/api\/participant-submissions\/([^/]+)$/u);
            if (match && request.method === 'POST') return await save(request, env, participant, readCompetition(match[1]));
        }
        return jsonResponse(request, { success: false, message: 'Submission route not found.' }, 404);
    } catch (error) {
        if (error instanceof ValidationError) return jsonResponse(request, { success: false, message: error.message }, 400);
        console.error('Competition submission request failed:', error instanceof Error ? error.message : 'request error');
        return jsonResponse(request, { success: false, message: 'Unable to complete the request. Please retry; your last saved link is retained.' }, 503);
    }
}
