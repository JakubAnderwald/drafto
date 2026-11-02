"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardBody } from "@/components/ui/card";
import { DeleteAccountSection } from "@/components/settings/delete-account-section";
import { usePageOrigin } from "@/hooks/use-page-origin";

interface ApiKey {
  id: string;
  key_prefix: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

// A just-generated key, shown once. The id ties the box to the key's row, so revoking that row
// can clear it.
interface RevealedKey {
  id: string;
  key: string;
}

interface SettingsContentProps {
  // Short commit SHA of the running build, read on the server by `settings/page.tsx`. The build
  // line is left out when it's unknown (e.g. locally).
  buildCommit?: string | null;
}

export function SettingsContent({ buildCommit }: Readonly<SettingsContentProps>) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [revealedKey, setRevealedKey] = useState<RevealedKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasFetched = useRef(false);
  const origin = usePageOrigin();

  async function fetchKeys() {
    const res = await fetch("/api/api-keys");
    if (res.ok) {
      const data = await res.json();
      setKeys(data);
    }
    setLoading(false);
  }

  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;
    void fetchKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    setRevealedKey(null);

    const res = await fetch("/api/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newKeyName }),
    });

    if (res.ok) {
      const data = (await res.json()) as RevealedKey;
      setRevealedKey({ id: data.id, key: data.key });
      setNewKeyName("");
      await fetchKeys();
    } else {
      const data = await res.json();
      setError(data.error ?? "Failed to create key");
    }
    setCreating(false);
  };

  const handleRevoke = async (id: string) => {
    const res = await fetch(`/api/api-keys/${id}`, { method: "DELETE" });
    if (res.ok) {
      // A revoked key no longer works, so stop offering its value for copying. The functional
      // update compares against the latest box, in case a new key was generated meanwhile.
      setRevealedKey((current) => (current?.id === id ? null : current));
      await fetchKeys();
    }
  };

  const activeKeys = keys.filter((k) => !k.revoked_at);

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="text-fg mb-2 text-2xl font-bold">Settings</h1>
      <p className="text-fg-muted mb-8 text-sm">
        Manage API keys for MCP integrations like Claude Cowork.
      </p>

      <Card>
        <CardHeader>
          <h2 className="text-fg text-lg font-semibold">API Keys</h2>
          <p className="text-fg-muted text-sm">
            Generate keys to connect Drafto with Claude Desktop, Claude Cowork, or other MCP
            clients.
          </p>
        </CardHeader>
        <CardBody>
          {/* Create new key */}
          <div className="mb-6 flex gap-2">
            <Input
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="Key name (e.g. Claude Desktop)"
              inputSize="sm"
              className="flex-1"
            />
            <Button size="sm" onClick={handleCreate} loading={creating} disabled={creating}>
              Generate key
            </Button>
          </div>

          {/* Revealed key (shown once) */}
          {revealedKey && (
            <div className="bg-success-bg border-success mb-6 rounded-md border p-4">
              <p className="text-fg mb-1 text-sm font-medium">
                Your new API key (copy it now — it will not be shown again):
              </p>
              <code className="text-fg bg-bg-muted block rounded px-2 py-1 font-mono text-sm break-all">
                {revealedKey.key}
              </code>
              <Button
                size="sm"
                variant="secondary"
                className="mt-2"
                onClick={() => {
                  void navigator.clipboard.writeText(revealedKey.key);
                }}
              >
                Copy to clipboard
              </Button>
            </div>
          )}

          {error && (
            <div className="bg-error-bg text-error mb-4 rounded-md p-3 text-sm">{error}</div>
          )}

          {/* Key list */}
          {loading ? (
            <p className="text-fg-muted text-sm">Loading...</p>
          ) : activeKeys.length === 0 ? (
            <p className="text-fg-muted text-sm">No API keys yet. Generate one to get started.</p>
          ) : (
            <ul className="divide-border divide-y">
              {activeKeys.map((key) => (
                <li key={key.id} className="flex items-center justify-between py-3">
                  <div>
                    <p className="text-fg text-sm font-medium">{key.name}</p>
                    <p className="text-fg-subtle text-xs">
                      <code>{key.key_prefix}...</code>
                      {" · "}
                      Created {new Date(key.created_at).toLocaleDateString()}
                      {key.last_used_at && (
                        <>
                          {" · "}
                          Last used {new Date(key.last_used_at).toLocaleDateString()}
                        </>
                      )}
                    </p>
                  </div>
                  <Button size="sm" variant="danger" onClick={() => handleRevoke(key.id)}>
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* MCP connection info */}
      <Card className="mt-6">
        <CardHeader>
          <h2 className="text-fg text-lg font-semibold">Connect to Claude</h2>
        </CardHeader>
        <CardBody>
          <p className="text-fg-muted mb-3 text-sm">
            Add this remote MCP server to Claude Desktop or Claude Cowork:
          </p>
          <code className="text-fg bg-bg-muted block overflow-x-auto rounded-md p-3 font-mono text-sm">
            {JSON.stringify(
              {
                mcpServers: {
                  drafto: {
                    url: `${origin}/api/mcp`,
                    headers: {
                      Authorization: "Bearer YOUR_API_KEY",
                    },
                  },
                },
              },
              null,
              2,
            )}
          </code>
        </CardBody>
      </Card>

      <DeleteAccountSection className="mt-6" />

      {/* Which deployment is running, so a preview tester can match it to the commit under test */}
      {buildCommit && (
        <p data-testid="build-commit" className="text-fg-muted mt-6 font-mono text-xs">
          Build {buildCommit}
        </p>
      )}
    </div>
  );
}
