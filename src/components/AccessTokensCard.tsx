/**
 * Personal access tokens — Settings → Account (web build only).
 *
 * Lists the signed-in user's active tokens, mints new ones (the plaintext
 * is shown exactly once, with the `astra-cli login` line to paste it
 * into), and revokes. Backed by /api/me/tokens, which refuses PAT callers
 * — so this card only works from a browser session, by design.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createAccessToken,
  listAccessTokens,
  revokeAccessToken,
  type AccessToken,
  type MintedAccessToken,
} from "@/lib/auth-web";

function formatWhen(iso: string | null): string {
  if (!iso) return "never";
  // The daemon serializes NaiveDateTime without a zone; it is UTC.
  const date = new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Clipboard unavailable — select and copy the text instead.");
    }
  };
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void copy()}
      aria-label="Copy"
    >
      {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
    </Button>
  );
}

export default function AccessTokensCard() {
  const [tokens, setTokens] = useState<AccessToken[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [minted, setMinted] = useState<MintedAccessToken | null>(null);
  const [revoking, setRevoking] = useState<AccessToken | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

  const reload = useCallback(async () => {
    try {
      setTokens(await listAccessTokens());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setIsCreating(true);
    try {
      const result = await createAccessToken(name);
      setMinted(result);
      setNewName("");
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create token");
    } finally {
      setIsCreating(false);
    }
  };

  const revoke = async () => {
    if (!revoking) return;
    setIsRevoking(true);
    try {
      await revokeAccessToken(revoking.id);
      toast.success(`Revoked "${revoking.name}"`);
      setRevoking(null);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not revoke token");
    } finally {
      setIsRevoking(false);
    }
  };

  const loginLine = minted
    ? `astra-cli login --server ${window.location.origin} --token ${minted.token}`
    : "";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="font-serif text-xl font-light tracking-wide text-slate-100 flex items-center gap-2">
              <KeyRound className="w-5 h-5" />
              Personal access tokens
            </CardTitle>
            <CardDescription>
              Bearer tokens for <code>astra-cli</code> and the desktop app's
              gallery push. Each is shown once when created; revoke any you no
              longer use.
            </CardDescription>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setMinted(null);
              setCreateOpen(true);
            }}
          >
            <Plus className="w-4 h-4 mr-1" />
            New token
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loadError ? (
          <p className="text-sm text-destructive">{loadError}</p>
        ) : tokens === null ? (
          <p className="text-sm text-muted-foreground">Loading tokens…</p>
        ) : tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No tokens yet. Create one to sign in from the command line.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-4 font-normal">Name</th>
                <th className="py-1 pr-4 font-normal">Created</th>
                <th className="py-1 pr-4 font-normal">Last used</th>
                <th className="py-1 w-10" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id} className="border-t border-border/50">
                  <td className="py-2 pr-4">{t.name}</td>
                  <td className="py-2 pr-4 text-muted-foreground">
                    {formatWhen(t.createdAt)}
                  </td>
                  <td className="py-2 pr-4 text-muted-foreground">
                    {formatWhen(t.lastUsedAt)}
                  </td>
                  <td className="py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Revoke ${t.name}`}
                      onClick={() => setRevoking(t)}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>

      {/* Create: name → one-time reveal */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open) {
            setCreateOpen(false);
            setMinted(null);
          }
        }}
      >
        <DialogContent>
          {minted ? (
            <>
              <DialogHeader>
                <DialogTitle>Token "{minted.name}" created</DialogTitle>
                <DialogDescription>
                  Copy it now — it will not be shown again. Anyone holding it
                  can act as you until it is revoked.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={minted.token}
                    className="font-mono text-xs"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <CopyButton text={minted.token} />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">
                    Sign in from the command line
                  </Label>
                  <div className="flex items-center gap-2 mt-1">
                    <Input
                      readOnly
                      value={loginLine}
                      className="font-mono text-xs"
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <CopyButton text={loginLine} />
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => {
                    setCreateOpen(false);
                    setMinted(null);
                  }}
                >
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>New personal access token</DialogTitle>
                <DialogDescription>
                  Name it after where it will live, so you know what to revoke
                  later.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="token-name">Name</Label>
                <Input
                  id="token-name"
                  placeholder="observatory laptop"
                  value={newName}
                  maxLength={100}
                  autoFocus
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void create();
                  }}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => void create()}
                  disabled={isCreating || !newName.trim()}
                >
                  {isCreating ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : null}
                  Create
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Revoke confirmation */}
      <Dialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke "{revoking?.name}"?</DialogTitle>
            <DialogDescription>
              Anything signed in with this token (a CLI watch, the desktop push)
              stops working immediately. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void revoke()}
              disabled={isRevoking}
            >
              {isRevoking ? (
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              ) : null}
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
