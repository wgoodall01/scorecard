/** @jsxImportSource hono/jsx */
import { EmailLayout, renderEmailHtml } from "../layout";

export function inviteEmail(loginLink: URL) {
  return {
    html: renderEmailHtml(
      <EmailLayout
        title="You're invited to Scorecard"
        body="An admin created an account for you. Sign in to get started."
        cta={{ href: loginLink.toString(), label: "Sign in to Scorecard" }}
        footer="If you weren't expecting this invite, you can safely ignore it."
      />,
    ),
    text: `An admin created a Scorecard account for you. Sign in here: ${loginLink.toString()}\n\nIf you weren't expecting this invite, you can safely ignore this email.`,
  };
}
