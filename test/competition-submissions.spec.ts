import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { closesAt, driveFileLink } from '../src/submission-support';

const migrations = import.meta.glob('../migrations/*.sql', { eager: true, query: '?raw', import: 'default' });
const db = env.gitanushilanam_db, origin = 'https://gitanushilanam.net';
const testEnv = { ...env, TURNSTILE_SECRET_KEY: 'test', RESEND_API_KEY: 'test' };
const shloka = 'shloka_recitation', reel = 'animated_bg_video';
const video1 = 'https://drive.google.com/file/d/firstVideo12345/view', video2 = 'https://drive.google.com/file/d/secondVideo12345/view';
function api(path: string, method = 'GET', data?: unknown, token?: string, requestOrigin = origin) {
    return worker.fetch(new Request('https://example.com' + path, { method, headers: { Origin: requestOrigin,
        ...(data ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        ...(data ? { body: JSON.stringify(data) } : {}) }), testEnv);
}
async function seed(id = 1, phone = '+919876543210', email = 'participant@example.com', events = [1, 1, 1, 1]) {
    await db.prepare(`INSERT INTO registrations (id,name,email,phone,whatsapp,age,country,state,city,participant_group,gender,
        bhagavad_gita_quiz,shloka_recitation,animated_bg_video,treasure_hunt) VALUES (?,?,?,?,?,25,'India','Odisha','Puri','youth_adult','other',?,?,?,?)`)
        .bind(id, 'Participant '+id, email, phone, phone, ...events).run();
}
async function login(email = 'participant@example.com', phone = '+919876543210', token = 'valid') {
    return api('/api/participant-submissions/login', 'POST', { email, phone, turnstile_token: token });
}
async function session(email?: string, phone?: string) {
    const response = await login(email, phone); expect(response.status).toBe(200);
    return (await response.json<{ session_token: string }>()).session_token;
}
function change(token: string, competition = shloka, expected_revision = 0, link: string | null = video1, request_id = crypto.randomUUID(), extra = {}) {
    return api('/api/participant-submissions/'+competition,'POST',{ action: link === null ? 'remove' : 'save', link, expected_revision, request_id, ...extra },token);
}
async function admin(role = 'super_admin') {
    const token = 'a'.repeat(43), hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('base64url');
    await db.prepare("INSERT INTO admin_accesslist (id,email,name,role,active) VALUES (1,'admin@example.com','Admin',?,1)").bind(role).run();
    await db.prepare('INSERT INTO admin_sessions (admin_id,session_hash,expires_at) VALUES (1,?,?)').bind(hash,Math.floor(Date.now()/1000)+3600).run();
    return token;
}
beforeAll(async () => {
    for (const name of Object.keys(migrations).sort()) {
        const sql = String(migrations[name]).replace(/--.*$/gmu, '');
        for (const part of sql.split(/;(?!\s*END\b)/iu)) if (part.trim()) await db.prepare(part).run();
    }
});
beforeEach(async () => {
    vi.restoreAllMocks();
    for (const table of ['registrations','participant_submission_attempts','admin_sessions','admin_login_history','admin_audit_log','admin_accesslist']) await db.prepare(`DELETE FROM ${table}`).run();
    vi.spyOn(globalThis,'fetch').mockImplementation(async (input, init) => {
        if (!String(input).includes('turnstile/v0/siteverify')) throw new Error('Unexpected external call');
        const payload = JSON.parse(String(init?.body));
        return Response.json({ success: payload.response !== 'bad', hostname: 'gitanushilanam.net', action: payload.response === 'wrong-action' ? 'mentor_login' : 'participant_submission_login' });
    });
    await seed();
});

describe('Participant submission login', () => {
    it('matches registered email and international phone, returns all selected competitions and restores a session', async () => {
        const token = await session(' PARTICIPANT@EXAMPLE.COM ', '+91 98765 43210');
        const result = await (await api('/api/participant-submissions','GET',undefined,token)).json<any>();
        expect(result.competitions.map((c:any)=>c.key)).toEqual(['bhagavad_gita_quiz',shloka,reel,'treasure_hunt']);
        expect(result.competitions.filter((c:any)=>c.accepts_links).map((c:any)=>c.key)).toEqual([shloka,reel]);
        expect(await db.prepare('SELECT session_hash FROM participant_submission_sessions').first<string>('session_hash')).not.toBe(token);
        await seed(2,'+14155552671','us@example.com',[0,1,0,0]);
        const us = await session('us@example.com','+1 415 555 2671');
        const single = await (await api('/api/participant-submissions','GET',undefined,us)).json<any>();
        expect(single.competitions.map((c:any)=>c.key)).toEqual([shloka]);
    });
    it('rejects wrong credentials, failed Turnstile and wrong widget action', async () => {
        expect((await login('other@example.com')).status).toBe(401);
        expect((await login(undefined,undefined,'bad')).status).toBe(403);
        expect((await login(undefined,undefined,'wrong-action')).status).toBe(403);
        expect((await login(undefined,'9876543210')).status).toBe(400);
    });
    it('limits repeated login attempts', async () => {
        for (let i=0;i<15;i++) expect((await login(undefined,undefined,'bad')).status).toBe(403);
        expect((await login()).status).toBe(429);
    });
    it('expires sessions, logs out and invalidates access after contact details change', async () => {
        const token = await session();
        await api('/api/participant-submissions/logout','POST',undefined,token);
        expect((await api('/api/participant-submissions','GET',undefined,token)).status).toBe(401);
        const second = await session();
        await db.prepare('UPDATE participant_submission_sessions SET expires_at=0').run();
        expect((await change(second)).status).toBe(401);
        const third = await session();
        await db.prepare("UPDATE registrations SET phone='+919123456789' WHERE id=1").run();
        expect((await change(third)).status).toBe(401);
    });
    it('blocks foreign origins and unauthenticated changes', async () => {
        expect((await change('f'.repeat(64))).status).toBe(401);
        expect((await api('/api/participant-submissions/login','POST',{},undefined,'https://other.example')).status).toBe(403);
    });
    it('shows quiz-only institute registration without submission access', async () => {
        await db.prepare("UPDATE registrations SET registration_type='institute',institute_school_key='school',shloka_recitation=0,animated_bg_video=0,treasure_hunt=0 WHERE id=1").run();
        const token = await session();
        const result=await (await api('/api/participant-submissions','GET',undefined,token)).json<any>();
        expect(result.competitions).toHaveLength(1); expect(result.competitions[0].accepts_links).toBe(false);
        expect((await change(token)).status).toBe(403);
    });
});
describe('Saving and replacing competition links', () => {
    it('keeps one link per competition with independent revisions', async () => {
        const token=await session();
        expect((await change(token)).status).toBe(200);
        expect((await change(token,reel,0,video2)).status).toBe(200);
        expect(await db.prepare('SELECT COUNT(*) AS n FROM competition_submissions').first<number>('n')).toBe(2);
        const result=await (await change(token,shloka,1,video2)).json<any>();
        expect(result.submission).toMatchObject({link:video2,revision:2});
        expect(await db.prepare("SELECT previous_link,link FROM competition_submission_history WHERE competition=? AND revision=2").bind(shloka).first()).toEqual({previous_link:video1,link:video2});
    });
    it('retains the old link on validation failure and rejects unsupported links', async () => {
        const token=await session(); await change(token);
        expect((await change(token,shloka,1,'javascript:alert(1)')).status).toBe(400);
        expect(await db.prepare('SELECT link FROM competition_submissions').first<string>('link')).toBe(video1);
        expect(await db.prepare('SELECT COUNT(*) AS n FROM competition_submission_history').first<number>('n')).toBe(1);
    });
    it.each(['http://drive.google.com/file/d/firstVideo12345/view','https://drive.google.com.evil.example/file/d/firstVideo12345/view',
        'https://drive.google.com/drive/folders/firstVideo12345','https://user@drive.google.com/file/d/firstVideo12345/view','https://example.com/video'])('rejects invalid file link %s',link=>{
        expect(()=>driveFileLink(link)).toThrow();
    });
    it('normalizes Drive share links while retaining resource keys',()=>{
        expect(driveFileLink('https://drive.google.com/open?id=firstVideo12345&usp=sharing&resourcekey=0-abc')).toBe(video1+'?resourcekey=0-abc');
    });
    it('records withdrawal, preserves history and allows a later replacement', async () => {
        const token=await session();await change(token);
        expect(await (await change(token,shloka,1,null)).json()).toMatchObject({submission:{link:null,revision:2}});
        expect(await (await change(token,shloka,2,video2)).json()).toMatchObject({submission:{link:video2,revision:3}});
        expect(await db.prepare("SELECT action,previous_link FROM competition_submission_history WHERE revision=2").first()).toEqual({action:'remove',previous_link:video1});
    });
    it('rejects removal of a nonexistent submission', async () => {
        expect((await change(await session(),shloka,0,null)).status).toBe(409);
        expect(await db.prepare('SELECT COUNT(*) AS n FROM competition_submissions').first<number>('n')).toBe(0);
    });
    it('deduplicates concurrent retries and does not duplicate history', async () => {
        const token=await session(), key=crypto.randomUUID();
        expect((await Promise.all([change(token,shloka,0,video1,key),change(token,shloka,0,video1,key)])).map(r=>r.status)).toEqual([200,200]);
        expect(await db.prepare('SELECT COUNT(*) AS n FROM competition_submission_history').first<number>('n')).toBe(1);
        expect((await change(token,shloka,0,video2,key)).status).toBe(409);
    });
    it('allows only one concurrent new submission and rejects a stale tab', async () => {
        const token=await session();
        const results=await Promise.all([change(token),change(token,shloka,0,video2)]);
        expect(results.map(r=>r.status).sort()).toEqual([200,409]);
        expect((await change(token,shloka,0,video2)).status).toBe(409);
    });
    it('does not resurrect an old link when an earlier request is retried', async () => {
        const token=await session(), key=crypto.randomUUID();await change(token,shloka,0,video1,key);await change(token,shloka,1,video2);
        const result=await (await change(token,shloka,0,video1,key)).json<any>();
        expect(result.already_saved).toBe(true);expect(result.submission.link).toBe(video2);expect(result.applied_revision).toBe(1);
    });
    it('rolls back the current link if history cannot be written', async () => {
        const token=await session();await change(token);
        await db.prepare("CREATE TRIGGER fail_submission_history BEFORE INSERT ON competition_submission_history BEGIN SELECT RAISE(ABORT,'test failure'); END").run();
        try {
            expect((await change(token,shloka,1,video2)).status).toBe(503);
            expect(await db.prepare('SELECT link FROM competition_submissions').first<string>('link')).toBe(video1);
        } finally { await db.prepare('DROP TRIGGER fail_submission_history').run(); }
    });
    it('uses the logged-in identity and prevents cross-account access and retries', async () => {
        const token=await session(), key=crypto.randomUUID();await seed(2,'+919123456789','two@example.com');
        await change(token,shloka,0,video1,key,{registration_id:2});
        expect(await db.prepare('SELECT registration_id FROM competition_submissions').first<number>('registration_id')).toBe(1);
        const other=await session('two@example.com','+919123456789');
        expect((await change(other,shloka,0,video1,key)).status).toBe(409);
        const result=await (await api('/api/participant-submissions','GET',undefined,other)).json<any>();
        expect(result.competitions.every((c:any)=>!c.submission)).toBe(true);
    });
    it('does not share retry identifiers between concurrent accounts', async () => {
        await seed(2,'+919123456789','two@example.com');
        const first=await session(),second=await session('two@example.com','+919123456789'),key=crypto.randomUUID();
        const responses=await Promise.all([change(first,shloka,0,video1,key),change(second,shloka,0,video2,key)]);
        expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
        expect(await db.prepare('SELECT COUNT(*) AS n FROM competition_submissions').first<number>('n')).toBe(1);
    });
    it('checks current competition eligibility and defers Treasure Hunt', async () => {
        const token=await session();await db.prepare('UPDATE registrations SET shloka_recitation=0 WHERE id=1').run();
        expect((await change(token)).status).toBe(403);
        expect((await change(token,'treasure_hunt')).status).toBe(400);
        expect((await change(token,'bhagavad_gita_quiz')).status).toBe(400);
    });
    it.each([shloka,reel])('locks saves and removals at the exact deadline for %s, while allowing retry recovery and viewing', async competition=>{
        const end=closesAt(competition as any);vi.spyOn(Date,'now').mockReturnValue(end-1);
        const token=await session(),key=crypto.randomUUID();expect((await change(token,competition,0,video1,key)).status).toBe(200);
        vi.spyOn(Date,'now').mockReturnValue(end);
        expect((await change(token,competition,1,video2)).status).toBe(410);
        expect((await change(token,competition,1,null)).status).toBe(410);
        expect((await change(token,competition,0,video1,key)).status).toBe(200);
        expect((await api('/api/participant-submissions','GET',undefined,token)).status).toBe(200);
    });
    it('remains independent of the registration closing date',async()=>{
        const token=await session();
        const response=await worker.fetch(new Request('https://example.com/api/participant-submissions/'+shloka,{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({action:'save',link:video1,expected_revision:0,request_id:crypto.randomUUID()})}),{...testEnv,REGISTRATION_DEADLINE:'2000-01-01T00:00:00Z'});
        expect(response.status).toBe(200);
    });
});
describe('Admin submission review',()=>{
    it('includes missing submissions, registration flags, totals and group/status filters',async()=>{
        await seed(2,'+919123456789','two@example.com',[1,1,0,0]);
        await change(await session());const token=await admin();
        const result=await (await api('/admin/api/submissions','GET',undefined,token)).json<any>();
        expect(result.total).toBe(2);expect(result.counts).toEqual({eligible_participants:2,expected_links:3,submitted_links:1,missing_links:2});
        expect(result.participants.find((p:any)=>p.id===2).shloka_link).toBe(null);
        const filtered=await (await api('/admin/api/submissions?competition=shloka_recitation&status=missing&participant_group=youth_adult','GET',undefined,token)).json<any>();
        expect(filtered.participants.map((p:any)=>p.id)).toEqual([2]);
    });
    it('shows removed and replaced links in protected history',async()=>{
        const participant=await session();await change(participant);await change(participant,shloka,1,video2);await change(participant,shloka,2,null);
        const token=await admin('judge');
        const result=await (await api('/admin/api/submissions/1/shloka_recitation/history','GET',undefined,token)).json<any>();
        expect(result.history.map((row:any)=>row.action)).toEqual(['remove','save','save']);expect(result.history[0].previous_link).toBe(video2);
        expect((await api('/admin/api/submissions/1/shloka_recitation/history','GET',undefined,participant)).status).toBe(401);
        expect((await api('/admin/api/submissions','POST',{},token)).status).toBe(405);
    });
    it('rejects unsupported filters and unauthenticated review',async()=>{
        expect((await api('/admin/api/submissions')).status).toBe(401);
        const token=await admin();
        expect((await api('/admin/api/submissions?competition=bad','GET',undefined,token)).status).toBe(400);
        expect((await api('/admin/api/submissions?competition=treasure_hunt&status=missing','GET',undefined,token)).status).toBe(400);
    });
    it('keeps participant deletion compatible and removes associated sessions and links',async()=>{
        const token=await session();await change(token);
        const adminToken = await admin();
        const deleted = await api('/admin/api/registrations/1', 'DELETE', { confirmation_email: 'participant@example.com' }, adminToken);
        expect(deleted.status).toBe(200);
        for (const table of ['competition_submissions','competition_submission_history','participant_submission_sessions']) expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>('n')).toBe(0);
        expect((await api('/api/participant-submissions','GET',undefined,token)).status).toBe(401);
    });
});
