import { type Env } from "./registration-support";
import { type Mentor, mentorGroup } from "./mentor-support";
import { ADMIN_EMAIL_SENDER, ADMIN_EMAIL_REPLY_TO, renderAdminEmailHtml, sendResendBatch } from "./email";

// A persisted job key and lease prevent duplicate confirmations on refresh/concurrent retries.
export async function sendMentorConfirmation(env: Env, mentor: Mentor, jobKey: string): Promise<boolean> {
    if (!env.RESEND_API_KEY?.trim()) return false;
    const db = env.MENTORS_DB, now = Math.floor(Date.now() / 1000);
    await db.prepare("INSERT INTO mentor_confirmation_jobs (job_key, mentor_id) VALUES (?, ?) ON CONFLICT(job_key) DO NOTHING")
        .bind(jobKey, mentor.id).run();
    const job = await db.prepare("SELECT * FROM mentor_confirmation_jobs WHERE job_key = ?")
        .bind(jobKey).first<{ mentor_id: string; sent: number; first_attempt_at: number | null }>();
    if (!job || job.mentor_id !== mentor.id) return false;
    if (job.sent) return true;
    // Resend guarantees idempotency for 24 hours; older ambiguous jobs need an explicit new admin resend.
    if (job.first_attempt_at !== null && now - job.first_attempt_at >= 23 * 3600) return false;
    const claim = await db.prepare(`UPDATE mentor_confirmation_jobs SET lease_until = ?, first_attempt_at = COALESCE(first_attempt_at, ?)
        WHERE job_key = ? AND sent = 0 AND lease_until <= ?`).bind(now + 120, now, jobKey, now).run();
    if (!claim.meta.changes) return false;
    const text = `Dear ${mentor.name},\n\nYour mentor registration for Gitanushilanam 2026 Bhagavad Gita Quiz is successful.\n\nSchool registration ID: ${mentor.school_id}\nSchool: ${mentor.school_name}\nDesignation: ${mentor.designation}\nLocation: ${mentor.place}, ${mentor.district}, ${mentor.state}\nSchool strength: ${mentor.total_strength}\nWilling participants: ${mentor.willing_count}\n\nMentor login email: ${mentor.email}\nMentor login phone: ${mentor.phone}\n\nUse Mentor Login here to download the template and upload your completed workbook:\nhttps://gitanushilanam.net/mentor-registration.html#login\n\nJoin the mentor WhatsApp group:\n${mentorGroup(env)}\n\nUploading a workbook does not register students immediately. Student registrations will be processed later.\n\nGitanushilanam Team`;
    try {
        await sendResendBatch(env.RESEND_API_KEY, jobKey, [{ from: ADMIN_EMAIL_SENDER, to: [mentor.email], reply_to: ADMIN_EMAIL_REPLY_TO,
            subject: `Mentor registration confirmed · School ID ${mentor.school_id}`, text, html: renderAdminEmailHtml(text),
            tags: [{ name: "type", value: "mentor_confirmation" }] }]);
        await db.batch([
            db.prepare("UPDATE mentor_confirmation_jobs SET sent = 1, lease_until = 0 WHERE job_key = ?").bind(jobKey),
            db.prepare("UPDATE mentors SET email_sent_at = ? WHERE id = ?").bind(new Date().toISOString(), mentor.id)
        ]);
        return true;
    } catch (error) {
        console.error("Mentor confirmation could not be sent:", error instanceof Error ? error.message : "email error");
        await db.prepare("UPDATE mentor_confirmation_jobs SET lease_until = 0 WHERE job_key = ? AND lease_until = ?")
            .bind(jobKey, now + 120).run();
        return false;
    }
}
