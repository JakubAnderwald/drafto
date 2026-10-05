# Privacy Policy

**Effective date:** March 8, 2026
**Last updated:** September 14, 2026

Drafto ("we", "our", "us") operates the Drafto apps for iOS, Android and macOS and the drafto.eu website (collectively, the "Service"). This Privacy Policy explains what data we collect, how we use it, and your rights.

## 1. Data We Collect

### Account data

When you create an account, we collect your **email address** and a **hashed password**. We do not store plain-text passwords.

### Notes and content

Your notebooks, notes, and attachments are stored in our database (hosted by Supabase) so they can sync across your devices. Content is associated with your user account.

### Device and usage data

When you use the web app at drafto.eu, we collect anonymous usage analytics (page views, feature usage) through PostHog to improve the Service, and crash reports and error data through Sentry to fix bugs. This data does not include note content.

The iOS, Android and macOS apps contain no analytics or crash-reporting SDK. They send no usage analytics or crash reports to Drafto. If our drafto.eu servers fail to handle a request from one of the apps (for example, an account deletion), the server may record that error in Sentry.

### Offline data

The iOS, Android and macOS apps store a local copy of your notes on your device using SQLite (via WatermelonDB) for offline access. This data stays on your device and syncs with our servers when you are online.

## 2. How We Use Your Data

- **Provide the Service:** Store and sync your notes across devices
- **Improve the Service:** Analyze anonymous usage patterns in the web app to improve features
- **Fix issues:** Use crash reports to identify and resolve bugs
- **Communicate:** Send essential account-related emails (password reset, approval status)

We do **not** sell your data. We do **not** use your note content for advertising, training AI models, or any purpose other than providing the Service to you.

## 3. Data Sharing

We use the following third-party services to operate Drafto:

| Service    | Purpose                                             | Data shared                  |
| ---------- | --------------------------------------------------- | ---------------------------- |
| Supabase   | Database, auth, storage                             | Account data, notes, files   |
| PostHog    | Usage analytics (web app only)                      | Anonymous usage events       |
| Sentry     | Error tracking (web app and drafto.eu servers only) | Crash reports, error context |
| Vercel     | Web hosting                                         | Web request logs             |
| Expo (EAS) | Mobile app builds & OTA                             | Build metadata               |

We do not share your data with any other third parties.

## 4. Data Storage and Security

- Data is stored in Supabase (cloud infrastructure in the EU/US)
- All data is transmitted over HTTPS/TLS
- Authentication tokens are stored securely on your device (iOS Keychain / Android Keystore via expo-secure-store)
- Row Level Security (RLS) ensures you can only access your own data
- We maintain regular database backups

## 5. Your Rights

You have the right to:

- **Access** your data at any time through the Service
- **Export** your notes through the web app
- **Delete** your account and all associated data at any time from within the app on the web, iOS, Android or macOS. Deletion is immediate. See [how to delete your account](https://drafto.eu/account/delete)
- **Correct** your information through account settings

For EU residents (GDPR): You additionally have the right to data portability and the right to lodge a complaint with a supervisory authority.

## 6. Data Retention

- Your data is retained as long as your account is active
- Trashed notes are permanently deletable by you at any time
- When you delete your account in the app, we immediately delete your account, notebooks, notes, attachments and API keys
- If you ask us to delete your account by email, we process the request within 30 days
- Anonymous analytics data may be retained indefinitely in aggregate form

## 7. Children's Privacy

Drafto is not intended for children under 13. We do not knowingly collect data from children under 13. If you believe a child has provided us data, contact us and we will delete it.

## 8. Changes to This Policy

We may update this Privacy Policy from time to time. We will notify you of material changes by posting the updated policy on this page and updating the "Last updated" date.

## 9. Contact

If you have questions about this Privacy Policy or want to exercise your rights, contact us at:

**Email:** support@drafto.eu
**Website:** https://drafto.eu
