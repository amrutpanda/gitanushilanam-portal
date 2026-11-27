import { type Env, ValidationError, jsonResponse, allowedParticipantGroups } from './registration-support';
import { competitionNames, readCompetition } from './submission-support';

const joined = `FROM registrations r
    LEFT JOIN competition_submissions s ON s.registration_id = r.id AND s.competition = 'shloka_recitation'
    LEFT JOIN competition_submissions v ON v.registration_id = r.id AND v.competition = 'animated_bg_video'`;
const eligibleShloka = "(r.registration_type = 'individual' AND r.shloka_recitation = 1)";
const eligibleReel = "(r.registration_type = 'individual' AND r.animated_bg_video = 1)";
function pageNumber(url: URL): number {
    const value = url.searchParams.get('page') || '1';
    if (!/^[1-9]\d{0,5}$/u.test(value)) throw new ValidationError('Invalid page number.');
    return Number(value);
}
export async function listCompetitionSubmissions(request: Request, env: Env, url: URL): Promise<Response> {
    const search = (url.searchParams.get('search') || '').trim(), competition = url.searchParams.get('competition') || '';
    const group = url.searchParams.get('participant_group') || '', status = url.searchParams.get('status') || '';
    const page = pageNumber(url), size = 30;
    if (search.length > 200 || (competition && !Object.hasOwn(competitionNames, competition)) ||
        (group && !allowedParticipantGroups.includes(group)) || !['', 'submitted', 'missing', 'removed'].includes(status)) throw new ValidationError('Invalid submission filter.');
    if (status && ['bhagavad_gita_quiz', 'treasure_hunt'].includes(competition)) throw new ValidationError('Submission status applies only to Shloka and Reel.');
    const conditions: string[] = [], values: (string | number)[] = [];
    if (search) { conditions.push("instr(lower(r.name || ' ' || r.email || ' ' || r.phone), lower(?)) > 0"); values.push(search); }
    if (competition) conditions.push(`r.${competition} = 1`); // Validated against the fixed competition map.
    if (group) { conditions.push('r.participant_group = ?'); values.push(group); }
    if (status) {
        const check = (alias: string) => status === 'submitted' ? `${alias}.link IS NOT NULL` :
            status === 'removed' ? `${alias}.revision IS NOT NULL AND ${alias}.link IS NULL` : `${alias}.link IS NULL`;
        const rules = [];
        if (competition !== 'animated_bg_video') rules.push(`(${eligibleShloka} AND ${check('s')})`);
        if (competition !== 'shloka_recitation') rules.push(`(${eligibleReel} AND ${check('v')})`);
        conditions.push(`(${rules.join(' OR ')})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const db = env.gitanushilanam_db;
    const results = await db.batch<Record<string, unknown>>([
        db.prepare(`SELECT r.id, r.name, r.email, r.phone, r.participant_group, r.registration_type,
            r.bhagavad_gita_quiz, r.shloka_recitation, r.animated_bg_video, r.treasure_hunt,
            s.link AS shloka_link, s.revision AS shloka_revision, s.first_submitted_at AS shloka_first_submitted_at, s.updated_at AS shloka_updated_at,
            v.link AS reel_link, v.revision AS reel_revision, v.first_submitted_at AS reel_first_submitted_at, v.updated_at AS reel_updated_at
            ${joined} ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`).bind(...values, size, (page - 1) * size),
        db.prepare(`SELECT COUNT(*) AS count ${joined} ${where}`).bind(...values),
        db.prepare(`SELECT
            COALESCE(SUM(CASE WHEN ${eligibleShloka} OR ${eligibleReel} THEN 1 ELSE 0 END),0) AS eligible_participants,
            COALESCE(SUM(CASE WHEN ${eligibleShloka} THEN 1 ELSE 0 END + CASE WHEN ${eligibleReel} THEN 1 ELSE 0 END),0) AS expected_links,
            COALESCE(SUM(CASE WHEN ${eligibleShloka} AND s.link IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN ${eligibleReel} AND v.link IS NOT NULL THEN 1 ELSE 0 END),0) AS submitted_links
            ${joined}`)
    ]);
    const total = Number(results[1].results[0].count), counts = results[2].results[0];
    return jsonResponse(request, { success: true, participants: results[0].results, total, page, total_pages: Math.max(1, Math.ceil(total / size)),
        counts: { ...counts, missing_links: Number(counts.expected_links) - Number(counts.submitted_links) } });
}
export async function submissionHistory(request: Request, env: Env, url: URL, registrationId: string, competitionText: string): Promise<Response> {
    const competition = readCompetition(competitionText), page = pageNumber(url), id = Number(registrationId);
    if (!Number.isSafeInteger(id) || id < 1) throw new ValidationError('Invalid participant.');
    const db = env.gitanushilanam_db;
    const participant = await db.prepare('SELECT id, name FROM registrations WHERE id = ?').bind(id).first();
    if (!participant) return jsonResponse(request, { success: false, message: 'Participant not found.' }, 404);
    const result = await db.batch<Record<string, unknown>>([
        db.prepare(`SELECT revision, action, link, previous_link, changed_at FROM competition_submission_history
            WHERE registration_id = ? AND competition = ? ORDER BY revision DESC LIMIT 30 OFFSET ?`).bind(id, competition, (page - 1) * 30),
        db.prepare('SELECT COUNT(*) AS count FROM competition_submission_history WHERE registration_id = ? AND competition = ?').bind(id, competition)
    ]);
    const total = Number(result[1].results[0].count);
    return jsonResponse(request, { success: true, participant, competition, history: result[0].results, page, total_pages: Math.max(1, Math.ceil(total / 30)) });
}
