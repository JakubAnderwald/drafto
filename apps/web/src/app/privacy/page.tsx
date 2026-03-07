import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — Drafto",
  description: "Drafto privacy policy. Learn how we handle your data.",
};

export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="mb-2 text-3xl font-bold text-stone-900 dark:text-stone-100">Privacy Policy</h1>
      <p className="mb-8 text-sm text-stone-500 dark:text-stone-400">
        Effective date: March 8, 2026 &middot; Last updated: March 8, 2026
      </p>

      <div className="prose prose-stone dark:prose-invert max-w-none">
        <p>
          Drafto (&ldquo;we&rdquo;, &ldquo;our&rdquo;, &ldquo;us&rdquo;) operates the Drafto mobile
          application and the drafto.eu website (collectively, the &ldquo;Service&rdquo;). This
          Privacy Policy explains what data we collect, how we use it, and your rights.
        </p>

        <h2>1. Data We Collect</h2>

        <h3>Account data</h3>
        <p>
          When you create an account, we collect your <strong>email address</strong> and a{" "}
          <strong>hashed password</strong>. We do not store plain-text passwords.
        </p>

        <h3>Notes and content</h3>
        <p>
          Your notebooks, notes, and attachments are stored in our database (hosted by Supabase) so
          they can sync across your devices. Content is associated with your user account.
        </p>

        <h3>Device and usage data</h3>
        <p>
          We collect anonymous usage analytics (page views, feature usage) through PostHog to
          improve the Service. We collect crash reports and error data through Sentry to fix bugs.
          This data does not include note content.
        </p>

        <h3>Offline data</h3>
        <p>
          The mobile app stores a local copy of your notes on your device using SQLite for offline
          access. This data stays on your device and syncs with our servers when you are online.
        </p>

        <h2>2. How We Use Your Data</h2>
        <ul>
          <li>
            <strong>Provide the Service:</strong> Store and sync your notes across devices
          </li>
          <li>
            <strong>Improve the Service:</strong> Analyze anonymous usage patterns to improve
            features
          </li>
          <li>
            <strong>Fix issues:</strong> Use crash reports to identify and resolve bugs
          </li>
          <li>
            <strong>Communicate:</strong> Send essential account-related emails (password reset,
            approval status)
          </li>
        </ul>
        <p>
          We do <strong>not</strong> sell your data. We do <strong>not</strong> use your note
          content for advertising, training AI models, or any purpose other than providing the
          Service to you.
        </p>

        <h2>3. Data Sharing</h2>
        <p>We use the following third-party services to operate Drafto:</p>
        <table>
          <thead>
            <tr>
              <th>Service</th>
              <th>Purpose</th>
              <th>Data shared</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Supabase</td>
              <td>Database, auth, storage</td>
              <td>Account data, notes, files</td>
            </tr>
            <tr>
              <td>PostHog</td>
              <td>Usage analytics</td>
              <td>Anonymous usage events</td>
            </tr>
            <tr>
              <td>Sentry</td>
              <td>Error tracking</td>
              <td>Crash reports, error context</td>
            </tr>
            <tr>
              <td>Vercel</td>
              <td>Web hosting</td>
              <td>Web request logs</td>
            </tr>
            <tr>
              <td>Expo (EAS)</td>
              <td>Mobile app builds &amp; OTA</td>
              <td>Build metadata</td>
            </tr>
          </tbody>
        </table>
        <p>We do not share your data with any other third parties.</p>

        <h2>4. Data Storage and Security</h2>
        <ul>
          <li>Data is stored in Supabase (cloud infrastructure in the EU/US)</li>
          <li>All data is transmitted over HTTPS/TLS</li>
          <li>
            Authentication tokens are stored securely on your device (iOS Keychain / Android
            Keystore)
          </li>
          <li>Row Level Security (RLS) ensures you can only access your own data</li>
          <li>We maintain regular database backups</li>
        </ul>

        <h2>5. Your Rights</h2>
        <p>You have the right to:</p>
        <ul>
          <li>
            <strong>Access</strong> your data at any time through the Service
          </li>
          <li>
            <strong>Export</strong> your notes through the web app
          </li>
          <li>
            <strong>Delete</strong> your account and all associated data by contacting us
          </li>
          <li>
            <strong>Correct</strong> your information through account settings
          </li>
        </ul>
        <p>
          For EU residents (GDPR): You additionally have the right to data portability and the right
          to lodge a complaint with a supervisory authority.
        </p>

        <h2>6. Data Retention</h2>
        <ul>
          <li>Your data is retained as long as your account is active</li>
          <li>Trashed notes are permanently deletable by you at any time</li>
          <li>If you delete your account, we remove all associated data within 30 days</li>
          <li>Anonymous analytics data may be retained indefinitely in aggregate form</li>
        </ul>

        <h2>7. Children&apos;s Privacy</h2>
        <p>
          Drafto is not intended for children under 13. We do not knowingly collect data from
          children under 13. If you believe a child has provided us data, contact us and we will
          delete it.
        </p>

        <h2>8. Changes to This Policy</h2>
        <p>
          We may update this Privacy Policy from time to time. We will notify you of material
          changes by posting the updated policy on this page and updating the &ldquo;Last
          updated&rdquo; date.
        </p>

        <h2>9. Contact</h2>
        <p>
          If you have questions about this Privacy Policy or want to exercise your rights, contact
          us at:
        </p>
        <p>
          <strong>Email:</strong> <a href="mailto:privacy@drafto.eu">privacy@drafto.eu</a>
          <br />
          <strong>Website:</strong> <a href="https://drafto.eu">https://drafto.eu</a>
        </p>
      </div>
    </main>
  );
}
