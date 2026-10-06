'use client';

import { useState } from 'react';
import { ArrowLeft, KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import {
  type InventorySessionKind,
  WEBHOOK_DELIVERY_COPY,
  WEBHOOK_URL_COPY,
} from '@/application/commerce/inventory-automations';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Input } from '@/atoms/Input/Input';
import { Link } from '@/atoms/Link/Link';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Typography } from '@/atoms/Typography/Typography';
import { useMarketplaceInventoryAutomations } from '@/hooks/useMarketplaceInventoryAutomations/useMarketplaceInventoryAutomations';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { MarketplaceInventoryGrantBanner } from '@/organisms/Marketplace/MarketplaceInventoryGrantBanner';
import { MarketplaceInventoryOnceSecretDialog } from '@/organisms/Marketplace/MarketplaceInventoryOnceSecretDialog';
import { MarketplaceInventoryRevokeDialog } from '@/organisms/Marketplace/MarketplaceInventoryRevokeDialog';
import { MarketplaceSectionNav } from '@/organisms/Marketplace/MarketplaceSectionNav';
import { MarketplaceSessionRequiredCard } from '@/organisms/Marketplace/MarketplaceSessionRequiredCard';

export function MarketplaceInventoryAutomations() {
  const board = useMarketplaceInventoryAutomations();
  const [url, setUrl] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; kind: InventorySessionKind } | null>(null);
  const sessions = board.load.status === 'ready' ? board.load.sessions : [];
  const webhooks = board.load.status === 'ready' || board.load.status === 'empty' ? board.load.webhooks : [];

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      className="pb-28 lg:pb-16"
      classNameWrapperContent="max-w-7xl"
    >
      <Container overrideDefaults className="flex w-full flex-col gap-6 px-4 sm:px-6 lg:px-8">
        <MarketplaceSectionNav />
        <Link
          href={MARKETPLACE_ROUTES.INVENTORY}
          overrideDefaults
          className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Inventory
        </Link>
        <div>
          <Badge className="mb-4">Seller studio · Automations</Badge>
          <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
            Automations
          </Heading>
          <Typography as="p" className="mt-3 max-w-2xl text-muted-foreground">
            Sessions and webhook endpoints for this shop. Secrets are shown once.
          </Typography>
        </div>

        <div data-surface="inventory-studio" data-testid="inventory-studio">
          {board.isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : board.load.status === 'durable-unavailable' ? (
            <Card className="border-dashed py-5">
              <CardContent className="px-5">
                <Typography as="p" className="font-semibold">
                  Inventory Studio requires the durable transaction service.
                </Typography>
              </CardContent>
            </Card>
          ) : board.load.status === 'unauthenticated' ? (
            <Card className="border-dashed py-5">
              <CardContent className="px-5">
                <Typography as="p" className="text-sm text-muted-foreground">
                  Sign in to manage automations.
                </Typography>
              </CardContent>
            </Card>
          ) : board.load.status === 'session-required' ? (
            <MarketplaceSessionRequiredCard onConnected={() => void board.refresh()} />
          ) : board.load.status === 'grant-needed' ? (
            <MarketplaceInventoryGrantBanner onConnected={() => void board.refresh()} />
          ) : board.load.status === 'error' ? (
            <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-6">
              <Heading level={3} size="md">
                Automations could not be loaded
              </Heading>
              <Typography as="p" className="mt-2 text-muted-foreground">
                {board.load.message}
              </Typography>
            </div>
          ) : (
            <div className="flex flex-col gap-8">
              {board.message && (
                <Typography as="p" role="status" className="text-sm text-muted-foreground">
                  {board.message}
                </Typography>
              )}

              <section>
                <Heading level={2} size="md" className="mb-3">
                  Sessions
                </Heading>
                {sessions.length === 0 ? (
                  <Card className="border-dashed py-5">
                    <CardContent className="px-5">
                      <Typography as="p" className="text-sm text-muted-foreground">
                        No sessions are listed yet.
                      </Typography>
                    </CardContent>
                  </Card>
                ) : (
                  <Card className="border">
                    <CardContent className="overflow-x-auto px-5">
                      <table className="w-full min-w-[48rem] text-left text-sm">
                        <thead>
                          <tr className="border-b border-border text-muted-foreground">
                            <th className="p-3 font-medium">Kind</th>
                            <th className="p-3 font-medium">Label</th>
                            <th className="p-3 font-medium">Issued</th>
                            <th className="p-3 font-medium">Expires</th>
                            <th className="p-3 font-medium">Last used</th>
                            <th className="p-3 font-medium">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sessions.map((session) => (
                            <tr key={session.id} className="border-b border-border last:border-0">
                              <td className="p-3">{session.kindLabel}</td>
                              <td className="p-3">{session.label}</td>
                              <td className="p-3">{session.createdAt || '—'}</td>
                              <td className="p-3">{session.expiresAt || '—'}</td>
                              <td className="p-3">{session.lastUsedAt ?? '—'}</td>
                              <td className="p-3">
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  className="rounded-full"
                                  disabled={board.pendingId === session.id}
                                  onClick={() => setRevokeTarget({ id: session.id, kind: session.kind })}
                                >
                                  <KeyRound className="mr-2 size-4" />
                                  Revoke
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </CardContent>
                  </Card>
                )}
              </section>

              <section>
                <Heading level={2} size="md" className="mb-3">
                  Webhooks
                </Heading>
                <Typography as="p" className="mb-4 text-sm text-muted-foreground">
                  {WEBHOOK_DELIVERY_COPY}
                </Typography>
                <form
                  className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void board.addWebhook(url.trim());
                  }}
                >
                  <div className="flex-1">
                    <Input
                      type="url"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      aria-label="Webhook URL"
                      placeholder="https://"
                    />
                    <Typography as="p" className="mt-1 text-xs text-muted-foreground">
                      {WEBHOOK_URL_COPY}
                    </Typography>
                  </div>
                  <Button type="submit" className="rounded-full" disabled={board.pendingId === 'add-webhook'}>
                    <Plus className="mr-2 size-4" />
                    Add webhook
                  </Button>
                </form>
                {webhooks.length === 0 ? (
                  <Card className="border-dashed py-5">
                    <CardContent className="px-5">
                      <Typography as="p" className="text-sm text-muted-foreground">
                        No webhook endpoints saved on this device.
                      </Typography>
                    </CardContent>
                  </Card>
                ) : (
                  <Card className="border">
                    <CardContent className="overflow-x-auto px-5">
                      <table className="w-full min-w-[36rem] text-left text-sm">
                        <thead>
                          <tr className="border-b border-border text-muted-foreground">
                            <th className="p-3 font-medium">URL</th>
                            <th className="p-3 font-medium">Added</th>
                            <th className="p-3 font-medium">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {webhooks.map((webhook) => (
                            <tr key={webhook.id} className="border-b border-border last:border-0">
                              <td className="p-3 font-mono text-xs">{webhook.url}</td>
                              <td className="p-3">{new Date(webhook.createdAt).toISOString()}</td>
                              <td className="p-3">
                                <div className="flex flex-wrap gap-2">
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    className="rounded-full"
                                    disabled={board.pendingId === webhook.id}
                                    onClick={() => void board.rotateWebhook(webhook.id)}
                                  >
                                    <RefreshCw className="mr-2 size-4" />
                                    Rotate
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="rounded-full"
                                    disabled={board.pendingId === webhook.id}
                                    onClick={() => void board.deleteWebhook(webhook.id)}
                                  >
                                    <Trash2 className="mr-2 size-4" />
                                    Delete
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </CardContent>
                  </Card>
                )}
              </section>
            </div>
          )}
        </div>
      </Container>

      <MarketplaceInventoryOnceSecretDialog
        open={board.secret !== null}
        secret={board.secret?.secret ?? ''}
        message={board.secret?.message}
        onClose={board.dismissSecret}
      />
      <MarketplaceInventoryRevokeDialog
        open={revokeTarget !== null}
        pending={revokeTarget !== null && board.pendingId === revokeTarget.id}
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => {
          if (!revokeTarget) return;
          const target = revokeTarget;
          setRevokeTarget(null);
          void board.revoke(target.id, target.kind);
        }}
      />
    </ContentLayout>
  );
}
