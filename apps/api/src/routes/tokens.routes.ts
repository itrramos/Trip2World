import { RATE_LIMITS } from '@trip2world/shared';
import {
  buyTokensSchema,
  parseInput,
  tokenHistoryQuerySchema,
} from '@trip2world/validation';
import type { FastifyInstance } from 'fastify';
// Type-only, so the Stripe SDK is still loaded lazily at the call site — a deployment
// that does not sell tokens never pulls it into the runtime bundle.
import type { Stripe } from 'stripe';
import type { z } from 'zod';
import { AppError, Errors } from '../errors.js';
import { TokensService } from '../services/tokens.service.js';

/**
 * Token purchase and history.
 *
 * Tipping itself is NOT here — it happens over the realtime socket, because both peers
 * need to see it during a call. This surface covers buying tokens and reviewing what
 * happened to them.
 */
export async function tokenRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, config } = app;
  const tokens = new TokensService(prisma, app.log);

  function parse<S extends z.ZodTypeAny>(schema: S, input: unknown, requestId: string): z.infer<S> {
    const result = parseInput(schema, input, requestId);
    if (!result.success) {
      throw new AppError(result.error.code, result.error.message, { details: result.error.details });
    }
    return result.data;
  }

  /* ------------------------------------------------------------------ */
  /* Balance and catalogue                                               */
  /* ------------------------------------------------------------------ */

  app.get('/balance', { onRequest: [app.authenticate] }, async (request, reply) =>
    reply.send({ ok: true, data: await tokens.getBalance(request.user!.id) }),
  );

  /**
   * The purchasable packages.
   *
   * Also reports whether purchasing is actually possible. With no Stripe key configured
   * the catalogue still renders — the UI shows it as unavailable rather than offering a
   * buy button that leads nowhere.
   */
  app.get('/packages', { onRequest: [app.authenticate] }, async (_request, reply) =>
    reply.send({
      ok: true,
      data: {
        packages: await tokens.listPackages(),
        purchasingEnabled: config.stripeConfigured,
      },
    }),
  );

  app.get('/history', { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = parse(tokenHistoryQuerySchema, request.query, request.id);
    return reply.send({
      ok: true,
      data: await tokens.history(request.user!.id, query.page, query.pageSize),
    });
  });

  /* ------------------------------------------------------------------ */
  /* Checkout                                                            */
  /* ------------------------------------------------------------------ */

  app.post(
    '/checkout',
    { onRequest: [app.authenticate, app.rateLimit('token-checkout', RATE_LIMITS.apiWrite)] },
    async (request, reply) => {
      if (!config.stripeConfigured) {
        throw Errors.featureDisabled('Buying tokens');
      }

      const input = parse(buyTokensSchema, request.body, request.id);
      const user = request.user!;

      const packages = await tokens.listPackages();
      const chosen = packages.find((p) => p.id === input.packageId);
      if (!chosen) throw Errors.notFound('That package');

      // Imported lazily so the whole Stripe SDK is only loaded on a deployment that
      // actually sells tokens.
      const { default: Stripe } = await import('stripe');
      const stripe = new Stripe(config.STRIPE_SECRET_KEY);

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        // The user id travels in metadata, not in the success URL, so it cannot be
        // tampered with by the browser on the way back.
        client_reference_id: user.id,
        metadata: { userId: user.id, packageId: chosen.id },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: chosen.currency.toLowerCase(),
              unit_amount: chosen.priceCents,
              product_data: {
                name: `${chosen.tokens.toLocaleString()} Trip2World tokens`,
                description: 'Tokens are non-refundable once spent.',
              },
            },
          },
        ],
        success_url: `${config.APP_URL}/settings/tokens?purchase=success`,
        cancel_url: `${config.APP_URL}/settings/tokens?purchase=cancelled`,
      });

      // Recorded as PENDING now; the webhook is what credits it. Never credit from the
      // success redirect — the browser can be sent there without paying.
      await tokens.createPurchase(user.id, chosen.id, session.id);

      return reply.send({ ok: true, data: { checkoutUrl: session.url } });
    },
  );

  /* ------------------------------------------------------------------ */
  /* Webhook                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Stripe payment notifications.
   *
   * Unauthenticated by necessity — Stripe has no session — so the signature IS the
   * authentication. Without verification anyone could POST a fabricated
   * `checkout.session.completed` and mint themselves tokens, which makes this the single
   * most sensitive endpoint in the application.
   *
   * Verification needs the byte-exact body, so this route opts out of JSON parsing. A
   * re-serialised body produces a different signature and every legitimate event would be
   * rejected.
   */
  app.post(
    '/webhook',
    {
      config: { rawBody: true },
      // Fastify parses application/json globally; override it here to keep the buffer.
      onRequest: [],
    },
    async (request, reply) => {
      if (!config.stripeConfigured || !config.STRIPE_WEBHOOK_SECRET) {
        throw Errors.featureDisabled('Billing');
      }

      const signature = request.headers['stripe-signature'];
      if (typeof signature !== 'string') {
        throw Errors.unauthenticated({ reason: 'NO_STRIPE_SIGNATURE' });
      }

      const raw = (request as unknown as { rawBody?: Buffer }).rawBody;
      if (!raw) {
        request.log.error('Stripe webhook received without a raw body');
        throw Errors.internal({ reason: 'NO_RAW_BODY' });
      }

      const { default: Stripe } = await import('stripe');
      const stripe = new Stripe(config.STRIPE_SECRET_KEY);

      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(raw, signature, config.STRIPE_WEBHOOK_SECRET);
      } catch (error) {
        // A bad signature is either a misconfiguration or an attack. Both are worth
        // seeing, and neither should be told why it failed.
        request.log.warn({ err: error }, 'Rejected Stripe webhook with an invalid signature');
        throw Errors.unauthenticated({ reason: 'BAD_STRIPE_SIGNATURE' });
      }

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        // `payment_status` is the authoritative field. A completed session can still be
        // unpaid for delayed payment methods.
        if (session.payment_status === 'paid') {
          await tokens.fulfilPurchase(session.id, event.id);
        }
      }

      // Always 200 for a validly signed event, even one we ignore. A non-2xx makes
      // Stripe retry indefinitely for event types we will never care about.
      return reply.send({ received: true });
    },
  );
}
