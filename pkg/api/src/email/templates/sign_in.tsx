/** @jsxImportSource hono/jsx */
import { EMAIL_FONT_SANS, EmailLayout, renderEmailHtml } from "../layout";

export function signInEmail(code: string, magicLink: URL) {
  return {
    html: renderEmailHtml(
      <EmailLayout
        title="Sign in to Scorecard"
        body="Use this one-time code to sign in. It expires in 10 minutes."
        cta={{ href: magicLink.toString(), label: "Sign in to Scorecard" }}
        footer="If you did not request this email, you can safely ignore it."
      >
        <tr>
          <td align="center" style="padding:0 32px 24px;">
            <p
              style={`margin:0; padding:14px 20px; color:#17211b; background-color:#eef7f0; border:1px solid #cce4d2; border-radius:8px; font-family:${EMAIL_FONT_SANS}; font-size:28px; font-weight:700; letter-spacing:8px; line-height:1;`}
            >
              {code}
            </p>
          </td>
        </tr>
      </EmailLayout>,
    ),
    text: `Your Scorecard sign-in code is: ${code}\n\nThis code expires in 10 minutes. If you did not request it, you can safely ignore this email.`,
  };
}
