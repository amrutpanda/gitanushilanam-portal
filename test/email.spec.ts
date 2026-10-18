import { describe, expect, it, vi } from "vitest";
import {
    ADMIN_EMAIL_LOGO_URL,
    type AdminEmailParticipant,
    buildRegistrationConfirmationEmail,
    buildResendBatchEmail,
    findUnknownPlaceholders,
    renderAdminEmailHtml,
    renderParticipantTemplate,
    ResendApiError,
    sendResendBatch
} from "../src/email";

const participant: AdminEmailParticipant = {
    id: 42,
    name: "Ananya <Test>",
    email: "ananya@example.com",
    phone: "+919876543210",
    whatsapp: "+919876543210",
    age: 14,
    participant_group: "senior",
    institution_organization: "Gita School",
    country: "India",
    state: "Odisha",
    city: "Puri",
    bhagavad_gita_quiz: 1,
    shloka_recitation: 1,
    animated_bg_video: 0,
    treasure_hunt: 0,
    bhagavad_gita_quiz_link: "https://chat.whatsapp.com/quiz",
    shloka_recitation_link: "https://chat.whatsapp.com/shloka",
    animated_bg_video_link: "https://chat.whatsapp.com/video",
    treasure_hunt_link: "https://chat.whatsapp.com/treasure"
};

describe("admin email templates", () => {
    it("personalizes participant fields, competitions and selected WhatsApp links", () => {
        const rendered = renderParticipantTemplate(
            "Hare Krishna {{name}}\n{{participant_group}}\n{{competitions}}\n{{whatsapp_links}}",
            participant
        );

        expect(rendered).toContain("Hare Krishna Ananya <Test>");
        expect(rendered).toContain("Senior (Class 9–12)");
        expect(rendered).toContain("Bhagavad Gita Quiz");
        expect(rendered).toContain("Shloka Recitation");
        expect(rendered).toContain("https://chat.whatsapp.com/quiz");
        expect(rendered).not.toContain("https://chat.whatsapp.com/video");
    });

    it("reports unsupported placeholders before sending", () => {
        expect(findUnknownPlaceholders("Hello {{name}}", "Use {{registration_id}}"))
            .toEqual(["registration_id"]);
    });

    it("escapes participant HTML while keeping HTTPS links clickable", () => {
        const html = renderAdminEmailHtml(
            renderParticipantTemplate("Hello {{name}}\n{{whatsapp_links}}", participant)
        );

        expect(html).toContain("Ananya &lt;Test&gt;");
        expect(html).not.toContain("Ananya <Test>");
        expect(html).toContain('href="https://chat.whatsapp.com/quiz"');
        expect(html).toContain(`src="${ADMIN_EMAIL_LOGO_URL}"`);
        expect(html).toContain("Learn the Gita Live its Wisdom");
    });

    it("builds one private message addressed to the participant", () => {
        const email = buildResendBatchEmail(
            participant,
            "Announcement for {{name}}",
            "Hare Krishna {{name}}"
        );

        expect(email.to).toEqual(["ananya@example.com"]);
        expect(email.subject).toBe("Announcement for Ananya <Test>");
        expect(email.text).toBe("Hare Krishna Ananya <Test>");
        expect(email.tags).toContainEqual({ name: "registration_id", value: "42" });
    });

    it("builds a branded registration confirmation with the selected group links", () => {
        const email = buildRegistrationConfirmationEmail(participant);

        expect(email.subject).toBe("Registration confirmed — Gitanushilanam 2026");
        expect(email.text).toContain("completed successfully");
        expect(email.text).toContain("https://chat.whatsapp.com/quiz");
        expect(email.text).toContain("https://chat.whatsapp.com/shloka");
        expect(email.text).not.toContain("https://chat.whatsapp.com/video");
        expect(email.tags).toContainEqual({ name: "source", value: "registration" });
    });
});

describe("Resend batch transport", () => {
    it("uses the Resend batch endpoint and an idempotency key", async () => {
        const fetcher = vi.fn(async () => Response.json({
            data: [{ id: "email-1" }]
        }));
        const email = buildResendBatchEmail(participant, "Subject", "Message");

        await expect(sendResendBatch(
            "secret",
            "admin-email-request_12345678",
            [email],
            fetcher
        ))
            .resolves.toEqual(["email-1"]);

        expect(fetcher).toHaveBeenCalledOnce();
        const [url, options] = fetcher.mock.calls[0];
        expect(url).toBe("https://api.resend.com/emails/batch");
        expect(options?.headers).toMatchObject({
            "Authorization": "Bearer secret",
            "Idempotency-Key": "admin-email-request_12345678"
        });
    });

    it("returns a typed error when Resend rejects the batch", async () => {
        const fetcher = vi.fn(async () => Response.json(
            { message: "Rate limit exceeded" },
            { status: 429 }
        ));
        const email = buildResendBatchEmail(participant, "Subject", "Message");

        await expect(sendResendBatch(
            "secret",
            "admin-email-request_12345678",
            [email],
            fetcher
        ))
            .rejects.toEqual(expect.objectContaining<Partial<ResendApiError>>({
                status: 429,
                message: "Rate limit exceeded"
            }));
    });
});
