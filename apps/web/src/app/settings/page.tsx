"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardBody } from "@/components/ui/card";

interface ApiKey {
  id: string;
  key_prefix: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export default function SettingsPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasFetched = useRef(false);

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
    fetchKeys();
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
      const data = await res.json();
      setRevealedKey(data.key);
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
                {revealedKey}
              </code>
              <Button
                size="sm"
                variant="secondary"
                className="mt-2"
                onClick={() => {
                  navigator.clipboard.writeText(revealedKey);
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
                    url: `${typeof window !== "undefined" ? window.location.origin : "https://drafto.eu"}/api/mcp`,
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
    </div>
  );
}
