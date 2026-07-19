/** @jsxImportSource hono/jsx */
import { EmailLayout, renderEmailHtml } from "../layout";

// The enroll email for both flows: "invite" (an admin created your account) and
// "recovery" (you asked for a sign-in link because you have no passkey on this
// device / lost your device). Both link to /enroll?token=…, where the recipient
// sets up a passkey and is signed straight in.
export function enrollEmail(enrollUrl: URL, variant: "invite" | "recovery") {
  const copy =
    variant === "invite"
      ? {
          title: "You're invited to Scorecard",
          body: "An admin created an account for you. Tap below to set up a passkey on this device and sign in.",
          text: "An admin created a Scorecard account for you. Set up a passkey and sign in here",
        }
      : {
          title: "Sign in to Scorecard",
          body: "Tap below to set up a passkey on this device and sign in. Use this whenever you're on a new device or have lost access to an old one.",
          text: "Set up a passkey on this device and sign in to Scorecard here",
        };

  return {
    html: renderEmailHtml(
      <EmailLayout
        title={copy.title}
        body={copy.body}
        cta={{ href: enrollUrl.toString(), label: "Set up your passkey" }}
        footer="If you weren't expecting this email, you can safely ignore it."
      />,
    ),
    text: `${copy.text}: ${enrollUrl.toString()}\n\nIf you weren't expecting this email, you can safely ignore it.`,
  };
}
