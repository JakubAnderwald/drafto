import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import SupportPage from "@/app/support/page";
import PrivacyPolicyPage from "@/app/privacy/page";

describe("Support page", () => {
  it("describes the in-app deletion flow before the email fallback", () => {
    render(<SupportPage />);

    const heading = screen.getByRole("heading", { level: 3, name: "How do I delete my account?" });
    // The answer is every sibling after the question, up to the next question (if any).
    const answer: string[] = [];
    let el = heading.nextElementSibling;
    while (el && el.tagName !== "H3") {
      answer.push(el.textContent ?? "");
      el = el.nextElementSibling;
    }
    const text = answer.join(" ");

    expect(text).toMatch(/Web:.*Settings.*Delete account/);
    expect(text).toMatch(/iPhone, iPad and Android:.*Settings.*Delete account/);
    expect(text).toMatch(/Mac:.*⋯.*sidebar.*choose Delete account\./);
    expect(text.indexOf("Delete account")).toBeLessThan(text.indexOf("support@drafto.eu"));
    expect(text).toMatch(/within 30 days/);
  });

  it("links to the account deletion page from the answer and the footer", () => {
    render(<SupportPage />);

    expect(screen.getByRole("link", { name: "how to delete your account" })).toHaveAttribute(
      "href",
      "/account/delete",
    );
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByRole("link", { name: "Delete your account" })).toHaveAttribute(
      "href",
      "/account/delete",
    );
    expect(within(footer).getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
      "href",
      "/privacy",
    );
  });

  it("puts the contact block above the common questions", () => {
    render(<SupportPage />);

    const contact = screen.getByRole("heading", { level: 2, name: "Contact us" });
    const questions = screen.getByRole("heading", { level: 2, name: "Common questions" });
    expect(
      contact.compareDocumentPosition(questions) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const block = contact.parentElement as HTMLElement;
    expect(within(block).getByRole("link", { name: "support@drafto.eu" })).toHaveAttribute(
      "href",
      "mailto:support@drafto.eu",
    );
    expect(block).toHaveTextContent(/An AI assistant helps us sort and answer support email/);
    expect(within(block).getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
      "href",
      "/privacy",
    );
  });

  it("only points to the support@drafto.eu mailbox", () => {
    render(<SupportPage />);

    const mailtos = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"))
      .filter((href) => href?.startsWith("mailto:"));
    expect(mailtos.length).toBeGreaterThan(0);
    expect(new Set(mailtos)).toEqual(new Set(["mailto:support@drafto.eu"]));
    expect(document.body.innerHTML).not.toContain("privacy@drafto.eu");
  });
});

/** Text of an h2 section: every sibling after the heading, up to the next h2. */
function sectionText(name: RegExp): string {
  const heading = screen.getByRole("heading", { level: 2, name });
  const parts: string[] = [];
  let el = heading.nextElementSibling;
  while (el && el.tagName !== "H2") {
    parts.push(el.textContent ?? "");
    el = el.nextElementSibling;
  }
  return parts.join(" ");
}

const rowFor = (service: string) =>
  screen.getByRole("cell", { name: service }).closest("tr") as HTMLElement;

describe("Privacy policy page", () => {
  it("shows the updated date and keeps the effective date", () => {
    render(<PrivacyPolicyPage />);

    expect(screen.getByText(/Effective date: March 8, 2026/)).toHaveTextContent(
      "Last updated: October 8, 2026",
    );
  });

  it("identifies the data controller and a contact address", () => {
    render(<PrivacyPolicyPage />);

    const controller = sectionText(/Who Is Responsible for Your Data/);
    expect(controller).toMatch(/Jakub Anderwald/);
    expect(controller).toMatch(/Warsaw, Poland/);
    expect(controller).toMatch(/support@drafto\.eu/);
  });

  it("describes Google and Apple sign-in and the manual approval of new accounts", () => {
    render(<PrivacyPolicyPage />);

    const collected = sectionText(/Data We Collect/);
    expect(collected).toMatch(/Sign in with Google or Apple: no password is created/);
    expect(collected).toMatch(/Google shares your email address and basic profile/);
    expect(collected).toMatch(/Apple shares your email address, which can be a private relay/);
    expect(collected).toMatch(/new sign-ups are reviewed manually before the account is activated/);
    expect(collected).toMatch(/earlier versions of its content for 30 days/);
  });

  it("discloses Session Replay, says PostHog is not enabled, and keeps the native-apps sentence", () => {
    render(<PrivacyPolicyPage />);

    expect(screen.getByText(/Sentry Session Replay/)).toHaveTextContent(
      /about 10% of web sessions and every session in which an error occurs/,
    );
    expect(screen.getByText(/All text and form inputs are masked/)).toBeInTheDocument();
    expect(screen.getByText(/includes PostHog/)).toHaveTextContent(
      /not enabled: no PostHog key is configured, so nothing is sent to PostHog/,
    );
    expect(
      screen.getByText(
        /The iOS, Android and macOS apps contain no analytics or crash-reporting SDK/,
      ),
    ).toBeInTheDocument();
    // Nothing is collected anonymously any more, and there are no analytics to retain.
    expect(document.body.textContent).not.toMatch(/anonymous/i);
  });

  it("names every way device data reaches a third party, not just the SDKs", () => {
    render(<PrivacyPolicyPage />);

    const collected = sectionText(/Data We Collect/);
    // 100% performance tracing records request URLs: search terms and signed attachment links.
    expect(collected).toMatch(/can include what you type into search, and the file names/);
    // NetInfo's default reachability check on iOS and macOS.
    expect(collected).toMatch(/the iOS and macOS apps send a small request to a Google server/);
    expect(collected).toMatch(/Supabase, which runs our database.*including your IP address/);
    expect(rowFor("Google")).toHaveTextContent("internet connection check in the iOS and macOS");
  });

  it("gives a legal basis for each purpose", () => {
    render(<PrivacyPolicyPage />);

    const purposes = sectionText(/How We Use Your Data/);
    expect(purposes).toMatch(
      /Provide the Service:.*performance of our contract.*Art\. 6\(1\)\(b\)/,
    );
    expect(purposes).toMatch(/Fix issues and keep the Service secure:.*legitimate interest/);
    expect(purposes).toMatch(/Provide support:.*legitimate interest/);
    expect(purposes).toMatch(/not.*use your note content for advertising, training AI models/);
  });

  it("lists the processors with what each receives", () => {
    render(<PrivacyPolicyPage />);

    expect(rowFor("Supabase")).toHaveTextContent("EU, Ireland");
    expect(rowFor("Sentry")).toHaveTextContent("web app and drafto.eu servers only");
    expect(rowFor("Sentry")).toHaveTextContent("Session Replay");
    expect(rowFor("Resend")).toHaveTextContent("password reset");
    expect(rowFor("Zoho Mail")).toHaveTextContent("EU data centre");
    expect(rowFor("Anthropic")).toHaveTextContent("support email");
    expect(rowFor("GitHub")).toHaveTextContent(
      "your email address (not shown on the issue page, but readable through GitHub's API)",
    );
    expect(screen.queryByRole("cell", { name: /Expo/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("cell", { name: "PostHog" })).not.toBeInTheDocument();
  });

  it("says plainly how support email is handled by AI and published to GitHub", () => {
    render(<PrivacyPolicyPage />);

    const sharing = sectionText(/Data Sharing/);
    expect(sharing).toMatch(/AI assistant \(Claude, made by Anthropic\) reads each support email/);
    expect(sharing).toMatch(/answers many questions automatically/);
    expect(sharing).toMatch(/privacy rights are always handled by a person/);
    expect(sharing).toMatch(/public GitHub repository/);
    expect(sharing).toMatch(/The issue usually quotes your message/);
    expect(sharing).toMatch(/Any attachments you sent.*are uploaded to the same public repository/);
    expect(sharing).toMatch(/anyone can read it through GitHub's API/);
  });

  it("explains API keys and MCP access", () => {
    render(<PrivacyPolicyPage />);

    const mcp = sectionText(/API Keys and MCP/);
    expect(mcp).toMatch(/This only happens at your direction/);
    expect(mcp).toMatch(/read and write access to all of your notebooks and notes/);
    expect(mcp).toMatch(/Revoking a key in Settings stops it working immediately/);
  });

  it("covers international transfers and the actual storage region", () => {
    render(<PrivacyPolicyPage />);

    const transfers = sectionText(/International Transfers/);
    for (const provider of ["Vercel", "Sentry", "Resend", "Anthropic", "GitHub"]) {
      expect(transfers).toContain(provider);
    }
    expect(transfers).toMatch(/Data Privacy Framework/);
    expect(transfers).toMatch(/Standard Contractual Clauses/);

    const storage = sectionText(/Data Storage and Security/);
    expect(storage).toMatch(/West EU, Ireland/);
    expect(storage).toMatch(/iOS Keychain/);
    expect(storage).toMatch(/macOS app keeps it in app-sandboxed local storage \(AsyncStorage\)/);
    expect(storage).toMatch(/not in the macOS Keychain/);
    expect(storage).not.toMatch(/EU\/US/);
    expect(storage).not.toMatch(/backups/);
  });

  it("states the rights accurately, including the export format and how to correct data", () => {
    render(<PrivacyPolicyPage />);

    const rights = sectionText(/Your Rights/);
    expect(rights).toMatch(/Evernote \(\.enex\) format from the web app/);
    expect(rights).toMatch(/contact support@drafto\.eu to change your email address/);
    expect(rights).not.toMatch(/through account settings/);
    expect(rights).toMatch(/object to processing based on our legitimate interests/);
    // Deletion keeps the data listed under "Data held outside your account".
    expect(rights).toMatch(/Delete your account and the data stored in it/);
    expect(rights).toMatch(/Some data held outside your account is kept/);
    expect(rights).not.toMatch(/all associated data/);
  });

  it("describes trash purging and note history retention", () => {
    render(<PrivacyPolicyPage />);

    const retention = sectionText(/Data Retention/);
    expect(retention).toMatch(/permanently deleted from our servers automatically 30 days later/);
    expect(retention).toMatch(/delete them yourself at any time from the Trash/);
    expect(retention).toMatch(
      /Earlier versions of a note's content are deleted automatically after 30 days/,
    );
    // Mobile sync never pulls server-side deletions, so the local copy outlives the server one.
    expect(retention).toMatch(
      /On iPhone, iPad and Android, a note already synced to the device is not removed/,
    );
    expect(retention).toMatch(/GitHub issues filed from your support emails/);
    expect(retention).toMatch(/notification emails our administrator received/);
    // Only the run logs are pruned (support-agent.sh); the per-issue routing
    // record in logs/support-state.json is kept until removed on request.
    expect(retention).toMatch(/Our support system deletes its run logs after 30 days\. It keeps/);
    expect(retention).toMatch(/subject line and Zoho message reference/);
    expect(retention).toMatch(/until you ask us to remove them/);
  });

  it("describes immediate in-app deletion and links to the deletion page", () => {
    render(<PrivacyPolicyPage />);

    expect(screen.getByText(/Deletion is immediate/)).toBeInTheDocument();
    expect(
      screen.getByText(
        /When you delete your account in the app, we immediately delete your account, notebooks, notes, attachments and API keys/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/by email, we process the request within 30 days/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "how to delete your account" })).toHaveAttribute(
      "href",
      "/account/delete",
    );

    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByRole("link", { name: "Delete your account" })).toHaveAttribute(
      "href",
      "/account/delete",
    );
    expect(within(footer).getByRole("link", { name: "Support" })).toHaveAttribute(
      "href",
      "/support",
    );
  });

  it("has a contents list that links to every numbered section", () => {
    render(<PrivacyPolicyPage />);

    const contents = screen.getByRole("navigation", { name: "On this page" });
    const links = within(contents).getAllByRole("link");
    const sectionHeadings = screen
      .getAllByRole("heading", { level: 2 })
      .filter((heading) => heading.closest("section"));
    expect(links).toHaveLength(12);
    expect(sectionHeadings).toHaveLength(links.length);

    const targets = links.map((link) => (link.getAttribute("href") ?? "").replace(/^#/, ""));
    // Sections render in contents order, so heading N is the Nth section on the page.
    expect(sectionHeadings.map((heading) => heading.closest("section")?.id)).toEqual(targets);
    targets.forEach((id, index) => {
      const section = document.getElementById(id) as HTMLElement;
      expect(section.tagName).toBe("SECTION");
      expect(within(section).getByRole("heading", { level: 2 })).toHaveTextContent(
        `${index + 1}. ${links[index].textContent}`,
      );
    });
  });

  it("links its cross-references to the sections they name", () => {
    render(<PrivacyPolicyPage />);

    expect(screen.getByRole("link", { name: "Section 2" })).toHaveAttribute(
      "href",
      "#data-we-collect",
    );
    expect(screen.getByRole("link", { name: "Section 4" })).toHaveAttribute(
      "href",
      "#data-sharing",
    );
    const rightsLinks = screen.getAllByRole("link", { name: "Your Rights" });
    expect(rightsLinks.map((link) => link.getAttribute("href"))).toEqual([
      "#your-rights",
      "#your-rights",
    ]);
    const retentionLinks = screen.getAllByRole("link", { name: "Data Retention" });
    expect(retentionLinks.map((link) => link.getAttribute("href"))).toEqual([
      "#retention",
      "#retention",
    ]);
  });

  it("labels each sharing-table cell with its column for the stacked phone layout", () => {
    render(<PrivacyPolicyPage />);

    const table = screen.getByRole("table");
    const columns = within(table)
      .getAllByRole("columnheader")
      .map((header) => header.textContent);
    expect(columns).toEqual(["Service", "Purpose", "Data shared"]);
    for (const row of within(table).getAllByRole("row").slice(1)) {
      expect(
        within(row)
          .getAllByRole("cell")
          .map((cell) => cell.dataset.label),
      ).toEqual(columns);
    }
  });

  it("uses support@drafto.eu as the contact address", () => {
    render(<PrivacyPolicyPage />);

    const links = screen.getAllByRole("link", { name: "support@drafto.eu" });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute("href", "mailto:support@drafto.eu");
    }
    expect(document.body.innerHTML).not.toContain("privacy@drafto.eu");
  });
});
