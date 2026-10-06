'use client';

import { useState } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Heading } from '@/atoms/Heading/Heading';
import { Input } from '@/atoms/Input/Input';
import { Label } from '@/atoms/Label/Label';
import { Link } from '@/atoms/Link/Link';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Typography } from '@/atoms/Typography/Typography';
import { useOrderDeliveryEmail } from '@/hooks/useOrderDeliveryEmail/useOrderDeliveryEmail';
import {
  type OrderDigitalLine,
  useOrderDigitalDelivery,
} from '@/hooks/useOrderDigitalDelivery/useOrderDigitalDelivery';
import {
  DELIVERY_EMAIL_MAX_CHARS,
  DIGITAL_ORDER_COPY,
  digitalOrderEmailLine,
  isDigitalOrderEnded,
} from '@/libs/commerce/digital';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';

/**
 * The buyer's "Your purchase" panel on a digital order (digital delivery
 * design §3 "After payment", §3.4, §6 D5–D11, F5–F12). Files download,
 * links and texts reveal on demand; nothing is read until the buyer asks,
 * because each read is logged by the service as an access. Revealed
 * content and the delivery email are masked from session replay.
 */
export function MarketplaceOrderDigitalPanel({
  order,
  onChanged,
}: {
  order: MarketplaceOrder;
  onChanged?: () => Promise<void> | void;
}) {
  const delivery = useOrderDigitalDelivery(order);
  const email = useOrderDeliveryEmail(order, { enabled: true, onChanged });
  if (delivery.lines.length === 0) return null;
  const paid = order.receiptId !== null;
  const ended = isDigitalOrderEnded(order.state);

  return (
    <section
      className="mt-3 grid gap-3 rounded-xl border bg-card/60 p-4"
      aria-label={DIGITAL_ORDER_COPY.heading}
      data-surface="order-digital-panel"
    >
      <Heading level={3} size="sm" className="text-base font-semibold">
        {DIGITAL_ORDER_COPY.heading}
      </Heading>
      {delivery.lines.map((line) => (
        <div key={line.lineIndex} className="grid gap-2" data-testid={`order-digital-line-${line.lineIndex}`}>
          <Typography as="p" className="text-sm font-medium">
            {line.title}
          </Typography>
          {line.kind === 'email' ? (
            <OrderEmailLine order={order} email={email} ended={ended} />
          ) : line.kind === 'message' ? (
            <Typography as="p" className="text-sm text-muted-foreground">
              {['delivered', 'completed'].includes(order.state)
                ? DIGITAL_ORDER_COPY.messageDelivered
                : DIGITAL_ORDER_COPY.messagePending}
            </Typography>
          ) : ended ? (
            <Typography as="p" className="text-sm text-muted-foreground">
              {DIGITAL_ORDER_COPY.ended}
            </Typography>
          ) : !paid ? (
            <Typography as="p" className="text-sm text-muted-foreground">
              {DIGITAL_ORDER_COPY.notPaid}
            </Typography>
          ) : (
            <OrderInstantLine line={line} delivery={delivery} />
          )}
        </div>
      ))}
    </section>
  );
}

function OrderInstantLine({
  line,
  delivery,
}: {
  line: OrderDigitalLine;
  delivery: ReturnType<typeof useOrderDigitalDelivery>;
}) {
  const [copied, setCopied] = useState(false);
  const state = delivery.stateFor(line.lineIndex);
  const reveal = delivery.revealFor(line.lineIndex);
  const opening = state.status === 'opening';

  return (
    <>
      {reveal?.kind === 'text' ? (
        <div className="grid gap-2">
          <pre
            data-sentry-mask
            className="max-h-60 overflow-auto rounded-lg border bg-background p-3 text-sm break-words whitespace-pre-wrap"
            data-testid="order-digital-text"
          >
            {reveal.text}
          </pre>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="rounded-full"
              onClick={() => {
                void navigator.clipboard?.writeText(reveal.text).then(() => setCopied(true));
              }}
            >
              {copied ? DIGITAL_ORDER_COPY.copied : DIGITAL_ORDER_COPY.copy}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="rounded-full"
              onClick={() => {
                setCopied(false);
                delivery.hide(line.lineIndex);
              }}
            >
              {DIGITAL_ORDER_COPY.hide}
            </Button>
          </div>
        </div>
      ) : reveal?.kind === 'link' ? (
        <div className="flex flex-wrap items-center gap-2" data-sentry-mask>
          <Button asChild size="sm" className="rounded-full">
            <Link href={reveal.url} target="_blank" rel="noopener noreferrer" overrideDefaults>
              {DIGITAL_ORDER_COPY.openLink}
              <ExternalLink className="ml-2 size-3.5" />
            </Link>
          </Button>
          <Button size="sm" variant="secondary" className="rounded-full" onClick={() => delivery.hide(line.lineIndex)}>
            {DIGITAL_ORDER_COPY.hide}
          </Button>
        </div>
      ) : (
        <div>
          <Button
            size="sm"
            className="rounded-full"
            disabled={opening}
            onClick={() => void delivery.open(line.lineIndex)}
          >
            {line.kind === 'file' && <Download className="mr-2 size-4" />}
            {line.kind === 'file'
              ? opening
                ? DIGITAL_ORDER_COPY.downloading
                : DIGITAL_ORDER_COPY.download
              : line.kind === 'link'
                ? DIGITAL_ORDER_COPY.showLink
                : DIGITAL_ORDER_COPY.revealText}
          </Button>
        </div>
      )}
      {state.status === 'failed' && state.message && (
        <Typography as="p" role="alert" className="text-sm text-muted-foreground">
          {state.message}
        </Typography>
      )}
    </>
  );
}

function OrderEmailLine({
  order,
  email,
  ended,
}: {
  order: MarketplaceOrder;
  email: ReturnType<typeof useOrderDeliveryEmail>;
  ended: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const { state } = email;
  const changeable = !ended && ['pending_payment', 'paid'].includes(order.state);

  if (state.status === 'idle' || state.status === 'loading') {
    return <Skeleton className="h-5 w-64" aria-label="Loading the delivery email" />;
  }
  if (state.status === 'failed') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Typography as="p" role="alert" className="text-sm text-muted-foreground">
          {state.message}
        </Typography>
        <Button size="sm" variant="secondary" className="rounded-full" onClick={email.retry}>
          Retry
        </Button>
      </div>
    );
  }
  const emailedAt = state.status === 'ready' ? state.email.emailedAt : null;
  const showForm = changeable && emailedAt === null && (editing || state.status === 'missing');

  return (
    <div className="grid gap-2">
      <Typography as="p" className="text-sm text-muted-foreground" data-sentry-mask>
        {state.status === 'missing'
          ? DIGITAL_ORDER_COPY.emailMissing
          : digitalOrderEmailLine(state.email.deliveryEmail, emailedAt)}
      </Typography>
      {changeable && emailedAt === null && state.status === 'ready' && !editing && (
        <div>
          <Button
            size="sm"
            variant="secondary"
            className="rounded-full"
            onClick={() => {
              setValue(state.email.deliveryEmail);
              setEditing(true);
            }}
          >
            {DIGITAL_ORDER_COPY.change}
          </Button>
        </div>
      )}
      {showForm && (
        <form
          className="grid gap-2 sm:max-w-md"
          onSubmit={(event) => {
            event.preventDefault();
            void email.change(value).then((saved) => {
              if (saved) setEditing(false);
            });
          }}
        >
          <Label htmlFor={`delivery-email-${order.id}`}>{DIGITAL_ORDER_COPY.emailLabel}</Label>
          <Input
            id={`delivery-email-${order.id}`}
            value={value}
            maxLength={DELIVERY_EMAIL_MAX_CHARS}
            placeholder="you@example.com"
            onChange={(event) => setValue(event.target.value)}
            data-sentry-mask
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" className="rounded-full" disabled={email.saving}>
              {DIGITAL_ORDER_COPY.save}
            </Button>
            {state.status === 'ready' && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="rounded-full"
                onClick={() => setEditing(false)}
              >
                {DIGITAL_ORDER_COPY.cancel}
              </Button>
            )}
          </div>
        </form>
      )}
      {email.changeMessage && (
        <Typography as="p" role="status" className="text-sm text-muted-foreground">
          {email.changeMessage}
        </Typography>
      )}
    </div>
  );
}
