// The Sign in with Apple return URL registered on the Services ID, for account deletion on
// Android and macOS. The app opens Apple's authorize page in the browser; Apple POSTs the
// answer here (`response_mode=form_post`) and this relays it to the app as a deep link.
// Android follows a 303; macOS gets a static page that opens the link.
//
// The code is a credential until the server redeems it: nothing here logs, reports or echoes
// a field value. Public in the middleware, because Apple's cross-site POST carries no session.
import { NextResponse, type NextRequest } from "next/server";
import {
  APPLE_RELAY_PRIVATE_HEADERS,
  appleRevocationDeepLink,
  appleRevocationRelayPageHeaders,
  readAppleRevocationRelayForm,
  renderAppleRevocationRelayPage,
} from "@/lib/apple/revocation-relay";

const INVALID_COPY =
  "This Sign in with Apple answer could not be read. Go back to Drafto and try deleting your account again.";

function invalidResponse(): Response {
  return new Response(INVALID_COPY, {
    status: 400,
    headers: { ...APPLE_RELAY_PRIVATE_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return invalidResponse();
  }

  const relay = readAppleRevocationRelayForm(form);
  if (!relay) return invalidResponse();

  const deepLink = appleRevocationDeepLink(relay);
  if (relay.platform === "android") {
    return new Response(null, {
      status: 303,
      headers: { ...APPLE_RELAY_PRIVATE_HEADERS, Location: deepLink },
    });
  }

  return new Response(renderAppleRevocationRelayPage(deepLink), {
    status: 200,
    headers: appleRevocationRelayPageHeaders(),
  });
}

/** Nothing to show without Apple's post: send a visitor to the account-deletion explainer. */
export function GET(request: NextRequest): NextResponse {
  return NextResponse.redirect(new URL("/account/delete", request.url), 303);
}
