import { Card, CardBody } from "@/components/ui/card";

export interface LandingFeature {
  title: string;
  description: string;
}

// Keep each claim true on the platforms it names; docs/features/ describes what ships where.
export const LANDING_FEATURES: readonly LandingFeature[] = [
  {
    title: "Notebooks",
    description:
      "Keep notes in notebooks, move them between notebooks, and restore deleted notes from the trash for 30 days.",
  },
  {
    title: "Rich-text editor",
    description: "Headings, lists, links, images and file attachments, saved as you type.",
  },
  {
    title: "Everywhere, even offline",
    description:
      "Your notes stay in sync across the web, iPhone, iPad, Android and Mac. The iPhone, iPad, Android and Mac apps keep working without a connection and catch up when you're back online.",
  },
  {
    title: "Search",
    description: "Find any note across all your notebooks by its title, its text or its notebook.",
  },
  {
    title: "Bring your notes",
    description:
      "Import Evernote exports with their attachments, and export notebooks back to Evernote's format.",
  },
  {
    title: "Works with Claude",
    description: "Connect Claude or another MCP client to list, read, search and write your notes.",
  },
];

export function FeatureList({
  features = LANDING_FEATURES,
}: {
  features?: readonly LandingFeature[];
}) {
  return (
    <section aria-labelledby="landing-features" className="mt-20">
      <h2 id="landing-features" className="text-fg text-center text-2xl font-semibold">
        What Drafto does
      </h2>
      <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((feature) => (
          <li key={feature.title}>
            <Card className="h-full">
              <CardBody className="p-6">
                <h3 className="text-fg font-semibold">{feature.title}</h3>
                <p className="text-fg-muted mt-2 text-sm leading-6">{feature.description}</p>
              </CardBody>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
