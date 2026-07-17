/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";

export const EMAIL_FONT_SANS =
  "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const EMAIL_FONT_SERIF = "Merriweather, Georgia, 'Times New Roman', serif";

// The shared chrome for every Scorecard email: background, 560px card, brand
// header, serif heading, pill CTA button, and footer note. Templates supply
// only content; extra rows (e.g. the sign-in code) render between the body
// copy and the CTA via children.
export function EmailLayout(props: {
  title: string;
  body: string;
  cta: { href: string; label: string };
  footer: string;
  children?: Child;
}) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
      </head>
      <body
        style={`margin:0; padding:0; background-color:#f5f7f6; color:#17211b; font-family:${EMAIL_FONT_SANS};`}
      >
        <table
          role="presentation"
          width="100%"
          cellspacing="0"
          cellpadding="0"
          border={0}
          style="width:100%; border-collapse:collapse; background-color:#f5f7f6;"
        >
          <tr>
            <td align="center" style="padding:32px 16px;">
              <table
                role="presentation"
                width="100%"
                cellspacing="0"
                cellpadding="0"
                border={0}
                style="width:100%; max-width:560px; border-collapse:collapse; background-color:#ffffff; border:1px solid #dce5df; border-radius:12px;"
              >
                <tr>
                  <td style="padding:32px 32px 8px;">
                    <p style="margin:0; color:#008236; font-size:18px; font-weight:700; letter-spacing:-0.2px;">
                      Scorecard
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:24px 32px 8px;">
                    <h1
                      style={`margin:0; color:#17211b; font-family:${EMAIL_FONT_SERIF}; font-size:26px; font-weight:700; line-height:1.25;`}
                    >
                      {props.title}
                    </h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 32px 24px;">
                    <p style="margin:0; color:#526158; font-size:16px; line-height:1.5;">
                      {props.body}
                    </p>
                  </td>
                </tr>
                {props.children}
                <tr>
                  <td align="left" style="padding:0 32px 32px;">
                    <table
                      role="presentation"
                      cellspacing="0"
                      cellpadding="0"
                      border={0}
                      style="border-collapse:collapse;"
                    >
                      <tr>
                        <td align="center" bgcolor="#008236" style="border-radius:9999px;">
                          <a
                            href={props.cta.href}
                            style="display:inline-block; padding:14px 20px; color:#f0fdf4; font-size:16px; font-weight:700; line-height:1; text-decoration:none; border-radius:9999px;"
                          >
                            {props.cta.label}
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:20px 32px 32px; border-top:1px solid #e7ede9;">
                    <p style="margin:0; color:#718075; font-size:13px; line-height:1.5;">
                      {props.footer}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  );
}

// Our email components are all synchronous, so the JSX renders to a string
// immediately; only the doctype can't be expressed as JSX.
export function renderEmailHtml(element: { toString(): string }) {
  return `<!doctype html>\n${element.toString()}`;
}
