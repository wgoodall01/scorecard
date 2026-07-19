/** @jsxImportSource hono/jsx */
import { EmailLayout, renderEmailHtml } from "../layout";

export function inviteEmail(magicLink: URL) {
  return {
    html: renderEmailHtml(
      <EmailLayout
        title="You're invited to Scorecard"
        body="An admin created an account for you. Tap below to sign in — the link works for the next 24 hours, no code needed."
        cta={{ href: magicLink.toString(), label: "Sign in to Scorecard" }}
        footer="If you weren't expecting this invite, you can safely ignore it."
      />,
    ),
    text: `An admin created a Scorecard account for you. Sign in here (link valid for 24 hours): ${magicLink.toString()}\n\nIf you weren't expecting this invite, you can safely ignore this email.`,
  };
}
