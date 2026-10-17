const RESEND_BATCH_URL = "https://api.resend.com/emails/batch";

export const ADMIN_EMAIL_MAX_RECIPIENTS = 100;
export const ADMIN_EMAIL_SENDER = "Gitanushilanam <support@gitanushilanam.net>";
export const ADMIN_EMAIL_REPLY_TO = "support@gitanushilanam.net";
export const ADMIN_EMAIL_LOGO_URL =
    "https://manideepdonkena.github.io/gitanushilanam_html/assets/gitanushilanam_assets/img/lglglogo.png";

const participantGroupLabels: Record<string, string> = {
    sub_junior: "Sub-Junior (Class 3–5)",
    junior: "Junior (Class 6–8)",
    senior: "Senior (Class 9–12)",
    youth_adult: "Youth / Adult (College / Adult)"
};

const competitionDefinitions = [
    {
        flag: "bhagavad_gita_quiz",
        link: "bhagavad_gita_quiz_link",
        label: "Bhagavad Gita Quiz"
    },
    {
        flag: "shloka_recitation",
        link: "shloka_recitation_link",
        label: "Shloka Recitation"
    },
    {
        flag: "animated_bg_video",
        link: "animated_bg_video_link",
        label: "Gita Reel Making Challenge"
    },
    {
        flag: "treasure_hunt",
        link: "treasure_hunt_link",
        label: "Treasure Hunt"
    }
] as const;

export const ADMIN_EMAIL_PLACEHOLDERS = [
    "name",
    "email",
    "phone",
    "whatsapp",
    "age",
    "participant_group",
    "institution",
    "location",
    "competitions",
    "whatsapp_links"
] as const;

type AdminEmailPlaceholder = typeof ADMIN_EMAIL_PLACEHOLDERS[number];

export interface AdminEmailParticipant {
    id: number;
    name: string;
    email: string;
    phone: string;
    whatsapp: string;
    age: number;
    participant_group: string | null;
    institution_organization: string | null;
    country: string | null;
    state: string | null;
    city: string | null;
    bhagavad_gita_quiz: number;
    shloka_recitation: number;
    animated_bg_video: number;
    treasure_hunt: number;
    bhagavad_gita_quiz_link: string | null;
    shloka_recitation_link: string | null;
    animated_bg_video_link: string | null;
    treasure_hunt_link: string | null;
}

export interface ResendBatchEmail {
    from: string;
    to: string[];
    reply_to: string;
    subject: string;
    text: string;
    html: string;
    tags: Array<{ name: string; value: string }>;
}

export class ResendApiError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = "ResendApiError";
        this.status = status;
    }
}

function getSelectedCompetitions(participant: AdminEmailParticipant) {
    return competitionDefinitions.filter(definition => Number(participant[definition.flag]) === 1);
}

function getTemplateValues(
    participant: AdminEmailParticipant
): Record<AdminEmailPlaceholder, string> {
    const competitions = getSelectedCompetitions(participant);
    const competitionList = competitions.length > 0
        ? competitions.map(competition => `• ${competition.label}`).join("\n")
        : "No competition selected";

    const whatsappLinks = competitions.length > 0
        ? competitions.map(competition => {
            const link = participant[competition.link];
            return link
                ? `• ${competition.label}: ${link}`
                : `• ${competition.label}: Link will be communicated soon`;
        }).join("\n")
        : "No WhatsApp group link available";

    const location = [participant.city, participant.state, participant.country]
        .filter(value => Boolean(value?.trim()))
        .join(", ");

    return {
        name: participant.name,
        email: participant.email,
        phone: participant.phone,
        whatsapp: participant.whatsapp,
        age: String(participant.age),
        participant_group: participantGroupLabels[participant.participant_group ?? ""]
            ?? "Not assigned",
        institution: participant.institution_organization?.trim() || "Not provided",
        location: location || "Not provided",
        competitions: competitionList,
        whatsapp_links: whatsappLinks
    };
}

export function findUnknownPlaceholders(...templates: string[]): string[] {
    const allowed = new Set<string>(ADMIN_EMAIL_PLACEHOLDERS);
    const unknown = new Set<string>();
    const placeholderPattern = /\{\{\s*([a-z_]+)\s*\}\}/giu;

    for (const template of templates) {
        for (const match of template.matchAll(placeholderPattern)) {
            const name = match[1].toLowerCase();

            if (!allowed.has(name)) {
                unknown.add(name);
            }
        }
    }

    return [...unknown].sort();
}

export function renderParticipantTemplate(
    template: string,
    participant: AdminEmailParticipant
): string {
    const values = getTemplateValues(participant);

    return template.replace(
        /\{\{\s*([a-z_]+)\s*\}\}/giu,
        (original, rawName: string) => {
            const name = rawName.toLowerCase() as AdminEmailPlaceholder;
            return values[name] ?? original;
        }
    );
}

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function textToSafeHtml(value: string): string {
    const urlPattern = /https:\/\/[^\s<>]+/gu;
    let result = "";
    let lastIndex = 0;

    for (const match of value.matchAll(urlPattern)) {
        const url = match[0];
        const index = match.index ?? 0;
        result += escapeHtml(value.slice(lastIndex, index));
        result += `<a href="${escapeHtml(url)}" style="color:#315efb;">${escapeHtml(url)}</a>`;
        lastIndex = index + url.length;
    }

    result += escapeHtml(value.slice(lastIndex));
    return result.replaceAll("\n", "<br>");
}

export function renderAdminEmailHtml(renderedMessage: string): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gitanushilanam 2026</title>
</head>
<body style="margin:0;padding:24px;background:#f5f7fb;color:#1f2937;font-family:Arial,sans-serif;">
  <div style="max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:14px;background:#ffffff;overflow:hidden;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#fff7ed;border-bottom:1px solid #fed7aa;">
      <tr>
        <td width="88" style="padding:16px 0 16px 24px;vertical-align:middle;">
          <img src="${ADMIN_EMAIL_LOGO_URL}" width="64" height="64" alt="Gitanushilanam" style="display:block;width:64px;height:64px;object-fit:contain;border:0;">
        </td>
        <td style="padding:16px 24px 16px 12px;vertical-align:middle;">
          <div style="font-size:19px;font-weight:700;line-height:1.3;color:#9a3412;">Gitanushilanam 2026</div>
          <div style="margin-top:4px;font-size:13px;line-height:1.4;color:#7c2d12;">Learn the Gita Live its Wisdom</div>
        </td>
      </tr>
    </table>
    <div style="padding:26px 24px;font-size:15px;line-height:1.7;">
      ${textToSafeHtml(renderedMessage)}
    </div>
    <div style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px;line-height:1.5;">
      You are receiving this message about your Gitanushilanam registration. Reply to this email if you need assistance.
    </div>
  </div>
</body>
</html>`;
}

export function buildResendBatchEmail(
    participant: AdminEmailParticipant,
    subjectTemplate: string,
    messageTemplate: string
): ResendBatchEmail {
    const subject = renderParticipantTemplate(subjectTemplate, participant)
        .replace(/\s+/gu, " ")
        .trim();
    const text = renderParticipantTemplate(messageTemplate, participant).trim();

    return {
        from: ADMIN_EMAIL_SENDER,
        to: [participant.email],
        reply_to: ADMIN_EMAIL_REPLY_TO,
        subject,
        text,
        html: renderAdminEmailHtml(text),
        tags: [
            { name: "source", value: "admin" },
            { name: "registration_id", value: String(participant.id) }
        ]
    };
}

function getResendErrorMessage(data: unknown): string {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return "Resend rejected the email request.";
    }

    const message = (data as Record<string, unknown>).message;
    return typeof message === "string" && message.trim()
        ? message.trim()
        : "Resend rejected the email request.";
}

export async function sendResendBatch(
    apiKey: string,
    requestId: string,
    emails: ResendBatchEmail[],
    fetcher: typeof fetch = fetch
): Promise<string[]> {
    let response: Response;

    try {
        response = await fetcher(RESEND_BATCH_URL, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "Idempotency-Key": `admin-email-${requestId}`
            },
            body: JSON.stringify(emails)
        });
    } catch {
        throw new ResendApiError("Unable to connect to the email service.", 502);
    }

    let data: unknown = null;

    try {
        data = await response.json();
    } catch {
        // The status code still provides a useful failure category.
    }

    if (!response.ok) {
        throw new ResendApiError(getResendErrorMessage(data), response.status);
    }

    if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new ResendApiError("The email service returned an invalid response.", 502);
    }

    const entries = (data as Record<string, unknown>).data;

    if (!Array.isArray(entries) || entries.length !== emails.length) {
        throw new ResendApiError("The email service returned an incomplete response.", 502);
    }

    const emailIds = entries.map(entry => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            throw new ResendApiError("The email service returned an invalid email ID.", 502);
        }

        const id = (entry as Record<string, unknown>).id;

        if (typeof id !== "string" || !id.trim()) {
            throw new ResendApiError("The email service returned an invalid email ID.", 502);
        }

        return id;
    });

    return emailIds;
}
