import { ValidationError, readRequiredText } from './registration-support';

export const submissionCompetitions = {
    shloka_recitation: { name: 'Shloka Recitation', deadline: '2026-12-06T23:59:59+05:30', page: 'shloka-submission.html' },
    animated_bg_video: { name: 'Gita Reel Making', deadline: '2026-12-10T23:59:59+05:30', page: 'reel-submission.html' }
} as const;
export type SubmissionCompetition = keyof typeof submissionCompetitions;
export const competitionNames = {
    bhagavad_gita_quiz: 'Bhagavad Gita Quiz', shloka_recitation: 'Shloka Recitation',
    animated_bg_video: 'Gita Reel Making', treasure_hunt: 'Treasure Hunt'
} as const;
export interface SubmissionParticipant {
    id: number; name: string; email: string; phone: string; participant_group: string | null;
    registration_type: string; bhagavad_gita_quiz: number; shloka_recitation: number; animated_bg_video: number; treasure_hunt: number;
}
export const participantColumns = 'r.id, r.name, r.email, r.phone, r.participant_group, r.registration_type, r.bhagavad_gita_quiz, r.shloka_recitation, r.animated_bg_video, r.treasure_hunt';
export interface SubmissionRecord { competition: SubmissionCompetition; link: string | null; revision: number; first_submitted_at: string; updated_at: string }
export const submissionColumns = 'competition, link, revision, first_submitted_at, updated_at';
export function readCompetition(value: string): SubmissionCompetition {
    if (value !== 'shloka_recitation' && value !== 'animated_bg_video') throw new ValidationError('Link submissions are available only for Shloka Recitation and Gita Reel Making.');
    return value;
}
export function closesAt(competition: SubmissionCompetition): number { return Date.parse(submissionCompetitions[competition].deadline) + 1000; }
export function canSubmit(participant: SubmissionParticipant, competition: SubmissionCompetition): boolean {
    return participant.registration_type === 'individual' && participant[competition] === 1;
}
export function driveFileLink(value: unknown): string {
    const text = readRequiredText(value, 'Video link', 2048);
    let url: URL;
    try { url = new URL(text); } catch { throw new ValidationError('Paste a complete Google Drive file-sharing link.'); }
    if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com' || url.username || url.password || url.port) {
        throw new ValidationError('Use an HTTPS Google Drive file-sharing link.');
    }
    const match = url.pathname.match(/^\/file\/d\/([A-Za-z0-9_-]{10,200})(?:\/(?:view|preview|edit))?\/?$/u);
    const id = match?.[1] || (['/open', '/uc'].includes(url.pathname) ? url.searchParams.get('id') : null);
    if (!id || !/^[A-Za-z0-9_-]{10,200}$/u.test(id)) throw new ValidationError('Share the video file itself, rather than a Drive folder.');
    const canonical = new URL(`https://drive.google.com/file/d/${id}/view`);
    const resourceKey = url.searchParams.get('resourcekey');
    if (resourceKey) {
        if (!/^[A-Za-z0-9_-]{1,200}$/u.test(resourceKey)) throw new ValidationError('The Drive resource key is invalid. Please copy the sharing link again.');
        canonical.searchParams.set('resourcekey', resourceKey);
    }
    return canonical.href;
}
export async function readSubmissionJson(request: Request): Promise<Record<string, unknown>> {
    if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get('Content-Type') || '')) throw new ValidationError('Please submit the form as JSON.');
    if (!request.body) throw new ValidationError('Please complete the form.');
    const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
        while (true) {
            const { value, done } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > 16384) { await reader.cancel(); throw new ValidationError('The form is too large.'); }
            chunks.push(value);
        }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let data: unknown;
    try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ValidationError('Please submit valid JSON.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ValidationError('Please complete the form.');
    return data as Record<string, unknown>;
}
export async function submissionHash(text: string): Promise<string> {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
}
export function requestId(value: unknown): string {
    const id = readRequiredText(value, 'Request identifier', 36).toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) throw new ValidationError('Please reload the page and retry.');
    return id;
}
